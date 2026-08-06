import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createYaacTestEnv, runYaac, type YaacTestEnv } from '@yaac/test-utils/cli'
import { IS_NESTED_YAAC } from '@yaac/test-utils/setup'

/**
 * Merged e2e coverage for the `yaac cluster` command family: `check` (no
 * options), `setup` (and its `--repair` / `--nodes` options), and `delete`
 * (and its `-y/--yes` option). All three are host-side commands — they talk to
 * kubectl/podman/kind/the registry directly, never to the server — so no
 * server is spawned anywhere in this file and every case runs without a
 * cluster: we sabotage the environment (PATH stripping, bogus KUBECONFIG,
 * nested flag) and assert the diagnostic output + exit code.
 *
 * The happy paths are excluded by design: `check`'s all-green run needs a
 * fully wired kind cluster, and `setup`/`delete`'s full runs are
 * destructive (they recreate or delete the host's kind cluster and
 * registry) — all are exercised manually per the README. The guard-rail
 * cases below all stop BEFORE any mutating step.
 *
 * `setup --adopt-cni` is the one mode that is NOT destructive, but a real
 * run of it needs a second cluster whose CNI yaac did not install, which no
 * e2e worker can stand up beside the one it is running in. What is covered
 * here is its whole option surface plus its refusal gate — which is the
 * part that matters, since an unverified adoption fails silently. The
 * gate's per-refusal reasoning is unit-tested against staged cluster reads
 * in packages/server/test/features/cluster/cluster-setup.test.ts.
 *
 * One test env is shared for the whole file: these tests never write into
 * the data dir (every path fails preflight), and each test that needs a
 * tweaked environment overrides it per-call via the runYaac env argument,
 * exactly as the per-test originals did.
 */

function onPath(bin: string): boolean {
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .some((dir) => dir && existsSync(path.join(dir, bin)))
}

/** Strip every PATH entry containing any of the given binaries. */
function stripFromPath(...bins: string[]): string {
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((dir) => dir && !bins.some((bin) => existsSync(path.join(dir, bin))))
    .join(path.delimiter)
}

let testEnv: YaacTestEnv

beforeAll(async () => {
  testEnv = await createYaacTestEnv()
})

afterAll(async () => {
  await testEnv.cleanup()
})

describe('yaac cluster check (real CLI)', () => {
  it('fails with a kubectl diagnostic when kubectl is not on PATH', async () => {
    // Strip every PATH entry that contains a kubectl binary. Node itself
    // is spawned via an absolute path (process.execPath), so trimming
    // PATH only affects the CLI's child-process lookups — exactly the
    // `execFile('kubectl', ...)` probe under test.
    const { stdout, stderr, exitCode } = await runYaac(
      { ...testEnv.env, PATH: stripFromPath('kubectl') },
      'cluster', 'check',
    )
    expect(exitCode).toBe(1)
    expect(stdout).toContain('✗ kubectl')
    expect(stdout).toMatch(/not found on PATH/)
    // Actionable fix line accompanies the failure.
    expect(stdout).toMatch(/Install kubectl/)
    expect(stderr).toMatch(/Cluster is not ready/)
  }, 30_000)

  it('fails with a cluster diagnostic when kubectl is present but the API server is unreachable', async () => {
    // A KUBECONFIG pointing at a nonexistent file makes kubectl fall back
    // to an empty config, so `kubectl version` (server half) fails with a
    // connection error no matter what clusters the host knows about.
    const { stdout, stderr, exitCode } = await runYaac(
      { ...testEnv.env, KUBECONFIG: path.join(testEnv.scratchDir, 'no-such-kubeconfig') },
      'cluster', 'check',
    )
    expect(exitCode).toBe(1)
    // kubectl itself passes...
    expect(stdout).toContain('✓ kubectl')
    // ...but the API-server check fails with the cluster diagnostic.
    expect(stdout).toContain('✗ cluster')
    expect(stdout).toMatch(/API server unreachable/)
    expect(stderr).toMatch(/Cluster is not ready/)
  }, 30_000)
})

