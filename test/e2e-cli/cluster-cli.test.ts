import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createYaacTestEnv, runYaac, type YaacTestEnv } from '@yaac/test-utils/cli'
import { TAILSCALE_OPERATOR_NAMESPACE } from '@yaac/server/drivers/k8s/substrate/proxy-constants'

/**
 * The `yaac cluster` commands: `check`, `install` (with `--nodes`, `--byo`,
 * `--rwx-storage-class`, `--rwo-storage-class`, `--tailnet [host]`, `--owner`) and `delete`
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
  it('rejects --byo with --nodes, --byo without an RWX class, either class flag without --byo, --owner without --tailnet, and a --tailnet host it cannot serve', async () => {
    const env: NodeJS.ProcessEnv = { ...testEnv.env }
    const cases: Array<[string[], RegExp]> = [
      [['--byo', '--rwx-storage-class', 'nfs', '--nodes', '3'], /--nodes cannot be combined with --byo/],
      [['--byo'], /--byo needs --rwx-storage-class/],
      [['--rwx-storage-class', 'nfs'], /--rwx-storage-class is for --byo only/],
      [['--rwo-storage-class', 'ssd'], /--rwo-storage-class is for --byo only/],
      [['--owner', 'alice@example.com'], /--owner .* needs --tailnet/],
      [['--byo', '--rwx-storage-class', 'nfs', '--tailnet', 'srv.tail.ts.net'], /--byo install is published through the Tailscale operator/],
      [['--tailnet', 'https://srv.tail.ts.net'], /--tailnet takes the bare MagicDNS name/],
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

  // Refusals that need specific cluster answers run against a fake API
  // server (see startFakeCluster).
  describe('against a fake cluster', () => {
    let fake: FakeCluster
    let shimEnv: NodeJS.ProcessEnv
    const install = (env: NodeJS.ProcessEnv, ...args: string[]): ReturnType<typeof runYaac> =>
      runYaac({ ...shimEnv, ...env }, 'cluster', 'install', '--byo', ...args)

    beforeAll(async () => {
      fake = await startFakeCluster(path.join(testEnv.scratchDir, 'fake-cluster-kubeconfig'))
      shimEnv = { ...testEnv.env, KUBECONFIG: fake.kubeconfig }
    })
    afterAll(() => fake.close())

    it.skipIf(process.platform !== 'linux' || !onPath('podman'))(
      '--byo refuses a pool of the other architecture, naming both, and one without the operator',
      async () => {
        const host = process.arch === 'x64' ? 'amd64' : process.arch
        const other = host === 'amd64' ? 'arm64' : 'amd64'
        fake.state = { nodeArch: other }
        const arch = await install({}, '--rwx-storage-class', 'nfs')
        expect(arch.exitCode).toBe(1)
        expect(arch.stderr).toContain(`every node is ${other}, and this machine is ${host}`)

        // --tailnet is accepted beside --byo and changes nothing.
        fake.state = { operatorAbsent: true }
        const operator = await install({}, '--rwx-storage-class', 'nfs', '--tailnet')
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
        fake.state = {}
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
    // context name. The fake's context has the recorded name but a
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
        fake.state = {}
        for (const verb of [
          ['server', 'stop'], ['server', 'start'], ['server', 'restart'], ['server', 'logs'],
          ['cluster', 'check'], ['cluster', 'install', '--byo', '--rwx-storage-class', 'nfs'],
        ]) {
          const res = await runYaac(env, ...verb)
          expect(res.exitCode, verb.join(' ')).toBe(1)
          expect(res.stderr, verb.join(' ')).toMatch(/same name but is a different cluster/)
        }
        fake.state = { clusterUid: 'uid-recorded' }
        const same = await runYaac(env, 'server', 'stop')
        expect(same.stderr).not.toMatch(/different cluster/)

        // A byo data dir is never installed down the kind path.
        const plain = await runYaac(env, 'cluster', 'install')
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
        fake.state = {}
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

interface FakeClusterState {
  /** The node's architecture; this machine's by default. */
  nodeArch?: string
  /** Leave out the Tailscale operator's CRD, Deployment and IngressClass. */
  operatorAbsent?: boolean
  /** The kube-system namespace's uid, which identifies a cluster. */
  clusterUid?: string
}

interface FakeCluster {
  kubeconfig: string
  state: FakeClusterState
  close: () => void
}

/** Where each kind the --byo gates read is served, as discovery lists it. */
const FAKE_RESOURCES: Record<string, { groupVersion: string; plural: string; namespaced: boolean }> = {
  Namespace: { groupVersion: 'v1', plural: 'namespaces', namespaced: false },
  Node: { groupVersion: 'v1', plural: 'nodes', namespaced: false },
  Pod: { groupVersion: 'v1', plural: 'pods', namespaced: true },
  DaemonSet: { groupVersion: 'apps/v1', plural: 'daemonsets', namespaced: true },
  Deployment: { groupVersion: 'apps/v1', plural: 'deployments', namespaced: true },
  PriorityClass: { groupVersion: 'scheduling.k8s.io/v1', plural: 'priorityclasses', namespaced: false },
  RuntimeClass: { groupVersion: 'node.k8s.io/v1', plural: 'runtimeclasses', namespaced: false },
  StorageClass: { groupVersion: 'storage.k8s.io/v1', plural: 'storageclasses', namespaced: false },
  IngressClass: { groupVersion: 'networking.k8s.io/v1', plural: 'ingressclasses', namespaced: false },
  CustomResourceDefinition: {
    groupVersion: 'apiextensions.k8s.io/v1', plural: 'customresourcedefinitions', namespaced: false,
  },
  IPPool: { groupVersion: 'crd.projectcalico.org/v1', plural: 'ippools', namespaced: false },
}

