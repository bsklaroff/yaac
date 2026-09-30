import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createYaacTestEnv, runYaac, type YaacTestEnv } from '@yaac/test-utils/cli'

/**
 * Merged e2e coverage for the `yaac cluster` command family: `check` (no
 * options), `install` (and its `--nodes` / `--byo` / `--rwx-storage-class` /
 * `--rwo-storage-class` / `--tailnet`
 * options), and `delete` (and its `-y/--yes` option). All three are host-side commands —
 * they talk to kubectl/podman/kind/the registry directly, never to the
 * server — so no server is spawned anywhere in this file and every case
 * runs without a cluster: we sabotage the environment (PATH stripping, a
 * bogus KUBECONFIG) and assert the diagnostic output + exit code.
 *
 * The happy paths are excluded by design: `check`'s all-green run needs a
 * fully wired kind cluster, and a full `install` builds every image (and a
 * full `delete` destroys the host's cluster) — all are exercised manually
 * per the README. The guard-rail cases below all stop BEFORE any mutating
 * step.
 *
 * `install --byo`'s happy path runs against kind-byo, in
 * `byo-install-suite` (the `e2e-byo-install` project). What is covered here is its
 * whole option surface plus its gates — the part that matters, since an
 * unverified install fails silently — each stopping before anything is
 * applied. The gates' per-refusal reasoning is unit-tested against staged
 * cluster reads in packages/server/test/drivers/k8s/install/install.test.ts.
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

describe('yaac cluster install (real CLI)', () => {
  it('fails with a complete shopping list when podman and kind are missing', async () => {
    const env: NodeJS.ProcessEnv = { ...testEnv.env, PATH: stripFromPath('podman', 'kind') }

    const { stderr, exitCode } = await runYaac(env, 'cluster', 'install')
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
  it('rejects a --nodes value outside the supported range', async () => {
    const env: NodeJS.ProcessEnv = { ...testEnv.env }

    for (const value of ['0', '99', 'three']) {
      const { stdout, stderr, exitCode } = await runYaac(env, 'cluster', 'install', '--nodes', value)
      expect(exitCode).toBe(1)
      expect(stderr).toMatch(/--nodes must be an integer between 1 and \d+/)
      // The message quotes what was typed — the CLI passes the raw text
      // through rather than converting `three` to NaN first.
      expect(stderr).toContain(`"${value}"`)
      // Nothing was created: the check precedes the binary preflight.
      expect(stdout).not.toMatch(/Creating kind cluster/)
      expect(stderr).not.toMatch(/Missing required tools/)
    }
  }, 60_000)

  // The --byo option checks run before the binary preflight too, so they
  // need no podman, no kind, and no cluster.
  it('rejects --byo with --nodes, --byo without an RWX class, and either class flag without --byo', async () => {
    const env: NodeJS.ProcessEnv = { ...testEnv.env }
    const cases: Array<[string[], RegExp]> = [
      // A byo install creates no cluster, so there are no nodes to render.
      [['--byo', '--rwx-storage-class', 'nfs', '--nodes', '3'], /--nodes cannot be combined with --byo/],
      [['--byo'], /--byo needs --rwx-storage-class/],
      [['--rwx-storage-class', 'nfs'], /--rwx-storage-class is for --byo only/],
      [['--rwo-storage-class', 'ssd'], /--rwo-storage-class is for --byo only/],
    ]
    for (const [args, message] of cases) {
      const { stdout, stderr, exitCode } = await runYaac(env, 'cluster', 'install', ...args)
      expect(exitCode).toBe(1)
      expect(stderr).toMatch(message)
      expect(stderr).not.toMatch(/Missing required tools/)
      expect(stdout).not.toMatch(/Creating kind cluster/)
    }
  }, 60_000)

  // The gates themselves, against a cluster that answers nothing: a
  // KUBECONFIG pointing at a nonexistent file makes every read fail. They
  // must refuse — before anything is applied, and before the podman
  // bootstrap — with an unknown, never a claim about what the cluster
  // holds. Needs podman on PATH (a byo install still builds images) but
  // deliberately NOT kind.
  it.skipIf(process.platform !== 'linux' || !onPath('podman'))(
    '--byo refuses a cluster it cannot read, without claiming what it found',
    async () => {
      const env: NodeJS.ProcessEnv = {
        ...testEnv.env,
        KUBECONFIG: path.join(testEnv.scratchDir, 'no-such-kubeconfig'),
      }
      const { stdout, stderr, exitCode } = await runYaac(
        env, 'cluster', 'install', '--byo', '--rwx-storage-class', 'nfs',
      )
      expect(exitCode).toBe(1)
      expect(stdout).toMatch(/Verifying the cluster the kubeconfig points at \(--byo\)/)
      expect(stderr).toMatch(/could not be evaluated: reading the cluster's nodes failed/)
      expect(stderr).not.toMatch(/every node is|mixes architectures/)
      expect(stdout).not.toMatch(/Deploying the in-cluster image registry/)
      expect(stdout).not.toMatch(/Creating kind cluster/)
    },
    120_000,
  )

  // Where a refusal needs a cluster that says something specific, a
  // PATH-shimmed kubectl answers canned node, CNI, operator, class and
  // Deployment reads (see writeKubectlShim) — every case stopping at a gate,
  // before anything is applied.
  describe('against a shimmed cluster', () => {
    let shimEnv: NodeJS.ProcessEnv
    const install = (env: NodeJS.ProcessEnv, ...args: string[]): ReturnType<typeof runYaac> =>
      runYaac({ ...shimEnv, ...env }, 'cluster', 'install', '--byo', ...args)

    beforeAll(async () => {
      const dir = path.join(testEnv.scratchDir, 'kubectl-shim')
      await writeKubectlShim(dir)
      shimEnv = { ...testEnv.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}` }
    })

    it.skipIf(process.platform !== 'linux' || !onPath('podman'))(
      '--byo refuses a pool of the other architecture, naming both, and one without the operator',
      async () => {
        const host = process.arch === 'x64' ? 'amd64' : process.arch
        const other = host === 'amd64' ? 'arm64' : 'amd64'
        const arch = await install({ FAKE_NODE_ARCH: other }, '--rwx-storage-class', 'nfs')
        expect(arch.exitCode).toBe(1)
        expect(arch.stderr).toContain(`every node is ${other}, and this machine is ${host}`)

        // --tailnet beside --byo is accepted and changes nothing: the
        // operator is what --byo itself needs.
        const operator = await install({ FAKE_OPERATOR: 'absent' }, '--rwx-storage-class', 'nfs', '--tailnet')
        expect(operator.exitCode).toBe(1)
        expect(operator.stderr).toMatch(/--byo needs the Tailscale Kubernetes operator/)
        expect(operator.stderr).toMatch(/helm upgrade --install tailscale-operator/)
        expect(operator.stdout).not.toMatch(/Deploying the in-cluster image registry/)
      },
      120_000,
    )

    it.skipIf(process.platform !== 'linux' || !onPath('podman'))(
      '--rwx-storage-class refuses an absent class and a non-NFS one; --rwo-storage-class an absent one',
      async () => {
        const absent = await install({}, '--rwx-storage-class', 'nope')
        expect(absent.exitCode).toBe(1)
        expect(absent.stderr).toMatch(/--rwx-storage-class: there is no StorageClass "nope" \(this cluster has: nfs, standard\)/)

        const block = await install({}, '--rwx-storage-class', 'standard')
        expect(block.exitCode).toBe(1)
        expect(block.stderr).toMatch(/"standard" provisions through ebs\.csi\.aws\.com, which is not NFS-family/)

        const rwo = await install({}, '--rwx-storage-class', 'nfs', '--rwo-storage-class', 'nope')
        expect(rwo.exitCode).toBe(1)
        expect(rwo.stderr).toMatch(/--rwo-storage-class: there is no StorageClass "nope"/)
        expect(rwo.stdout).not.toMatch(/Deploying the in-cluster image registry/)
      },
      120_000,
    )

    // The cluster an install is in is its kube-system namespace's uid, not
    // its context's name: the shim's context has the recorded name and is
    // another cluster, which is what a KUBECONFIG switch looks like.
    it.skipIf(process.platform !== 'linux' || !onPath('podman'))(
      'every cluster verb refuses a same-named context on another cluster; plain install refuses a byo data dir',
      async () => {
        const dataDir = path.join(testEnv.scratchDir, 'foreign-cluster')
        await fs.mkdir(`${dataDir}-client`, { recursive: true })
        await fs.writeFile(path.join(`${dataDir}-client`, 'server.json'), JSON.stringify({
          url: '', enabled: false, saved: [], driver: 'k8s',
          installId: 'install-1', clusterUid: 'uid-recorded', kubeContext: 'fake-byo', byo: true,
        }))
        const env = { ...shimEnv, YAAC_DATA_DIR: dataDir }
        for (const verb of [
          ['server', 'stop'], ['server', 'start'], ['server', 'restart'], ['server', 'logs'],
          ['cluster', 'check'], ['cluster', 'install', '--byo', '--rwx-storage-class', 'nfs'],
        ]) {
          const res = await runYaac(env, ...verb)
          expect(res.exitCode, verb.join(' ')).toBe(1)
          expect(res.stderr, verb.join(' ')).toMatch(/same name but is a different cluster/)
        }
        // The recorded cluster passes the gate.
        const same = await runYaac({ ...env, FAKE_CLUSTER_UID: 'uid-recorded' }, 'server', 'stop')
        expect(same.stderr).not.toMatch(/different cluster/)

        // A byo data dir is never installed down the kind path.
        const plain = await runYaac({ ...env, FAKE_CLUSTER_UID: 'uid-recorded' }, 'cluster', 'install')
        expect(plain.exitCode).toBe(1)
        expect(plain.stderr).toMatch(/This data dir is a --byo install\. Re-run with --byo/)
        expect(plain.stdout).not.toMatch(/kind/)
      },
      120_000,
    )

    // The config knobs are the CNI gate's other surface, and it refuses
    // rather than narrowing the redirect behind the operator's back.
    it.skipIf(process.platform !== 'linux' || !onPath('podman'))(
      '--byo refuses a YAAC_POD_CIDRS entry it cannot use, naming the entry',
      async () => {
        // A plausible typo plus an out-of-range mask. Dropping either
        // silently would leave netd's exclusion set narrower than what was
        // configured, and those pods' 443/80 would go into the proxy.
        const { stderr, exitCode } = await install(
          { YAAC_POD_CIDRS: '172.31.0.0/16, 172.31/16, 10.0.0.0/33' }, '--rwx-storage-class', 'nfs',
        )
        expect(exitCode).toBe(1)
        expect(stderr).toMatch(/not usable IPv4 CIDRs/)
        expect(stderr).toContain('172.31/16')
        expect(stderr).toContain('10.0.0.0/33')
        expect(stderr).not.toMatch(/CIDRs:[^.]*172\.31\.0\.0\/16/)
      },
      120_000,
    )
  })
})

/**
 * A `kubectl` for a cluster that is exactly as healthy as a case needs:
 * one Ready node of this machine's architecture running containerd, a
 * rolled-out Calico in its iptables dataplane with kube-proxy beside it, the
 * Tailscale operator, an NFS class and a default block class, and no yaac
 * server yet. `FAKE_NODE_ARCH`, `FAKE_OPERATOR=absent` and `FAKE_CLUSTER_UID`
 * (its kube-system namespace's uid) bend it. Anything
 * it is not taught reads as NotFound.
 */
