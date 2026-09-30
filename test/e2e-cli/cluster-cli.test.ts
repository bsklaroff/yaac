import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createYaacTestEnv, runYaac, type YaacTestEnv } from '@yaac/test-utils/cli'

/**
 * The `yaac cluster` commands: `check`, `install` (with `--nodes`, `--byo`,
 * `--rwx-storage-class`, `--rwo-storage-class`, `--tailnet`) and `delete`
 * (with `-y/--yes`). They are host-side commands that never talk to the
 * server, so no server is spawned and no cluster is needed: each case breaks
 * the environment (PATH stripping, a bogus KUBECONFIG, a kubectl shim) and
 * checks the diagnostic and exit code, stopping before any mutating step.
 *
 * The happy paths are not covered here: a green `check` needs a wired
 * cluster, `install` builds every image, and `delete` destroys the host's
 * cluster. `install --byo`'s happy path runs in `byo-install-suite`, and
 * the gates' refusal logic is unit-tested in
 * packages/server/test/drivers/k8s/install/install.test.ts.
 *
 * One test env serves the file; no test writes into its data dir, and a
 * test that needs a different environment passes it to runYaac.
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
    // Node is spawned by absolute path, so this only hides kubectl from
    // the CLI's own child-process lookups.
    const { stdout, stderr, exitCode } = await runYaac(
      { ...testEnv.env, PATH: stripFromPath('kubectl') },
      'cluster', 'check',
    )
    expect(exitCode).toBe(1)
    expect(stdout).toContain('✗ kubectl')
    expect(stdout).toMatch(/not found on PATH/)
    expect(stdout).toMatch(/Install kubectl/)
    expect(stderr).toMatch(/Cluster is not ready/)
  }, 30_000)

  it('fails with a cluster diagnostic when kubectl is present but the API server is unreachable', async () => {
    // A missing KUBECONFIG file leaves kubectl with an empty config, so the
    // API-server half of `kubectl version` fails.
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
    expect(stderr).toMatch(/brew install/)
  }, 30_000)

  // The option check runs before the binary preflight, so these need no
  // podman or kind.
  it('rejects a --nodes value outside the supported range', async () => {
    const env: NodeJS.ProcessEnv = { ...testEnv.env }

    for (const value of ['0', '99', 'three']) {
      const { stdout, stderr, exitCode } = await runYaac(env, 'cluster', 'install', '--nodes', value)
      expect(exitCode).toBe(1)
      expect(stderr).toMatch(/--nodes must be an integer between 1 and \d+/)
      // The message quotes the raw text, not NaN.
      expect(stderr).toContain(`"${value}"`)
      expect(stdout).not.toMatch(/Creating kind cluster/)
      expect(stderr).not.toMatch(/Missing required tools/)
    }
  }, 60_000)

  // These option checks also run before the binary preflight.
  it('rejects --byo with --nodes, --byo without an RWX class, and either class flag without --byo', async () => {
    const env: NodeJS.ProcessEnv = { ...testEnv.env }
    const cases: Array<[string[], RegExp]> = [
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

  // The gates, against a cluster where every read fails (missing
  // KUBECONFIG). They must refuse before anything is applied and report the
  // state as unknown rather than guess. Needs podman on PATH (a byo install
  // still builds images) but not kind.
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

  // Refusals that need specific cluster answers use a PATH-shimmed kubectl
  // (see writeKubectlShim).
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

        // --tailnet is accepted beside --byo and changes nothing.
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

    // A cluster is identified by its kube-system namespace's uid, not its
    // context name. The shim's context has the recorded name but a
    // different uid, as after a KUBECONFIG switch.
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

    // The CNI gate refuses a bad config value rather than silently
    // narrowing netd's exclusion set.
    it.skipIf(process.platform !== 'linux' || !onPath('podman'))(
      '--byo refuses a YAAC_POD_CIDRS entry it cannot use, naming the entry',
      async () => {
        // A plausible typo plus an out-of-range mask.
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
 * A fake `kubectl` for a healthy cluster: one Ready node of this machine's
 * architecture running containerd, Calico (iptables dataplane) with
 * kube-proxy, the Tailscale operator, an NFS class and a default block
 * class, and no yaac server. `FAKE_NODE_ARCH`, `FAKE_OPERATOR=absent` and
 * `FAKE_CLUSTER_UID` (the kube-system namespace's uid) change it. Anything
 * else reads as NotFound.
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
  // Needs a real kind/podman pair. Without --yes and with no TTY the
  // confirmation fails, so the command aborts before deleting anything.
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