/** The objects of a healthy cluster, shaped by `state`. */
function fakeObjects(state: FakeClusterState): Array<{ kind: string; metadata: Record<string, unknown> } & Record<string, unknown>> {
  const host = process.arch === 'x64' ? 'amd64' : process.arch
  return [
    { kind: 'Namespace', metadata: { name: 'kube-system', uid: state.clusterUid ?? 'uid-fake' } },
    {
      kind: 'Node',
      metadata: { name: 'pool-1' },
      spec: { podCIDR: '10.244.0.0/24' },
      status: {
        addresses: [{ type: 'InternalIP', address: '10.0.0.10' }],
        nodeInfo: {
          architecture: state.nodeArch ?? host,
          osImage: 'Ubuntu 24.04 LTS', containerRuntimeVersion: 'containerd://2.1.0', kubeletVersion: 'v1.37.0',
        },
      },
    },
    {
      kind: 'DaemonSet',
      metadata: { name: 'calico-node', namespace: 'kube-system' },
      status: { numberReady: 1, desiredNumberScheduled: 1 },
      spec: { template: { spec: { containers: [{ name: 'calico-node', env: [] }] } } },
    },
    {
      kind: 'Pod',
      metadata: { name: 'kube-proxy-1', namespace: 'kube-system', labels: { 'k8s-app': 'kube-proxy' } },
      spec: { nodeName: 'pool-1' },
      status: { phase: 'Running' },
    },
    { kind: 'PriorityClass', metadata: { name: 'system-node-critical' }, value: 2000001000 },
    { kind: 'IPPool', metadata: { name: 'default-ipv4-ippool' }, spec: { cidr: '10.244.0.0/16' } },
    ...(state.operatorAbsent
      ? []
      : [
          { kind: 'CustomResourceDefinition', metadata: { name: 'proxyclasses.tailscale.com' } },
          { kind: 'Deployment', metadata: { name: 'operator', namespace: TAILSCALE_OPERATOR_NAMESPACE } },
          { kind: 'IngressClass', metadata: { name: 'tailscale' } },
        ]),
    { kind: 'StorageClass', metadata: { name: 'nfs' }, provisioner: 'nfs.csi.k8s.io' },
    {
      kind: 'StorageClass',
      metadata: { name: 'standard', annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } },
      provisioner: 'ebs.csi.aws.com',
    },
  ]
}

/**
 * A fake API server for a healthy cluster: one Ready node of this
 * machine's architecture running containerd, Calico with kube-proxy, the
 * Tailscale operator, an NFS class and a default block class, and no yaac
 * server. `state` changes it between runs. Anything else reads as
 * NotFound. The kubeconfig's context is `fake-byo`, so kubectl's own
 * `config current-context` answers it too.
 */
async function startFakeCluster(kubeconfig: string): Promise<FakeCluster> {
  const fake: FakeCluster = { kubeconfig, state: {}, close: () => { server.close() } }
  const send = (res: http.ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake')
    if (url.pathname === '/version') return send(res, 200, { gitVersion: 'v1.37.0' })
    const parts = url.pathname.split('/').filter(Boolean)
    const groupVersion = parts[0] === 'api' ? parts[1] : `${parts[1]}/${parts[2]}`
    const rest = parts.slice(parts[0] === 'api' ? 2 : 3)
    const kinds = Object.entries(FAKE_RESOURCES).filter(([, r]) => r.groupVersion === groupVersion)
    if (kinds.length === 0) return send(res, 404, { kind: 'Status', code: 404, message: 'not found' })
    if (rest.length === 0) {
      return send(res, 200, {
        kind: 'APIResourceList', groupVersion,
        resources: kinds.map(([kind, r]) => ({ name: r.plural, kind, namespaced: r.namespaced, verbs: ['get', 'list'] })),
      })
    }
    const namespace = rest[0] === 'namespaces' && rest.length > 2 ? rest[1] : undefined
    const [plural, name] = namespace ? rest.slice(2) : rest
    const kind = kinds.find(([, r]) => r.plural === plural)?.[0]
    const [selKey, selValue] = (url.searchParams.get('labelSelector') ?? '').split('=')
    const matches = fakeObjects(fake.state).filter((o) => o.kind === kind
      && (namespace === undefined || o.metadata.namespace === namespace)
      && (!selKey || (o.metadata.labels as Record<string, string> | undefined)?.[selKey] === selValue))
    const found = matches.map((o) => ({ apiVersion: groupVersion, ...o }))
    if (name === undefined) return send(res, 200, { kind: `${kind ?? ''}List`, metadata: {}, items: found })
    const obj = found.find((o) => o.metadata.name === name)
    return obj ? send(res, 200, obj) : send(res, 404, { kind: 'Status', code: 404, message: `${plural} "${name}" not found` })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await fs.mkdir(path.dirname(kubeconfig), { recursive: true })
  await fs.writeFile(kubeconfig, JSON.stringify({
    apiVersion: 'v1',
    kind: 'Config',
    // client-node accepts a plain-HTTP server only with this set.
    clusters: [{ name: 'fake', cluster: { server: `http://127.0.0.1:${String(port)}`, 'insecure-skip-tls-verify': true } }],
    users: [{ name: 'fake', user: { token: 'fake' } }],
    contexts: [{ name: 'fake-byo', context: { cluster: 'fake', user: 'fake' } }],
    'current-context': 'fake-byo',
  }))
  return fake
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