async function writeKubectlShim(dir: string): Promise<void> {
  const host = process.arch === 'x64' ? 'amd64' : process.arch
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2).filter((a) => !a.startsWith('--request-timeout'))
const out = (v) => { process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v)); process.exit(0) }
const notFound = () => { process.stderr.write('Error from server (NotFound): not found'); process.exit(1) }
const [verb, kind, name] = args
if (verb === 'version') out('{}')
if (verb === 'config' && kind === 'current-context') out('fake-byo\\n')
if (verb !== 'get') notFound()
if (kind === 'namespace' && name === 'kube-system') out(process.env.FAKE_CLUSTER_UID || 'uid-shim')
if (kind === 'nodes') out({ items: [{
  metadata: { name: 'pool-1' },
  spec: { podCIDR: '10.244.0.0/24' },
  status: {
    addresses: [{ type: 'InternalIP', address: '10.0.0.10' }],
    nodeInfo: {
      architecture: process.env.FAKE_NODE_ARCH || '${host}',
      osImage: 'Ubuntu 24.04 LTS', containerRuntimeVersion: 'containerd://2.1.0', kubeletVersion: 'v1.37.0',
    },
  },
}] })
if (kind === 'daemonset' && name === 'calico-node') out({
  status: { numberReady: 1, desiredNumberScheduled: 1 },
  spec: { template: { spec: { containers: [{ name: 'calico-node', env: [] }] } } },
})
if (kind === 'pods' && args.includes('k8s-app=kube-proxy')) out({ items: [{ spec: { nodeName: 'pool-1' }, status: { phase: 'Running' } }] })
if (kind === 'priorityclass') out({ metadata: { name } })
if (kind === 'ippools.crd.projectcalico.org') out({ items: [{ spec: { cidr: '10.244.0.0/16' } }] })
const operator = kind === 'crd' || kind === 'ingressclass' || (kind === 'deployment' && name === 'operator')
if (operator) process.env.FAKE_OPERATOR === 'absent' ? notFound() : out('{}')
if (kind === 'storageclass') out({ items: [
  { metadata: { name: 'nfs' }, provisioner: 'nfs.csi.k8s.io' },
  { metadata: { name: 'standard', annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } }, provisioner: 'ebs.csi.aws.com' },
] })
notFound()
`
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'kubectl'), script, { mode: 0o755 })
}

describe('yaac cluster delete (real CLI)', () => {
  // Needs a real kind/podman pair (`kind get clusters` must succeed).
  // Without --yes and with no TTY, the confirmation gate returns false, so
  // the command aborts BEFORE deleting the cluster or the registry — safe
  // to run against the dev host.
  it.skipIf(process.platform !== 'linux' || !onPath('kind') || !onPath('podman'))(
    'aborts without deleting when not confirmed (no --yes, non-interactive)',
    async () => {
      const env: NodeJS.ProcessEnv = { ...testEnv.env }

      const { stdout, exitCode } = await runYaac(env, 'cluster', 'delete')
      expect(exitCode).toBe(0)
      expect(stdout).toMatch(/Aborted/)
      expect(stdout).not.toMatch(/Deleting kind cluster/)
      expect(stdout).not.toMatch(/Removing local registry/)
    },
    60_000,
  )
})