describe('yaac cluster setup (real CLI)', () => {
  it('refuses to run inside a nested yaac session', async () => {
    const { stderr, exitCode } = await runYaac(
      { ...testEnv.env, YAAC_NESTED: '1' },
      'cluster', 'setup',
    )
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/nested yaac session/)
    expect(stderr).toMatch(/outer yaac/)
  }, 30_000)

  it('fails with a complete shopping list when podman and kind are missing', async () => {
    // Drop the nested flag so the missing-binaries preflight (not the
    // nested guard) is what's under test when this suite itself runs
    // inside a nested session.
    const env: NodeJS.ProcessEnv = { ...testEnv.env, PATH: stripFromPath('podman', 'kind') }
    delete env.YAAC_NESTED

    const { stderr, exitCode } = await runYaac(env, 'cluster', 'setup')
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/Missing required tools/)
    expect(stderr).toMatch(/podman/)
    expect(stderr).toMatch(/kind/)
    // Actionable installs accompany each entry.
    expect(stderr).toMatch(/brew install/)
  }, 30_000)

  // The --nodes cases below stop in the option check, which runs before
  // the binary preflight and before anything is created — so they need no
  // podman, no kind, and no gate.
  it('rejects --nodes together with --repair', async () => {
    // The node count is fixed when the cluster is created; --repair fixes
    // up the nodes that exist, so the combination cannot mean anything.
    const env: NodeJS.ProcessEnv = { ...testEnv.env }
    delete env.YAAC_NESTED

    const { stdout, stderr, exitCode } = await runYaac(env, 'cluster', 'setup', '--nodes', '3', '--repair')
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/--nodes cannot be combined with --repair/)
    // The fix is the create that would honor it.
    expect(stderr).toMatch(/yaac cluster setup --nodes 3/)
    expect(stdout).not.toMatch(/Re-applying node fixups/)
  }, 30_000)

  it('rejects a --nodes value outside the supported range', async () => {
    const env: NodeJS.ProcessEnv = { ...testEnv.env }
    delete env.YAAC_NESTED

    for (const value of ['0', '99', 'three']) {
      const { stdout, stderr, exitCode } = await runYaac(env, 'cluster', 'setup', '--nodes', value)
      expect(exitCode).toBe(1)
      expect(stderr).toMatch(/--nodes must be an integer between 1 and \d+/)
      // The message quotes what was typed — the CLI passes the raw text
      // through rather than converting `three` to NaN first.
      expect(stderr).toContain(`"${value}"`)
      // Nothing was created: the check precedes the binary preflight.
      expect(stdout).not.toMatch(/Recreating kind cluster/)
      expect(stderr).not.toMatch(/Missing required tools/)
    }
  }, 60_000)

  // The --adopt-cni option checks run before the binary preflight too, so
  // they need no podman, no kind, and no cluster.
  it('rejects --adopt-cni together with --repair or --nodes', async () => {
    const env: NodeJS.ProcessEnv = { ...testEnv.env }
    delete env.YAAC_NESTED

    // --repair fixes up a kind cluster yaac built; --adopt-cni installs
    // into one it did not, and is itself idempotent.
    const repair = await runYaac(env, 'cluster', 'setup', '--adopt-cni', '--repair')
    expect(repair.exitCode).toBe(1)
    expect(repair.stderr).toMatch(/--adopt-cni cannot be combined with --repair/)
    expect(repair.stdout).not.toMatch(/Re-applying node fixups/)

    // Adopt mode creates no cluster, so there are no nodes to render.
    const nodes = await runYaac(env, 'cluster', 'setup', '--adopt-cni', '--nodes', '3')
    expect(nodes.exitCode).toBe(1)
    expect(nodes.stderr).toMatch(/--nodes cannot be combined with --adopt-cni/)
    expect(nodes.stdout).not.toMatch(/Recreating kind cluster/)
  }, 60_000)

  it('refuses to run --adopt-cni inside a nested yaac session', async () => {
    // Same guard as the other modes: the cluster is the outer yaac's.
    const { stderr, exitCode } = await runYaac(
      { ...testEnv.env, YAAC_NESTED: '1' },
      'cluster', 'setup', '--adopt-cni',
    )
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/nested yaac session/)
  }, 30_000)

  // The CNI gate itself, driven against a cluster that answers nothing: a
  // KUBECONFIG pointing at a nonexistent file makes every `kubectl get` in
  // the gate fail. It must refuse — and refuse BEFORE anything is applied,
  // since an unverifiable adoption must cost the user the diagnosis and
  // nothing else. Needs podman (adopt mode still builds images with it) but
  // deliberately NOT kind: not needing kind is part of the mode — which is
  // also why this one runs nested, unlike the two cluster-touching cases
  // below. Nothing here reaches the cluster: the gate refuses first.
  it.skipIf(process.platform !== 'linux' || !onPath('podman'))(
    '--adopt-cni refuses a cluster it cannot read, without claiming what it found',
    async () => {
      const env: NodeJS.ProcessEnv = {
        ...testEnv.env,
        KUBECONFIG: path.join(testEnv.scratchDir, 'no-such-kubeconfig'),
      }
      delete env.YAAC_NESTED

      const { stdout, stderr, exitCode } = await runYaac(env, 'cluster', 'setup', '--adopt-cni')
      expect(exitCode).toBe(1)
      expect(stdout).toMatch(/Verifying the CNI this cluster already runs/)
      expect(stderr).toMatch(/Cannot adopt this cluster's CNI/)

      // An unreachable apiserver is an UNKNOWN, not a set of absences — so
      // the diagnosis is the unevaluated refusal, naming every check that
      // did not happen, and nothing that asserts what the cluster contains.
      expect(stderr).toMatch(/check\(s\) could not be evaluated/)
      expect(stderr).toMatch(/Calico FelixConfiguration \(the eBPF-dataplane check\)/)
      expect(stderr).toMatch(/pod-CIDR source/)
      // Absence-shaped claims the gate never established must NOT appear:
      // "no calico-node in kube-system" reads as a Cilium cluster, which
      // would send the user to entirely the wrong fix.
      expect(stderr).not.toMatch(/no calico-node found/)
      expect(stderr).not.toMatch(/no kube-proxy pod found/)
      expect(stderr).not.toMatch(/no pod CIDR could be resolved/)
      expect(stderr).not.toMatch(/PriorityClass is missing/)

      // Nothing was installed, and no cluster was touched.
      expect(stdout).not.toMatch(/Deploying the in-cluster image registry/)
      expect(stdout).not.toMatch(/Recreating kind cluster/)
    },
    120_000,
  )

  // The config knobs are the other half of the gate's surface, and both
  // refuse rather than narrowing the redirect behind the operator's back.
  it.skipIf(process.platform !== 'linux' || !onPath('podman'))(
    '--adopt-cni refuses a YAAC_POD_CIDRS entry it cannot use, naming the entry',
    async () => {
      const env: NodeJS.ProcessEnv = {
        ...testEnv.env,
        KUBECONFIG: path.join(testEnv.scratchDir, 'no-such-kubeconfig'),
        // A plausible typo plus an out-of-range mask. Dropping either
        // silently would leave netd's exclusion set narrower than what was
        // configured, and those pods' 443/80 would go into the proxy.
        YAAC_POD_CIDRS: '172.31.0.0/16, 172.31/16, 10.0.0.0/33',
      }
      delete env.YAAC_NESTED

      const { stderr, exitCode } = await runYaac(env, 'cluster', 'setup', '--adopt-cni')
      expect(exitCode).toBe(1)
      expect(stderr).toMatch(/not usable IPv4 CIDRs/)
      expect(stderr).toContain('172.31/16')
      expect(stderr).toContain('10.0.0.0/33')
      // The good entry is not named as a problem.
      expect(stderr).not.toMatch(/CIDRs:[^.]*172\.31\.0\.0\/16/)
    },
    120_000,
  )

  // Needs a real, working podman+kind pair (`kind get clusters` must
  // succeed), so: not in a nested session (no kind in there), and not on a
  // host missing either binary. Linux-only: on macOS the machine-bootstrap
  // step runs first and could touch real machine state.
  it.skipIf(IS_NESTED_YAAC || process.platform !== 'linux' || !onPath('kind') || !onPath('podman'))(
    '--repair fails fast when the target kind cluster does not exist',
    async () => {
      const env: NodeJS.ProcessEnv = {
        ...testEnv.env,
        // A cluster name that cannot exist: --repair must fail on node
        // enumeration BEFORE ensuring the registry or touching any node.
        YAAC_KIND_CLUSTER: `yaac-e2e-absent-${crypto.randomBytes(4).toString('hex')}`,
      }
      delete env.YAAC_NESTED

      const { stdout, stderr, exitCode } = await runYaac(env, 'cluster', 'setup', '--repair')
      expect(exitCode).toBe(1)
      expect(stderr).toMatch(/not found/)
      expect(stderr).toMatch(/yaac cluster setup/)
      // No fixups were attempted.
      expect(stdout).not.toMatch(/Re-applying node fixups/)
    },
    60_000,
  )
})

describe('yaac cluster delete (real CLI)', () => {
  it('refuses to run inside a nested yaac session', async () => {
    const { stderr, exitCode } = await runYaac(
      { ...testEnv.env, YAAC_NESTED: '1' },
      'cluster', 'delete',
    )
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/nested yaac session/)
    expect(stderr).toMatch(/outer yaac/)
  }, 30_000)

  it('accepts -y/--yes but the nested guard still refuses before any mutation', async () => {
    const { stderr, exitCode } = await runYaac(
      { ...testEnv.env, YAAC_NESTED: '1' },
      'cluster', 'delete', '--yes',
    )
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/nested yaac session/)
  }, 30_000)

  // Needs a real kind/podman pair (`kind get clusters` must succeed) and must
  // NOT be nested (the nested guard fires first). Without --yes and with no
  // TTY, the confirmation gate returns false, so the command aborts BEFORE
  // deleting the cluster or the registry — safe to run against the dev host.
  it.skipIf(IS_NESTED_YAAC || process.platform !== 'linux' || !onPath('kind') || !onPath('podman'))(
    'aborts without deleting when not confirmed (no --yes, non-interactive)',
    async () => {
      const env: NodeJS.ProcessEnv = { ...testEnv.env }
      delete env.YAAC_NESTED

      const { stdout, exitCode } = await runYaac(env, 'cluster', 'delete')
      expect(exitCode).toBe(0)
      expect(stdout).toMatch(/Aborted/)
      expect(stdout).not.toMatch(/Deleting kind cluster/)
      expect(stdout).not.toMatch(/Removing local registry/)
    },
    60_000,
  )
})
