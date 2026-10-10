import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import type * as apiModule from '#drivers/k8s/substrate/api'
import type * as clusterBarrel from '#drivers/k8s/cluster'
import type * as substrateBarrel from '#drivers/k8s/substrate'
import type * as containerBarrel from '#drivers/k8s/container'
import type * as imageEngineBarrel from '#drivers/k8s/image-engine'

/**
 * What these tests cover is what install decides: order, which failures
 * are fatal, and what it hands each step. The layers from other folders
 * (cluster, substrate) are faked at their barrels. Install's own steps
 * (built-in images, the gVisor installer, the server deploy) run for real
 * against faked process boundaries: the cluster (the shared fake), kubectl,
 * the registry, the image engine, host podman and `fetch`. Each records
 * itself in `events` when it reaches the cluster, which is what the order
 * assertions read.
 */
type Step =
  | 'ensurePriorityClasses' | 'ensureMainRegistry' | 'ensureBuilderRoleGuard'
  | 'buildBuiltinImages' | 'ensureGvisorRuntime' | 'ensureNetd'
  | 'ensureNpmCache' | 'deployServerWorkload'
const { events, failing, reach, fakeStep } = vi.hoisted(() => {
  const events: Step[] = []
  /** Steps a case fails, with the error each throws. */
  const failing = new Map<Step, string>()
  /** Record a step reaching the outside world, failing it if a case asks. */
  const reach = (step: Step): void => {
    events.push(step)
    const message = failing.get(step)
    if (message !== undefined) throw new Error(message)
  }
  const fakeStep = (step: Step) => vi.fn(() => {
    reach(step)
    return Promise.resolve()
  })
  return { events, failing, reach, fakeStep }
})
const ran = (step: Step): number => events.filter((e) => e === step).length
const order = (step: Step): number => events.indexOf(step)
vi.mock('#drivers/k8s/cluster', async (importOriginal) => ({
  ...(await importOriginal<typeof clusterBarrel>()),
  ensureMainRegistry: fakeStep('ensureMainRegistry'),
  ensureBuilderRoleGuard: fakeStep('ensureBuilderRoleGuard'),
  ensureNetd: fakeStep('ensureNetd'),
  ensureNpmCache: fakeStep('ensureNpmCache'),
}))
vi.mock('#drivers/k8s/substrate', async (importOriginal) => ({
  ...(await importOriginal<typeof substrateBarrel>()),
  ensurePriorityClasses: fakeStep('ensurePriorityClasses'),
}))

// The registry already holds every image, so nothing is built or pushed.
// Host podman answers only the kind node's published server port.
vi.mock('#drivers/k8s/container', async (importOriginal) => ({
  ...(await importOriginal<typeof containerBarrel>()),
  registryHasTag: vi.fn().mockResolvedValue(true),
  registryRef: (tag: string) => `reg.local:5000/${tag}`,
  pushImageToRegistry: (tag: string) => Promise.resolve(`reg.local:5000/${tag}`),
  reapOrphanedPodmanProcs: vi.fn().mockResolvedValue(undefined),
  invalidateRegistryEndpoint: vi.fn(),
  execFileAsync: (file: string, args: string[]) =>
    file === 'podman' && args[0] === 'port'
      ? Promise.resolve({ stdout: `127.0.0.1:${String(DEFAULT_CLUSTER_SERVER_PORT)}\n`, stderr: '' })
      : Promise.reject(new Error(`unexpected host process: ${file} ${args.join(' ')}`)),
}))
// Hashing the real build contexts would need `pnpm build` for the bundle.
vi.mock('#drivers/k8s/image-engine', async (importOriginal) => ({
  ...(await importOriginal<typeof imageEngineBarrel>()),
  contextHash: vi.fn().mockResolvedValue('ctxhash'),
  gcHostImages: vi.fn().mockResolvedValue({ retired: [], pruned: 0 }),
  resolveTrustedLayers: vi.fn(() => {
    reach('buildBuiltinImages')
    const layer = (name: string): object => ({ tag: `yaac-${name}:0123456789abcdef`, name, dockerfile: '', context: '' })
    return Promise.resolve({ base: layer('base'), tools: layer('tools'), nestable: layer('nestable') })
  }),
}))

vi.mock('#drivers/k8s/substrate/api', async (importOriginal) => ({
  ...await importOriginal<typeof apiModule>(),
  k8sNamespace: vi.fn(() => 'test-ns'),
  dataDirHash: vi.fn(() => 'ddh16'),
  // The rollout waits: every workload rolls out at once.
  execFileAsync: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

/** An applied object, with only the fields the tests read. */
interface Applied {
  kind: string
  metadata: { name: string }
  spec?: Record<string, unknown>
}

/**
 * What the cluster holds beyond what install applies: `nodes` and `pools`
 * are what the node and pod-CIDR reads answer (`pools: null` is a cluster
 * without Calico's CRDs, and `poolsDenied` an RBAC denial on them), and
 * `adopt` is the `--byo` cluster `adoptRun` describes. `applied` keeps
 * every manifest an apply delivered.
 */
const cluster = {
  applied: [] as Applied[],
  nodes: [] as Array<{ podCIDR?: string; address?: string; annotations?: Record<string, string> }>,
  pools: null as string[] | null,
  poolsDenied: false,
  adopt: null as AdoptFacts | null,
}

function appliedOf(kind: string, name?: string): Applied[] {
  return cluster.applied.filter((m) => m.kind === kind && (name === undefined || m.metadata.name === name))
}

/** Set while the fixtures rewrite the fake, so their own calls pass untouched. */
let staging = false

/** Make `objects` the only ones of `kind` in the fake cluster. */
function replaceKind(kind: string, objects: FakeObject[]): void {
  staging = true
  try {
    for (const o of fakeCluster.objects(kind)) {
      fakeCluster.request({ verb: 'delete', apiVersion: o.apiVersion, kind, name: o.metadata.name, namespace: o.metadata.namespace })
    }
  } finally {
    staging = false
  }
  fakeCluster.seed(...objects)
}

/** The Node objects, from `cluster.nodes` merged with the byo facts. */
function nodeObjects(): FakeObject[] {
  const facts = cluster.adopt
  const adopted = facts ? facts.nodes ?? ADOPT_NODES.map((name) => ({ name })) : []
  return Array.from({ length: Math.max(adopted.length, cluster.nodes.length) }, (_, i) => {
    const n = adopted[i] as NonNullable<AdoptFacts['nodes']>[number] | undefined
    const net = cluster.nodes[i] ?? {}
    return {
      apiVersion: 'v1', kind: 'Node',
      metadata: { name: n?.name ?? `node-${String(i)}`, ...(net.annotations ? { annotations: net.annotations } : {}) },
      spec: {
        ...(net.podCIDR ? { podCIDR: net.podCIDR } : {}),
        ...(n?.taint
          ? { taints: [{ key: n.taint, effect: 'NoSchedule' }] }
          : n?.schedulable === false
            ? { taints: [{ key: 'node.kubernetes.io/unschedulable', effect: 'NoSchedule' }] }
            : {}),
      },
      status: {
        addresses: net.address ? [{ type: 'InternalIP', address: net.address }] : [],
        nodeInfo: {
          architecture: HOST_ARCH,
          osImage: 'Ubuntu 24.04 LTS',
          containerRuntimeVersion: 'containerd://2.1.0',
          kubeletVersion: 'v1.37.0',
          ...facts?.nodeInfo,
        },
      },
    }
  })
}

const forbidden = (what: string): ApiException =>
  apiError(403, `${what} is forbidden: User "x" cannot list resource`)

/**
 * The cluster's controllers and operators, as install's own steps meet
 * them: a claim binds to a volume once read, the storage binder pod
 * succeeds, the tailnet operator publishes the server Ingress at once, and
 * an apply of the gVisor installer or the server Deployment marks its step.
 */
function world(c: FakeCall): void {
  if (staging) return
  if (c.kind === 'Node') {
    if (cluster.adopt?.denied === 'nodes') throw forbidden('nodes')
    replaceKind('Node', nodeObjects())
  }
  if (c.kind === 'IPPool') {
    if (cluster.poolsDenied) throw forbidden('ippools.crd.projectcalico.org')
    if (cluster.pools === null) throw apiError(404, 'the server could not find the requested resource')
    replaceKind('IPPool', cluster.pools.map((cidr, i) => ({
      apiVersion: 'crd.projectcalico.org/v1', kind: 'IPPool', metadata: { name: `pool-${String(i)}` }, spec: { cidr },
    })))
  }
  const denied = cluster.adopt?.denied
  if (denied === 'felix' && c.kind === 'FelixConfiguration') throw forbidden('felixconfigurations.crd.projectcalico.org')
  if (denied === 'calico' && c.kind === 'DaemonSet' && c.name === 'calico-node') throw forbidden('daemonsets.apps')
  if (denied === 'kube-proxy' && c.labelSelector?.includes('kube-proxy')) throw forbidden('pods')

  if (c.verb === 'apply') {
    const m = c.body as unknown as Applied
    if (m.kind === 'DaemonSet' && m.metadata.name === GVISOR_INSTALLER_APP_NAME) reach('ensureGvisorRuntime')
    if (m.kind === 'Deployment' && m.metadata.name === SERVER_APP_NAME) reach('deployServerWorkload')
    cluster.applied.push(m)
  }
  if (c.verb !== 'read' || !c.name) return
  const obj = fakeCluster.get(c.kind, c.name, c.namespace)
  if (!obj || obj.status) return
  if (c.kind === 'PersistentVolumeClaim') {
    const volumeName = (obj.spec as { volumeName?: string }).volumeName || `${c.name}-pv`
    fakeCluster.seed(
      { ...obj, spec: { ...obj.spec as object, volumeName }, status: { phase: 'Bound' } },
      {
        apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: volumeName },
        spec: { csi: { driver: 'nfs.csi.k8s.io', volumeHandle: volumeName } },
      },
    )
  } else if (c.kind === 'Pod') {
    fakeCluster.seed({ ...obj, status: { phase: 'Succeeded' } })
  } else if (c.kind === 'Ingress') {
    fakeCluster.seed({
      ...obj,
      status: { loadBalancer: { ingress: [{ hostname: 'yaac.tail.ts.net', ports: [{ port: 443 }] }] } },
    })
  }
}

/** The kind cluster's kube-system namespace, which identifies it. */
function kubeSystem(uid: string): FakeObject {
  return { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'kube-system', uid } }
}

/** The server Deployment's pod spec as applied. */
function serverPod(): { securityContext?: Record<string, number>; containers: Array<{ env: Array<{ name: string; value: string }> }> } {
  const dep = appliedOf('Deployment', SERVER_APP_NAME)[0] as unknown as {
    spec: { template: { spec: ReturnType<typeof serverPod> } }
  }
  return dep.spec.template.spec
}

/** The class each applied storage claim asks for. */
function claimClasses(): Record<string, unknown> {
  return Object.fromEntries(appliedOf('PersistentVolumeClaim')
    .map((m) => [m.metadata.name, m.spec?.storageClassName]))
}

beforeEach(() => {
  events.length = 0
  failing.clear()
  cluster.applied = []
  cluster.nodes = [{ podCIDR: '10.244.0.0/24', address: '10.89.0.2' }]
  cluster.pools = null
  cluster.poolsDenied = false
  cluster.adopt = null
  resetClusterCidrCache()
  fakeCluster.intercept(world)
  fakeCluster.seed(kubeSystem('uid-kind'))
  // The published server answers ready.
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(
    new Response(JSON.stringify({ ok: true, ready: true }), { status: 200 }),
  )))
})

import { ClusterInstallError, runClusterInstall } from '#drivers/k8s/install'
// Setup value and the deps type runClusterInstall takes.
import { CALICO_VERSION, type ClusterInstallDeps } from '#drivers/k8s/install/install'
import { nodeIpBlocks, resetClusterCidrCache } from '#drivers/k8s/cluster/cluster-cidrs'
import { apiError, fakeCluster, type ApiException, type FakeCall, type FakeObject } from '@yaac/test-utils/k8s-stub'
import { NODE_KUBELET_HOUSEKEEPING_INTERVAL } from '#drivers/k8s/install/check'
// Setup values: the installer DaemonSet's name, the server's names and
// node port (which the kind config reserves).
import { GVISOR_INSTALLER_APP_NAME } from '#drivers/k8s/install/gvisor-installer'
import {
  RUNTIME_CLASS_GVISOR,
  SERVER_APP_NAME,
  SERVER_FRONT_PORT,
  TAILSCALE_OPERATOR_NAMESPACE,
  nodeLocalNodePath,
} from '#drivers/k8s/substrate'
import { nodeLocalRoot } from '@yaac/shared/paths'
import { installRecordPath, readInstallRecord, recordInstall, type InstallRecord } from '@yaac/shared/install-record'
import { readServerConfig, serverConfigPath } from '@yaac/shared/server-config'
import { DEFAULT_CLUSTER_SERVER_PORT } from '@yaac/shared/server-port'

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await clearRecord()
})

/** Remove the install record, and its copy in `server.json`. */
async function clearRecord(): Promise<void> {
  await fs.rm(installRecordPath(), { force: true })
  await fs.rm(serverConfigPath(), { force: true })
}

/** Replace the install record outright, as a data dir would hold it. */
async function writeRecord(record: InstallRecord): Promise<void> {
  await clearRecord()
  await recordInstall(record)
}

type RunMock = ReturnType<typeof vi.fn<
  (file: string, args: string[], opts?: unknown) => Promise<{ stdout: string; stderr: string }>
>>

type StreamMock = ReturnType<typeof vi.fn<
  (file: string, args: string[], opts?: { env?: NodeJS.ProcessEnv; input?: string }) => Promise<void>
>>

/**
 * deps.run responses for a healthy linux host: podman 6 paired with a kind
 * release past the kind#4201 fix.
 */
function happyRun(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  if (file === 'podman' && args[0] === '--version') {
    return Promise.resolve({ stdout: 'podman version 6.0.0\n', stderr: '' })
  }
  if (file === 'kind' && args[0] === 'version') {
    return Promise.resolve({ stdout: 'kind v0.33.0 go1.24.4 linux/arm64\n', stderr: '' })
  }
  if (file === 'kind' && args[0] === 'get' && args[1] === 'clusters') {
    return Promise.resolve({ stdout: '', stderr: '' })
  }
  if (file === 'kind' && args[0] === 'get' && args[1] === 'nodes') {
    return Promise.resolve({ stdout: 'yaac-control-plane\n', stderr: '' })
  }
  if (file === 'podman' && args[0] === 'exec' && args.includes('uname')) {
    return Promise.resolve({ stdout: 'aarch64\n', stderr: '' })
  }
  // kubectl's current context is this machine's kind cluster, by name and
  // by apiserver.
  if (file === 'kubectl' && args[0] === 'config' && args[1] === 'current-context') {
    return Promise.resolve({ stdout: `kind-${process.env.YAAC_KIND_CLUSTER ?? 'yaac'}\n`, stderr: '' })
  }
  if ((file === 'kubectl' && args[0] === 'config' && args[1] === 'view')
    || (file === 'kind' && args[0] === 'get' && args[1] === 'kubeconfig')) {
    return Promise.resolve({ stdout: 'clusters:\n- cluster:\n    server: https://127.0.0.1:41234\n', stderr: '' })
  }
  return Promise.resolve({ stdout: '', stderr: '' })
}

/**
 * deps.run for a machine with no cluster yet: `kind get nodes` is empty on
 * the first call and lists the node afterwards, as a real create does.
 * Other tests use `happyRun`, where the cluster already exists.
 */
function freshRun(): RunMock {
  let asked = 0
  return vi.fn((file: string, args: string[]) => {
    if (file === 'kind' && args[0] === 'get' && args[1] === 'nodes') {
      asked += 1
      return asked === 1
        ? Promise.resolve({ stdout: '', stderr: '' })
        : Promise.resolve({ stdout: 'yaac-control-plane\n', stderr: '' })
    }
    return happyRun(file, args)
  })
}

/** Stand-in Calico manifest and its real checksum, so the pin verifies. */
const FAKE_CALICO_MANIFEST = 'kind: DaemonSet\nmetadata:\n  name: calico-node\n'
const FAKE_CALICO_SHA256 = crypto.createHash('sha256')
  .update(FAKE_CALICO_MANIFEST, 'utf8').digest('hex')

/**
 * Stand-in kind config in the shape the renderer needs: cluster-wide
 * settings first, then a final `nodes:` list with one control-plane entry
 * (with the $HOME extraMount) that `--nodes` copies into workers.
 */
const FAKE_KIND_CONFIG = [
  'kind: Cluster',
  'containerdConfigPatches:',
  '- |-',
  '  [plugins."io.containerd.grpc.v1.cri".registry]',
  '    config_path = "/etc/containerd/certs.d"',
  'nodes:',
  '- role: control-plane',
  '  extraMounts:',
  '  - hostPath: $HOME',
  '    containerPath: $HOME',
  '',
].join('\n')

/** readTextFile for the Calico checksum pin, the cached manifest and the kind config. */
function fakeCalicoReadTextFile(p: string): Promise<string | null> {
  if (p.endsWith('.sha256')) return Promise.resolve(`${FAKE_CALICO_SHA256}  calico.yaml\n`)
  if (p.includes('calico')) return Promise.resolve(FAKE_CALICO_MANIFEST)
  return Promise.resolve(FAKE_KIND_CONFIG)
}

function makeDeps(
  overrides: Omit<Partial<ClusterInstallDeps>, 'run' | 'runStreaming'> & {
    run?: RunMock
    runStreaming?: StreamMock
  } = {},
): ClusterInstallDeps & { run: RunMock; runStreaming: StreamMock } {
  const run = overrides.run ?? (vi.fn(happyRun))
  const runStreaming = overrides.runStreaming
    ?? (vi.fn(() => Promise.resolve()))
  return {
    run: run as unknown as ClusterInstallDeps['run'],
    runStreaming,
    log: overrides.log ?? vi.fn(),
    confirm: overrides.confirm ?? vi.fn().mockResolvedValue(false),
    platform: overrides.platform ?? 'linux',
    homedir: overrides.homedir ?? ((): string => '/home/tester'),
    totalmem: overrides.totalmem ?? ((): number => 64 * 1024 ** 3),
    cpuCount: overrides.cpuCount ?? ((): number => 10),
    // The kind config, the Calico checksum pin and a matching cached
    // manifest, so no download is attempted.
    readTextFile: overrides.readTextFile ?? vi.fn(fakeCalicoReadTextFile),
    writeTextFile: overrides.writeTextFile ?? vi.fn().mockResolvedValue(undefined),
    fetchText: overrides.fetchText ?? vi.fn().mockResolvedValue(FAKE_CALICO_MANIFEST),
    listDir: overrides.listDir ?? vi.fn().mockResolvedValue([]),
  } as ClusterInstallDeps & { run: RunMock; runStreaming: StreamMock }
}

// ---------------------------------------------------------------------------
// --byo fixtures
// ---------------------------------------------------------------------------

/** The flags a byo install is run with, unless a case says otherwise. */
const BYO = { byo: true, rwxStorageClass: 'byo-nfs' } as const

/** This machine's architecture as Kubernetes names it. */
const HOST_ARCH = process.arch === 'x64' ? 'amd64' : process.arch

/** The StorageClasses a byo cluster serves: an NFS class and a default block one. */
const BYO_CLASSES = [
  { metadata: { name: 'byo-nfs' }, provisioner: 'nfs.csi.k8s.io', parameters: { server: 'nfs.example' } },
  {
    metadata: { name: 'standard', annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } },
    provisioner: 'ebs.csi.aws.com',
  },
]

/** A fully rolled-out calico-node DaemonSet in the iptables dataplane. */
const HEALTHY_CALICO_DS = {
  status: { numberReady: 1, desiredNumberScheduled: 1 },
  spec: { template: { spec: { containers: [{ name: 'calico-node', env: [] }] } } },
}

/** Real kind-node `ip -4 route show`, as netd's exec returns it. */
const ADOPT_ROUTES = [
  'default via 10.89.0.1 dev eth0',
  'blackhole 10.244.169.192/26 proto 80',
  '10.244.169.193 dev calibb6b64b7901 scope link',
  '10.244.169.197 dev calia132c78e002 scope link',
].join('\n')

/** The single-node fleet the fixtures describe, unless a case says otherwise. */
const ADOPT_NODES = ['yaac-control-plane']

interface AdoptFacts {
  /** calico-node DaemonSet; `null` means the cluster has none. */
  calico?: object | null
  /** The namespace calico-node runs in (default `kube-system`). */
  calicoNamespace?: string
  /** FelixConfiguration objects; omitted means none is served (Felix defaults). */
  felix?: object[]
  /** kube-proxy pods, keyed by the label that finds them (default `k8s-app`). */
  kubeProxyPods?: Array<{ spec?: { nodeName?: string }; status?: { phase?: string } }>
  /** Which label selector answers — GKE/AKS stamp `component`, not `k8s-app`. */
  kubeProxyLabel?: 'k8s-app' | 'component'
  /** `false` removes the system-node-critical PriorityClass. */
  systemNodeCritical?: boolean
  /** Node names, and whether each is schedulable (taint-free / uncordoned). */
  nodes?: Array<{ name: string; schedulable?: boolean; taint?: string }>
  /** `scheduling.tolerations` on the gvisor RuntimeClass. */
  tolerations?: Array<Record<string, string>>
  /** netd pods to probe; omitted means one Running per node. */
  netdPods?: Array<{ name: string; node: string; phase?: string }>
  /** `ip -4 route show` per netd pod name; a string applies to all. */
  routes?: string | null | Record<string, string | null>
  /** `false` takes kind off PATH — adopt mode must not need it. */
  kind?: boolean
  /** A kubectl read that fails for a reason that is NOT genuine absence. */
  denied?: 'felix' | 'kube-proxy' | 'nodes' | 'calico'
  /** `status.nodeInfo` fields to override on every node. */
  nodeInfo?: Record<string, string>
  /** The StorageClasses the cluster serves (default BYO_CLASSES). */
  classes?: object[]
  /** A server Deployment already in the namespace, and whose it is. */
  deployed?: { installId?: string; dataDir: string }
  /** The current context's cluster: its kube-system namespace's uid. */
  clusterUid?: string
  /** kubectl's current context (default `byo-context`). */
  context?: string
}

/** The Tailscale operator's objects, which `--tailnet` and `--byo` look for. */
const OPERATOR: FakeObject[] = [
  { apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: 'proxyclasses.tailscale.com' } },
  { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'operator', namespace: TAILSCALE_OPERATOR_NAMESPACE } },
  { apiVersion: 'networking.k8s.io/v1', kind: 'IngressClass', metadata: { name: 'tailscale' } },
]

/**
 * Stage the `--byo` cluster `facts` describe in the fake cluster (with the
 * Tailscale operator installed), and return deps.run answering the host
 * side: the kubeconfig's context and the netd route reads. Absence is a
 * missing object, which the checks must tell apart from a denied read.
 */
function adoptRun(facts: AdoptFacts = {}): RunMock {
  cluster.adopt = facts
  const nodes: NonNullable<AdoptFacts['nodes']> =
    facts.nodes ?? ADOPT_NODES.map((name) => ({ name }))
  const netdPods: NonNullable<AdoptFacts['netdPods']> = facts.netdPods
    ?? nodes.map((n, i) => ({ name: `yaac-netd-${String(i)}`, node: n.name }))
  const label = facts.kubeProxyLabel ?? 'k8s-app'

  replaceKind('DaemonSet', facts.calico === null ? [] : [{
    apiVersion: 'apps/v1', kind: 'DaemonSet',
    metadata: { name: 'calico-node', namespace: facts.calicoNamespace ?? 'kube-system' },
    ...(facts.calico ?? HEALTHY_CALICO_DS),
  }])
  replaceKind('FelixConfiguration', (facts.felix ?? []).map((f, i) => ({
    apiVersion: 'crd.projectcalico.org/v1', kind: 'FelixConfiguration', metadata: { name: `felix-${String(i)}` }, ...f,
  })))
  replaceKind('Pod', [
    ...(facts.kubeProxyPods ?? nodes.map((n) => ({ spec: { nodeName: n.name }, status: { phase: 'Running' } })))
      .map((pod, i) => ({
        apiVersion: 'v1', kind: 'Pod',
        metadata: { name: `kube-proxy-${String(i)}`, namespace: 'kube-system', labels: { [label]: 'kube-proxy' } },
        ...pod,
      })),
    ...netdPods.map((pod) => ({
      apiVersion: 'v1', kind: 'Pod',
      metadata: { name: pod.name, namespace: 'test-ns', labels: { app: 'yaac-netd' } },
      spec: { nodeName: pod.node },
      status: { phase: pod.phase ?? 'Running' },
    })),
  ])
  replaceKind('PriorityClass', facts.systemNodeCritical === false ? [] : [
    { apiVersion: 'scheduling.k8s.io/v1', kind: 'PriorityClass', metadata: { name: 'system-node-critical' } },
  ])
  replaceKind('RuntimeClass', [{
    apiVersion: 'node.k8s.io/v1', kind: 'RuntimeClass', metadata: { name: RUNTIME_CLASS_GVISOR },
    scheduling: { tolerations: facts.tolerations ?? [] },
  }])
  replaceKind('StorageClass', (facts.classes ?? BYO_CLASSES).map((c) => ({
    apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', ...c as { metadata: { name: string } },
  })))
  replaceKind('Deployment', [
    ...OPERATOR.filter((o) => o.kind === 'Deployment'),
    ...facts.deployed === undefined ? [] : [{
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: {
        name: SERVER_APP_NAME, namespace: 'test-ns',
        labels: facts.deployed.installId ? { 'yaac.install-id': facts.deployed.installId } : {},
      },
      spec: { template: { spec: { containers: [{
        name: 'server', env: [{ name: 'YAAC_DATA_DIR', value: facts.deployed.dataDir }],
      }] } } },
    }],
  ])
  fakeCluster.seed(...OPERATOR, kubeSystem(facts.clusterUid ?? 'uid-byo'))

  return vi.fn((file: string, args: string[]) => {
    if (file === 'kind' && facts.kind === false) return Promise.reject(new Error('ENOENT'))
    if (file === 'kubectl' && args[0] === 'config' && args[1] === 'current-context') {
      return Promise.resolve({ stdout: `${facts.context ?? 'byo-context'}\n`, stderr: '' })
    }
    if (file === 'kubectl' && args[0] === 'exec') {
      const pod = args[1]
      const routes = typeof facts.routes === 'object' && facts.routes !== null
        ? facts.routes[pod]
        : facts.routes
      return routes === null
        ? Promise.reject(new Error('unable to upgrade connection: container not found'))
        : Promise.resolve({ stdout: routes ?? ADOPT_ROUTES, stderr: '' })
    }
    return happyRun(file, args)
  })
}

/** Stage the pod-CIDR sources: Calico's IPPools and the nodes' podCIDRs. */
function stageAdoptCidrs(opts: { pools?: string[]; nodeCidrs?: string[] } = {}): void {
  resetClusterCidrCache()
  cluster.pools = opts.pools ?? ['192.168.0.0/16']
  cluster.poolsDenied = false
  const podCidrs = opts.nodeCidrs ?? ['10.244.0.0/24']
  // A node without a podCIDR still has an address.
  cluster.nodes = podCidrs.length === 0
    ? [{ address: '10.89.0.2' }]
    : podCidrs.map((podCIDR, i) => ({ podCIDR, address: `10.89.0.${String(i + 2)}` }))
}

/**
 * deps.run for an existing cluster with the Tailscale operator present,
 * absent, or unknown (the apiserver not answering).
 */
function tailnetRun(operator: 'present' | 'absent' | 'unreachable'): RunMock {
  if (operator === 'present') fakeCluster.seed(...OPERATOR)
  if (operator === 'unreachable') {
    fakeCluster.intercept((c) => {
      if (OPERATOR.some((o) => o.kind === c.kind && o.metadata.name === c.name)) {
        throw new Error('connect ECONNREFUSED 127.0.0.1:6443')
      }
    })
  }
  return vi.fn(happyRun)
}

/** Stand-in operator manifest in the upstream shape, and its checksum. */
const FAKE_OPERATOR_MANIFEST = [
  'apiVersion: v1', 'kind: Namespace', 'metadata:', '  name: tailscale', '---',
  'apiVersion: v1', 'kind: Secret', 'metadata:', '  name: operator-oauth', '  namespace: tailscale',
  'stringData:', '  client_id: # SET CLIENT ID HERE', '---',
  'apiVersion: apiextensions.k8s.io/v1', 'kind: CustomResourceDefinition', 'metadata:',
  '  name: proxyclasses.tailscale.com', '---',
  'apiVersion: apps/v1', 'kind: Deployment', 'metadata:', '  name: operator', '  namespace: tailscale',
  'spec:', '  template:', '    spec:', '      containers:', '      - image: tailscale/k8s-operator:stable',
  '        env:', '        - name: OPERATOR_HOSTNAME', '          value: tailscale-operator',
  '        - name: OPERATOR_LOGIN_SERVER', '          value: null',
  '        - name: PROXY_IMAGE', '          value: tailscale/tailscale:stable', '---',
  'apiVersion: networking.k8s.io/v1', 'kind: IngressClass', 'metadata:', '  name: tailscale', '',
].join('\n')
const FAKE_OPERATOR_SHA256 = crypto.createHash('sha256').update(FAKE_OPERATOR_MANIFEST, 'utf8').digest('hex')

/** readTextFile serving the operator pin, with no cached copy, over the Calico reads. */
function operatorReads(sha = FAKE_OPERATOR_SHA256) {
  return vi.fn((p: string) => p.endsWith('operator.yaml.sha256')
    ? Promise.resolve(`${sha}  operator.yaml\n`)
    : p.includes('tailscale-operator-') ? Promise.resolve(null) : fakeCalicoReadTextFile(p))
}

/** An object as a yaac install applied it. */
function yaacManaged(o: FakeObject): FakeObject {
  return { ...o, metadata: { ...o.metadata, labels: { 'app.kubernetes.io/managed-by': 'yaac' } } }
}

function operatorFetch() {
  return vi.fn((url: string) => Promise.resolve(
    url.includes('k8s-operator') ? FAKE_OPERATOR_MANIFEST : FAKE_CALICO_MANIFEST,
  ))
}

/** Everything install logged, joined. */
function logged(deps: { log: unknown }): string {
  return vi.mocked(deps.log as (m: string) => void).mock.calls.map(([m]) => m).join('\n')
}

/** readTextFile serving the committed pin, plus whatever else a case wants. */
function calicoReads(rest: (p: string) => string | null) {
  return vi.fn((p: string) => Promise.resolve(
    p.endsWith('.sha256')
      ? `${FAKE_CALICO_SHA256}  calico.yaml\n`
      : p.includes('calico')
        ? rest(p)
        : FAKE_KIND_CONFIG,
  ))
}

describe('runClusterInstall', () => {
  // Workspaces fall back to npmjs, so a failed cache is only a note.
  it('finishes the install when the npm cache cannot be deployed', async () => {
    const log = vi.fn()
    failing.set('ensureNpmCache', 'claim Pending')
    const deps = makeDeps({ run: freshRun(), log })
    await expect(runClusterInstall({}, deps)).resolves.toBeUndefined()
    expect(ran('deployServerWorkload')).toBe(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not deploy the npm cache (claim Pending)'))
  })

  it('creates the cluster and installs everything on a host that has none', async () => {
    const deps = makeDeps({ run: freshRun() })
    await runClusterInstall({}, deps)

    // The registry is an in-cluster Deployment, so it comes after the
    // cluster exists.
    expect(ran('ensureMainRegistry')).toBe(1)
    expect(ran('ensureBuilderRoleGuard')).toBe(1)
    // netd is deployed before the check, so the datapath check has
    // something to verify.
    expect(ran('ensureNetd')).toBe(1)
    // A pod naming a missing PriorityClass is rejected, so install creates
    // them.
    expect(ran('ensurePriorityClasses')).toBe(1)

    // Built-in images are pushed after the registry exists and before the
    // layers that use them.
    expect(ran('buildBuiltinImages')).toBe(1)
    expect(order('buildBuiltinImages'))
      .toBeGreaterThan(order('ensureMainRegistry'))
    expect(order('buildBuiltinImages'))
      .toBeLessThan(order('ensureNetd'))

    // Created from the bundled config under the podman provider, and nothing
    // deleted: install converges an existing cluster rather than replacing
    // it.
    const runCalls = deps.run.mock.calls
    expect(runCalls.some(([f, a]) => f === 'kind' && a[0] === 'delete')).toBe(false)
    const createCall = deps.runStreaming.mock.calls.find(([f, a]) => f === 'kind' && a[0] === 'create')
    expect(createCall).toBeDefined()
    expect(createCall?.[2]?.input).toContain('/home/tester')
    expect(createCall?.[2]?.input).not.toContain('$HOME')
    // The config carries the server's port mapping. kind sets mappings only
    // at create, which is why an older cluster is refused.
    expect(createCall?.[2]?.input).toContain(`containerPort: ${String(SERVER_FRONT_PORT)}`)
    // Apart from the host server's port, so the two installs coexist.
    expect(createCall?.[2]?.input).toContain(`hostPort: ${String(DEFAULT_CLUSTER_SERVER_PORT)}`)
    expect(createCall?.[2]?.input).toContain('listenAddress: 127.0.0.1')

    // The server is deployed last, after everything it uses, published on
    // the kind node's port rather than through an Ingress.
    expect(ran('deployServerWorkload')).toBe(1)
    expect(appliedOf('Ingress')).toEqual([])
    expect(await readServerConfig()).toMatchObject({ url: `http://127.0.0.1:${String(DEFAULT_CLUSTER_SERVER_PORT)}` })
    expect(order('deployServerWorkload'))
      .toBeGreaterThan(order('ensureNetd'))
    expect(createCall?.[2]?.env?.KIND_EXPERIMENTAL_PROVIDER).toBe('podman')

    // The npm cache, after its image is mirrored and before the server.
    expect(ran('ensureNpmCache')).toBe(1)
    expect(order('ensureNpmCache'))
      .toBeGreaterThan(order('buildBuiltinImages'))
    expect(order('ensureNpmCache'))
      .toBeLessThan(order('deployServerWorkload'))

    // Calico is applied from the verified manifest, then the node must go
    // Ready (it cannot before the CNI is up).
    const calicoApply = deps.runStreaming.mock.calls
      .find(([f, a]) => f === 'kubectl' && a.includes('apply') && a.includes('-f'))
    expect(calicoApply?.[2]?.input).toContain('calico-node')
    expect(runCalls.some(([f, a]) =>
      f === 'kubectl' && a.includes('rollout') && a.includes('daemonset/calico-node'))).toBe(true)
    expect(runCalls.some(([f, a]) => f === 'kubectl' && a.includes('--for=condition=Ready'))).toBe(true)

    // The kind node fixups: the kubelet housekeeping flag via podman exec,
    // then the node container's pids limit. Sysctls and TasksMax belong to
    // the installer DaemonSet, and registry wiring to in-cluster pods.
    const execCmds = runCalls
      .filter(([f, a]) => f === 'podman' && a[0] === 'exec')
      .map(([, a]) => a[a.length - 1])
    expect(execCmds.some((c) => c.includes('hosts.toml'))).toBe(false)
    expect(execCmds.some((c) => c.includes('DefaultTasksMax'))).toBe(false)
    expect(execCmds.some((c) => c.includes('min_free_kbytes'))).toBe(false)
    expect(execCmds.some((c) => c.includes('inotify'))).toBe(false)
    // Idempotent kubeadm-flags.env edit; kubelet restarts only if the flag
    // was missing.
    expect(execCmds.some((c) =>
      c.includes(`--housekeeping-interval=${NODE_KUBELET_HOUSEKEEPING_INTERVAL}`)
      && c.includes('/var/lib/kubelet/kubeadm-flags.env')
      && c.includes('systemctl restart kubelet'))).toBe(true)
    expect(runCalls.some(([f, a]) => f === 'podman' && a[0] === 'update' && a.includes('32768'))).toBe(true)
    expect(runCalls.some(([f, a]) => f === 'podman' && a[0] === 'network')).toBe(false)

    // gVisor comes from an in-cluster DaemonSet, so install never touches a
    // node for it.
    expect(ran('ensureGvisorRuntime')).toBe(1)
    expect(runCalls.some(([f]) => f === 'sh')).toBe(false)
    expect(runCalls.some(([f, a]) => f === 'podman' && a[0] === 'cp')).toBe(false)
    expect(execCmds.some((c) => c.includes('runsc') || c.includes('restart containerd'))).toBe(false)
    // After the registry, since its image is mirrored there (as netd's is).
    const gvisorOrder = order('ensureGvisorRuntime')
    const registryOrder = order('ensureMainRegistry')
    expect(gvisorOrder).toBeGreaterThan(registryOrder)

  })

  // Every layer but the npm cache is fatal: a missing PriorityClass gets
  // every pod naming it rejected, every image goes through the registry,
  // and nothing else builds the images, guards builder pods or redirects
  // workspace egress.
  it.each([
    'ensurePriorityClasses',
    'ensureMainRegistry',
    'ensureBuilderRoleGuard',
    'buildBuiltinImages',
    'ensureGvisorRuntime',
    'ensureNetd',
    'deployServerWorkload',
  ] as const)('stops at a failed %s', async (step) => {
    failing.set(step, 'apiserver said no')
    await expect(runClusterInstall({}, makeDeps())).rejects.toThrow('apiserver said no')
    expect(events.at(-1)).toBe(step)
  })

  it('honors YAAC_KIND_CLUSTER for every kind invocation', async () => {
    vi.stubEnv('YAAC_KIND_CLUSTER', 'yaac-alt')
    const deps = makeDeps({ run: freshRun() })
    await runClusterInstall({}, deps)
    const kindCalls = deps.run.mock.calls.filter(([f]) => f === 'kind')
    expect(kindCalls.some(([, a]) => a.join(' ') === 'get nodes --name yaac-alt')).toBe(true)
    expect(deps.runStreaming.mock.calls.some(([f, a]) =>
      f === 'kind' && a.join(' ').includes('create cluster --name yaac-alt'))).toBe(true)
  })

  it("hands the server pod the host's IPv4 gateway on a dual-stack kind network", async () => {
    vi.stubEnv('YAAC_USE_TOR', '1')
    // A dual-stack kind network has a gateway per family; only the IPv4 one
    // works as the host address for Tor.
    const deps = makeDeps({
      run: vi.fn((file: string, args: string[]) => (
        file === 'podman' && args[0] === 'network' && args[1] === 'inspect'
          ? Promise.resolve({ stdout: 'fd00:4:3:2::1 10.89.0.1 \n', stderr: '' })
          : happyRun(file, args)
      )),
    })

    await runClusterInstall({}, deps)

    const torUrl = (): string | undefined =>
      serverPod().containers[0].env.find((e) => e.name === 'YAAC_HOST_TOR_SOCKS_URL')?.value
    expect(torUrl()).toContain('10.89.0.1')
    expect(logged(deps)).not.toContain('could not be determined')
  })

  it('notes a degraded Tor setup when the kind network has no IPv4 gateway', async () => {
    vi.stubEnv('YAAC_USE_TOR', '1')
    const deps = makeDeps({
      run: vi.fn((file: string, args: string[]) => (
        file === 'podman' && args[0] === 'network' && args[1] === 'inspect'
          ? Promise.resolve({ stdout: 'fd00:4:3:2::1 \n', stderr: '' })
          : happyRun(file, args)
      )),
    })

    await runClusterInstall({}, deps)

    // The install still finishes; the pod keeps its configured SOCKS URL.
    const torUrl = serverPod().containers[0].env.find((e) => e.name === 'YAAC_HOST_TOR_SOCKS_URL')?.value
    expect(torUrl).toBeDefined()
    expect(torUrl).not.toContain('10.89.0.1')
    expect(logged(deps)).toContain('could not be determined')
  })

  it('renders one worker per extra --nodes, each carrying the home extraMount', async () => {
    const deps = makeDeps({ run: freshRun() })
    await runClusterInstall({ nodes: 3 }, deps)

    const input = deps.runStreaming.mock.calls
      .find(([f, a]) => f === 'kind' && a[0] === 'create')?.[2]?.input ?? ''
    // One control plane and two workers copied from it, so every node gets
    // the $HOME bind that keeps hostPaths consistent.
    expect(input.match(/^- role: control-plane$/gm)).toHaveLength(1)
    expect(input.match(/^- role: worker$/gm)).toHaveLength(2)
    expect(input.match(/hostPath: \/home\/tester$/gm)).toHaveLength(3)
    // Each node also gets the node-local bind.
    expect(input.match(new RegExp(`hostPath: ${nodeLocalRoot()}$`, 'gm'))).toHaveLength(3)
    expect(input.match(new RegExp(`containerPath: ${nodeLocalNodePath()}$`, 'gm'))).toHaveLength(3)
    expect(input).not.toContain('$HOME')
    // Cluster-wide settings are not duplicated; kind applies them to all
    // nodes.
    expect(input.match(/config_path/g)).toHaveLength(1)
  })

  it('applies the container-side node fixups to every node of a multi-node cluster', async () => {
    let asked = 0
    const run = vi.fn((file: string, args: string[]) => {
      if (file === 'kind' && args[0] === 'get' && args[1] === 'nodes') {
        asked += 1
        return Promise.resolve({
          stdout: asked === 1 ? '' : 'yaac-control-plane\nyaac-worker\nyaac-worker2\n',
          stderr: '',
        })
      }
      return happyRun(file, args)
    }) as RunMock
    const deps = makeDeps({ run })
    await runClusterInstall({ nodes: 3 }, deps)

    const allNodes = ['yaac-control-plane', 'yaac-worker', 'yaac-worker2']
    // The fixups are per node, so each node gets them.
    const fixupWrites = run.mock.calls
      .filter(([f, a]) => f === 'podman' && a[0] === 'exec'
        && String(a[a.length - 1]).includes('--housekeeping-interval='))
      .map(([, a]) => a[1])
    expect(fixupWrites).toEqual(allNodes)
    // Registry hosts.toml is written by in-cluster pods that cover every node
    // (see main-registry.test.ts), never by a node exec.
    expect(run.mock.calls.some(([f, a]) => f === 'podman' && a[0] === 'exec'
      && String(a[a.length - 1]).includes('hosts.toml'))).toBe(false)
    // The pids limit is set on each node container.
    expect(run.mock.calls
      .filter(([f, a]) => f === 'podman' && a[0] === 'update' && a.includes('32768'))
      .map(([, a]) => a[a.length - 1])).toEqual(allNodes)
    // gVisor is a DaemonSet that covers every node, including later ones, so
    // it is applied once. `cluster check`'s per-node check verifies it.
    expect(ran('ensureGvisorRuntime')).toBe(1)
    expect(run.mock.calls.some(([f, a]) =>
      f === 'podman' && a[0] === 'cp' && String(a[2]).includes('/runsc'))).toBe(false)
  })

  it('rejects a --nodes value it cannot honor before touching the host', async () => {
    // The message quotes the raw input, not "NaN".
    for (const nodes of [0, 99, 2.5, 'three']) {
      const deps = makeDeps()
      const err = await runClusterInstall({ nodes }, deps).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ClusterInstallError)
      expect((err as Error).message).toContain('between 1 and 5')
      expect((err as Error).message).toContain(`"${nodes}"`)
      expect(deps.run).not.toHaveBeenCalled()
      expect(ran('ensureMainRegistry')).toBe(0)
    }
  })

  it.each(['linux', 'darwin'] as const)('reports every missing binary at once on %s', async (platform) => {
    const run = vi.fn((file: string) => {
      if (file === 'podman' || file === 'kind' || file === 'kubectl') {
        return Promise.reject(new Error('ENOENT'))
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }) as RunMock
    const deps = makeDeps({ run, platform })
    const err = await runClusterInstall({}, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterInstallError)
    const msg = (err as Error).message
    expect(msg).toContain('Missing required tools')
    expect(msg).toContain('podman')
    expect(msg).toContain('kind')
    expect(msg).toContain('kubectl')
    if (platform === 'darwin') {
      expect(msg).toContain('brew install bsklaroff/yaac/yaac-cluster')
      expect(msg).not.toContain('apt install')
    } else {
      expect(msg).not.toContain('brew')
    }
    expect(ran('ensureMainRegistry')).toBe(0)
    expect(deps.runStreaming).not.toHaveBeenCalled()
  })

  it.each(['5.8.1', '6.0.0'])('refuses kind <= v0.32.0 under podman %s before touching anything', async (podman) => {
    const run = vi.fn((file: string, args: string[]) => {
      if (file === 'podman' && args[0] === '--version') {
        return Promise.resolve({ stdout: `podman version ${podman}\n`, stderr: '' })
      }
      if (file === 'kind' && args[0] === 'version') {
        return Promise.resolve({ stdout: 'kind v0.32.0 go1.24.4 darwin/arm64\n', stderr: '' })
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }) as RunMock
    const deps = makeDeps({ run })
    const err = await runClusterInstall({}, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterInstallError)
    expect((err as Error).message).toContain('v0.33.0 or newer')
    expect((err as Error).message).toContain('brew upgrade kind')
    expect(ran('ensureMainRegistry')).toBe(0)
  })

  it('surfaces a functional preflight failure with the kind stderr', async () => {
    const run = vi.fn((file: string, args: string[]) => {
      if (file === 'podman' && args[0] === '--version') {
        return Promise.resolve({ stdout: 'podman version 5.8.1\n', stderr: '' })
      }
      if (file === 'kind' && args[0] === 'version') {
        return Promise.resolve({ stdout: 'kind v0.33.0 go1.24.4 linux/arm64\n', stderr: '' })
      }
      if (file === 'kind' && args[0] === 'get' && args[1] === 'clusters') {
        return Promise.reject(Object.assign(new Error('exit 125'), { stderr: 'cannot connect to podman' }))
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }) as RunMock
    const err = await runClusterInstall({}, makeDeps({ run })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterInstallError)
    expect((err as Error).message).toContain('kind get clusters')
    expect((err as Error).message).toContain('cannot connect to podman')
  })

  it('fails with the rootful-podman fix when the rootful socket is unreachable', async () => {
    const run = vi.fn((file: string, args: string[]) => {
      if (file === 'podman' && args[0] === '--version') {
        return Promise.resolve({ stdout: 'podman version 6.0.0\n', stderr: '' })
      }
      if (file === 'kind' && args[0] === 'version') {
        return Promise.resolve({ stdout: 'kind v0.33.0 go1.24.4 linux/arm64\n', stderr: '' })
      }
      if (file === 'podman' && args[0] === 'info') {
        return Promise.reject(Object.assign(new Error('exit 125'), { stderr: 'cannot connect' }))
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }) as RunMock
    const err = await runClusterInstall({}, makeDeps({ run, platform: 'linux' })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterInstallError)
    expect((err as Error).message).toContain('systemctl enable --now podman.socket')
  })

  it('drops the CIDR caches so a long-lived process cannot render for the old cluster', async () => {
    // A cluster can be deleted and recreated in one process. Cached node
    // addresses would then be dead and cached pod CIDRs wrong, so the cache
    // is reset.
    resetClusterCidrCache()
    cluster.nodes = [{ address: '10.89.0.7' }]
    expect(await nodeIpBlocks()).toEqual(['10.89.0.7/32'])

    // The cluster is recreated with the node at a new address.
    cluster.nodes = [{ address: '10.89.0.9' }]
    await runClusterInstall({}, makeDeps({ run: freshRun() }))

    // The server's ingress policy admits the new address, not the cached one.
    expect(await nodeIpBlocks()).toEqual(['10.89.0.9/32'])
    expect(JSON.stringify(appliedOf('NetworkPolicy'))).toContain('10.89.0.9/32')
    expect(JSON.stringify(appliedOf('NetworkPolicy'))).not.toContain('10.89.0.7/32')
  })

  it('admits every node by tunnel address as well as InternalIP', async () => {
    // Calico sends cross-node host-to-pod traffic from the node's tunnel
    // address, not its InternalIP, so a policy naming only InternalIPs drops
    // netd's Envoy on cross-node hops. This never shows on a single node.
    resetClusterCidrCache()
    cluster.nodes = [
      { address: '10.89.0.21', annotations: { 'projectcalico.org/IPv4IPIPTunnelAddr': '10.244.93.192' } },
      { address: '10.89.0.20', annotations: { 'projectcalico.org/IPv4VXLANTunnelAddr': '10.244.86.128' } },
      // A node without a tunnel address yet still contributes its InternalIP.
      { address: '10.89.0.19' },
    ]

    expect(await nodeIpBlocks()).toEqual([
      '10.244.86.128/32', '10.244.93.192/32',
      '10.89.0.19/32', '10.89.0.20/32', '10.89.0.21/32',
    ])
  })

  it('converging drops the CIDR caches too — a moved node address is why you re-run', async () => {
    resetClusterCidrCache()
    cluster.nodes = [{ address: '10.89.0.7' }]
    expect(await nodeIpBlocks()).toEqual(['10.89.0.7/32'])

    cluster.nodes = [{ address: '10.89.0.9' }]
    await runClusterInstall({}, makeDeps())

    expect(await nodeIpBlocks()).toEqual(['10.89.0.9/32'])
    expect(JSON.stringify(appliedOf('NetworkPolicy'))).not.toContain('10.89.0.7/32')
  })

  it('converges an existing cluster in place — never recreating it', async () => {
    const deps = makeDeps()
    await runClusterInstall({}, deps)

    expect(ran('ensureMainRegistry')).toBe(1)
    expect(ran('ensureBuilderRoleGuard')).toBe(1)
    // Re-applied on every run, which is how an existing cluster picks up yaac
    // upgrades. Install still owns only the kind node container settings (pids
    // limit, kubelet flag); the installer DaemonSet does the rest per node.
    expect(ran('ensureNetd')).toBe(1)
    expect(ran('ensurePriorityClasses')).toBe(1)
    expect(ran('ensureGvisorRuntime')).toBe(1)
    expect(ran('buildBuiltinImages')).toBe(1)
    // No delete, create or Calico, so re-running install on a cluster with
    // live workspaces is safe.
    expect(deps.run.mock.calls.some(([f, a]) => f === 'kind' && a[0] === 'delete')).toBe(false)
    expect(deps.runStreaming).not.toHaveBeenCalled()
    expect(deps.run.mock.calls.some(([f, a]) => f === 'podman' && a[0] === 'exec')).toBe(true)
  })

  it('starts a node a host reboot left stopped, and waits for its API server', async () => {
    vi.useFakeTimers()
    try {
      // kind nodes have no restart policy, so after a reboot the node is Exited
      // and its apiserver answers only once it is started.
      let readyzAsked = 0
      const deps = makeDeps({
        run: vi.fn((file: string, args: string[]) => {
          if (file === 'podman' && args[0] === 'inspect') {
            return Promise.resolve({ stdout: 'false\n', stderr: '' })
          }
          if (file === 'kubectl' && args.includes('/readyz') && ++readyzAsked < 3) {
            return Promise.reject(new Error('connection refused'))
          }
          return happyRun(file, args)
        }),
      })
      const install = runClusterInstall({}, deps)
      // Install first reads its record from disk (real I/O), so advance the
      // clock once polling has started.
      await vi.waitFor(() => { expect(readyzAsked).toBeGreaterThan(0) })
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(install).resolves.toBeUndefined()

      const calls = deps.run.mock.calls.map(([f, a]) => `${f} ${a.join(' ')}`)
      const started = calls.indexOf('podman start yaac-control-plane')
      expect(started).toBeGreaterThanOrEqual(0)
      expect(calls.findIndex((c) => c.startsWith('podman exec'))).toBeGreaterThan(started)
      expect(readyzAsked).toBe(3)
      expect(logged(deps)).toMatch(/Starting the stopped kind node yaac-control-plane/)

      const running = makeDeps()
      await runClusterInstall({}, running)
      expect(running.run.mock.calls.some(([f, a]) => f === 'podman' && a[0] === 'start')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses when the API server never comes back', async () => {
    vi.useFakeTimers()
    try {
      const deps = makeDeps({
        run: vi.fn((file: string, args: string[]) => (
          file === 'kubectl' && args.includes('/readyz')
            ? Promise.reject(new Error('connection refused'))
            : happyRun(file, args)
        )),
      })
      const refused = expect(runClusterInstall({}, deps)).rejects.toThrow(ClusterInstallError)
      await vi.waitFor(() => {
        expect(deps.run.mock.calls.some(([, a]) => a.includes('/readyz'))).toBe(true)
      })
      await vi.advanceTimersByTimeAsync(300_000)
      await refused
      expect(ran('ensurePriorityClasses')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lands layers only on this machine\'s kind cluster, and records it before the first', async () => {
    // Another context name, and the right name pointing at another apiserver:
    // both refused before anything is applied.
    for (const [context, server] of [['prod', 'https://127.0.0.1:41234'], ['kind-yaac', 'https://10.0.0.5:6443']]) {
      const deps = makeDeps({
        run: vi.fn((file: string, args: string[]) => {
          if (file === 'kubectl' && args[1] === 'current-context') return Promise.resolve({ stdout: `${context}\n`, stderr: '' })
          if (file === 'kubectl' && args[1] === 'view') return Promise.resolve({ stdout: `server: ${server}\n`, stderr: '' })
          return happyRun(file, args)
        }),
      })
      const err = await runClusterInstall({}, deps).catch((e: unknown) => e)
      expect((err as Error).message).toMatch(/every layer would go to the wrong cluster[\s\S]*kind export kubeconfig --name yaac/)
      expect(ran('ensurePriorityClasses')).toBe(0)
    }
    expect(await readInstallRecord()).toBeNull()

    // A kind cluster re-created under the same install is recorded again.
    await writeRecord({ driver: 'k8s', installId: 'kind-one', clusterUid: 'uid-gone' })
    await expect(runClusterInstall({}, makeDeps())).resolves.toBeUndefined()
    expect(await readInstallRecord()).toMatchObject({ installId: 'kind-one', clusterUid: 'uid-kind', kubeContext: 'kind-yaac' })
  })

  it('notes that --nodes cannot change an existing cluster, and converges anyway', async () => {
    // The node count is fixed at create, but re-running with the original
    // flags must still work, so this is only a note.
    const deps = makeDeps()
    await expect(runClusterInstall({ nodes: 3 }, deps)).resolves.toBeUndefined()
    expect(logged(deps)).toMatch(/--nodes is ignored/)
    expect(deps.runStreaming).not.toHaveBeenCalled()
    expect(ran('ensureMainRegistry')).toBe(1)
  })

  it.each([
    ['a kind release', 'kind v0.33.0 go1.24 linux/amd64\n'],
    ['a v0.33 pre-release build', 'kind v0.33.0-alpha+f1ec7694f59f57 go1.24 linux/arm64\n'],
    ['unparseable version output', 'garbage\n'],
  ])('leaves %s to the functional probe', async (_label, kindOut) => {
    const deps = makeDeps({
      run: vi.fn((file: string, args: string[]) => {
        if (file === 'kind' && args[0] === 'version') {
          return Promise.resolve({ stdout: kindOut, stderr: '' })
        }
        return happyRun(file, args)
      }),
    })
    await expect(runClusterInstall({}, deps)).resolves.toBeUndefined()
  })

  it('runs every kind invocation under the podman provider, host env forwarded', async () => {
    const deps = makeDeps()
    await runClusterInstall({}, deps)
    const envs = [...deps.run.mock.calls, ...deps.runStreaming.mock.calls]
      .filter(([f]) => f === 'kind')
      .map(([, , opts]) => (opts as { env?: NodeJS.ProcessEnv } | undefined)?.env)
      .filter((e): e is NodeJS.ProcessEnv => !!e)
    expect(envs.length).toBeGreaterThan(0)
    for (const env of envs) {
      expect(env.KIND_EXPERIMENTAL_PROVIDER).toBe('podman')
      expect(Object.keys(env).length).toBeGreaterThan(1)
    }
  })

  it('scales the machine to the host, flooring small hosts and capping big ones', async () => {
    const initArgs = async (totalmem: number, cpuCount: number): Promise<string[]> => {
      const run = vi.fn(async (file: string, args: string[]) => {
        if (file === 'podman' && args[0] === 'machine' && args[1] === 'list') {
          return { stdout: '[]', stderr: '' }
        }
        return happyRun(file, args)
      }) as RunMock
      const deps = makeDeps({
        platform: 'darwin', run,
        totalmem: () => totalmem,
        cpuCount: () => cpuCount,
      })
      await runClusterInstall({}, deps)
      return deps.runStreaming.mock.calls.find(([, a]) => a[1] === 'init')![1]
    }

    const pair = (args: string[], flag: string): string => args[args.indexOf(flag) + 1]
    // Large host: 8 cpus / 32 GiB.
    let args = await initArgs(128 * 1024 ** 3, 12)
    expect([pair(args, '--cpus'), pair(args, '--memory')]).toEqual(['8', '32768'])
    // Smaller host: half its memory.
    args = await initArgs(16 * 1024 ** 3, 4)
    expect([pair(args, '--cpus'), pair(args, '--memory')]).toEqual(['4', '8192'])
    // Floor: 2 cpus / 4 GiB.
    args = await initArgs(4 * 1024 ** 3, 1)
    expect([pair(args, '--cpus'), pair(args, '--memory')]).toEqual(['2', '4096'])
  })

  it('resolves the machine provider across containers.conf and its drop-ins', async () => {
    const withSources = async (
      sources: Record<string, string>,
      dropIns: string[] = [],
    ): Promise<boolean> => {
      const run = vi.fn(async (file: string, args: string[]) => {
        if (file === 'podman' && args[0] === 'machine' && args[1] === 'list') {
          return { stdout: '[]', stderr: '' }
        }
        return happyRun(file, args)
      }) as RunMock
      const deps = makeDeps({
        platform: 'darwin', run,
        listDir: vi.fn().mockResolvedValue(dropIns),
        readTextFile: vi.fn((path: string) => {
          const isDropIn = path.includes('containers.conf.d/')
          for (const [frag, body] of Object.entries(sources)) {
            const fragIsDropIn = frag !== 'containers.conf'
            if (fragIsDropIn !== isDropIn) continue
            if (path.includes(frag)) return Promise.resolve(body)
          }
          // Unstaged paths are absent.
          if (path.includes('containers.conf')) return Promise.resolve(null)
          return fakeCalicoReadTextFile(path)
        }),
      })
      await runClusterInstall({}, deps)
      // A drop-in is written only when the provider is not already libkrun.
      return vi.mocked(deps.writeTextFile).mock.calls
        .some(([p]) => String(p).includes('99-yaac-machine-provider.conf'))
    }

    // No config, or no provider set: yaac pins one.
    expect(await withSources({})).toBe(true)
    expect(await withSources({ 'containers.conf': '[engine]\nfoo = "bar"\n' })).toBe(true)
    // Already libkrun: nothing to write.
    expect(await withSources({ 'containers.conf': '[machine]\nprovider = "libkrun"\n' })).toBe(false)
    // A later drop-in overrides an earlier source...
    expect(await withSources(
      { 'containers.conf': '[machine]\nprovider = "applehv"\n', '10-x.conf': '[machine]\nprovider = "libkrun"\n' },
      ['10-x.conf'],
    )).toBe(false)
    // ...and an unparseable drop-in is skipped.
    expect(await withSources(
      { 'containers.conf': '[machine]\nprovider = "libkrun"\n', '10-x.conf': 'not [ valid toml' },
      ['10-x.conf'],
    )).toBe(false)
  })

  function darwinDeps(
    overrides: Omit<Partial<ClusterInstallDeps>, 'run' | 'runStreaming'> & {
      run?: RunMock
      runStreaming?: StreamMock
    } = {},
  ): ClusterInstallDeps & { run: RunMock; runStreaming: StreamMock } {
    return makeDeps({ platform: 'darwin', ...overrides })
  }

  /** `podman machine list` responses: the first call, then all later ones. */
  function machineRun(
    first: object[],
    later: object[],
    extra?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }> | null,
  ): RunMock {
    let listCalls = 0
    return vi.fn(async (file: string, args: string[]) => {
      if (file === 'podman' && args[0] === 'machine' && args[1] === 'list') {
        listCalls += 1
        return { stdout: JSON.stringify(listCalls === 1 ? first : later), stderr: '' }
      }
      const handled = extra?.(file, args)
      if (handled) return handled
      return happyRun(file, args)
    })
  }

  it('writes the libkrun drop-in and inits a rootful machine when none exists', async () => {
    const run = machineRun([], [{ Name: 'podman-machine-default', Running: false, Default: true }])
    const deps = darwinDeps({ run })
    await runClusterInstall({}, deps)

    const write = vi.mocked(deps.writeTextFile).mock.calls[0]
    expect(write[0]).toContain('containers.conf.d/99-yaac-machine-provider.conf')
    expect(write[1]).toContain('provider = "libkrun"')

    const init = deps.runStreaming.mock.calls.find(([, a]) => a[1] === 'init')
    expect(init?.[1]).toContain('--rootful')
    expect(run.mock.calls.some(([f, a]) => f === 'podman' && a[1] === 'start')).toBe(true)
  })

  it('does not write a drop-in when the provider is already libkrun', async () => {
    const run = machineRun(
      [{ Name: 'podman-machine-default', Running: true, Default: true, VMType: 'libkrun' }],
      [{ Name: 'podman-machine-default', Running: true, Default: true, VMType: 'libkrun' }],
      (file, args) => {
        if (file === 'podman' && args[1] === 'inspect') {
          return Promise.resolve({ stdout: JSON.stringify([{ Rootful: true }]), stderr: '' })
        }
        return null
      },
    )
    const deps = darwinDeps({
      run,
      readTextFile: vi.fn((p: string) => Promise.resolve(
        p.endsWith('containers.conf')
          ? '[machine]\nprovider = "libkrun"\n'
          : p.includes('containers.conf.d')
            ? null
            : fakeCalicoReadTextFile(p),
      )) as unknown as ClusterInstallDeps['readTextFile'],
    })
    await runClusterInstall({}, deps)
    expect(deps.writeTextFile).not.toHaveBeenCalled()
    expect(run.mock.calls.some(([f, a]) => f === 'podman' && a[1] === 'start')).toBe(false)
  })

  it('stops, sets --rootful, and restarts a rootless machine', async () => {
    const run = machineRun(
      [{ Name: 'podman-machine-default', Running: true, Default: true, VMType: 'libkrun' }],
      [{ Name: 'podman-machine-default', Running: false, Default: true, VMType: 'libkrun' }],
      (file, args) => {
        if (file === 'podman' && args[1] === 'inspect') {
          return Promise.resolve({ stdout: JSON.stringify([{ Rootful: false }]), stderr: '' })
        }
        return null
      },
    )
    const deps = darwinDeps({ run })
    await runClusterInstall({}, deps)
    const podmanMachineCalls = run.mock.calls
      .filter(([f, a]) => f === 'podman' && a[0] === 'machine')
      .map(([, a]) => a.slice(1).join(' '))
    expect(podmanMachineCalls).toContain('stop podman-machine-default')
    expect(podmanMachineCalls).toContain('set --rootful podman-machine-default')
    expect(podmanMachineCalls).toContain('start')
  })

  it('prompts before replacing a machine on another provider, and throws when declined', async () => {
    const run = machineRun(
      [{ Name: 'podman-machine-default', Running: true, Default: true, VMType: 'applehv' }],
      [{ Name: 'podman-machine-default', Running: true, Default: true, VMType: 'applehv' }],
    )
    const deps = darwinDeps({ run, confirm: vi.fn().mockResolvedValue(false) })
    const err = await runClusterInstall({}, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterInstallError)
    expect((err as Error).message).toContain('applehv')
    expect(run.mock.calls.some(([f, a]) => f === 'podman' && a[1] === 'rm')).toBe(false)
  })

  it('replaces a machine on another provider when confirmed', async () => {
    const run = machineRun(
      [{ Name: 'podman-machine-default', Running: false, Default: true, VMType: 'applehv' }],
      [{ Name: 'podman-machine-default', Running: false, Default: true, VMType: 'libkrun' }],
    )
    const deps = darwinDeps({ run, confirm: vi.fn().mockResolvedValue(true) })
    await runClusterInstall({}, deps)
    expect(run.mock.calls.some(([f, a]) =>
      f === 'podman' && a.join(' ') === 'machine rm -f podman-machine-default')).toBe(true)
    expect(deps.runStreaming.mock.calls.some(([, a]) => a[1] === 'init')).toBe(true)
  })

  it('surfaces a machine start failure as-is', async () => {
    const run = machineRun(
      [{ Name: 'podman-machine-default', Running: false, Default: true, VMType: 'libkrun' }],
      [{ Name: 'podman-machine-default', Running: false, Default: true, VMType: 'libkrun' }],
      (file, args) => {
        if (file === 'podman' && args[1] === 'inspect') {
          return Promise.resolve({ stdout: JSON.stringify([{ Rootful: true }]), stderr: '' })
        }
        if (file === 'podman' && args[1] === 'start') {
          return Promise.reject(Object.assign(new Error('exit 1'), { stderr: 'krunkit crashed' }))
        }
        return null
      },
    )
    const deps = darwinDeps({ run })
    const err = await runClusterInstall({}, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterInstallError)
    expect((err as Error).message).toContain('krunkit crashed')
    // The machine exists, so this is where an upgrade that lost krunkit fails.
    expect((err as Error).message).toContain('brew install bsklaroff/yaac/yaac-cluster')
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it('uses the cached Calico manifest when it matches the pin, without downloading', async () => {
    // Calico is installed only when creating the cluster.
    const deps = makeDeps({ run: freshRun() })
    await runClusterInstall({}, deps)
    expect(deps.fetchText).not.toHaveBeenCalled()
    expect(vi.mocked(deps.writeTextFile).mock.calls.some(([p]) => String(p).includes('calico')))
      .toBe(false)
    const apply = deps.runStreaming.mock.calls
      .find(([f, a]) => f === 'kubectl' && a.includes('apply'))
    expect((apply?.[2] as { input?: string })?.input).toBe(FAKE_CALICO_MANIFEST)
  })

  it('downloads the pinned Calico manifest by tag, verifies it, and caches it', async () => {
    const deps = makeDeps({ run: freshRun(), readTextFile: calicoReads(() => null) })
    await runClusterInstall({}, deps)
    expect(deps.fetchText).toHaveBeenCalledWith(
      `https://raw.githubusercontent.com/projectcalico/calico/v${CALICO_VERSION}/manifests/calico.yaml`,
    )
    const written = vi.mocked(deps.writeTextFile).mock.calls
      .find(([p]) => String(p).includes(`calico-${CALICO_VERSION}.yaml`))
    expect(written?.[1]).toBe(FAKE_CALICO_MANIFEST)
  })

  it('re-downloads when the cached Calico copy no longer matches the pin', async () => {
    // A cached manifest is checked against the pin on every use, so a
    // tampered or truncated cache is rejected.
    const deps = makeDeps({
      run: freshRun(),
      readTextFile: calicoReads(() => 'kind: DaemonSet # tampered\n'),
    })
    await runClusterInstall({}, deps)
    expect(deps.fetchText).toHaveBeenCalledOnce()
  })

  it.each([
    ['a download that fails the checksum', { fetchText: vi.fn().mockResolvedValue('kind: Evil\n') },
      /does not match the pinned checksum/],
    ['a failed download', { fetchText: vi.fn().mockRejectedValue(new Error('HTTP 503 Service Unavailable')) },
      /Could not download the Calico manifest.*HTTP 503/s],
    // A broken install: the committed pin itself is missing.
    ['a missing checksum pin', { readTextFile: vi.fn((p: string) => Promise.resolve(
      p.includes('calico') || p.endsWith('.sha256') ? null : FAKE_KIND_CONFIG,
    )) }, /checksum not found/],
  ] as const)('refuses Calico on %s, and caches nothing', async (_case, overrides, message) => {
    const deps = makeDeps({ run: freshRun(), readTextFile: calicoReads(() => null), ...overrides })
    const err = await runClusterInstall({}, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterInstallError)
    expect((err as Error).message).toMatch(message)
    expect(vi.mocked(deps.writeTextFile).mock.calls.some(([p]) => String(p).includes('calico')))
      .toBe(false)
  })

  // -------------------------------------------------------------------
  // --tailnet: fronting the server on the tailnet through the operator
  // -------------------------------------------------------------------

  it('--tailnet hands the tailnet fronting and --owner to the server deploy', async () => {
    const deps = makeDeps({ run: tailnetRun('present') })
    await expect(runClusterInstall({ tailnet: true, owner: 'alice@example.com' }, deps)).resolves.toBeUndefined()
    expect(appliedOf('Ingress')).toHaveLength(1)
    const env = serverPod().containers[0].env
    expect(env).toContainEqual({ name: 'YAAC_ACCESS_MODE', value: 'tailnet' })
    expect(env).toContainEqual({ name: 'YAAC_ACCESS_OWNER', value: 'alice@example.com' })
    expect(await readServerConfig()).toMatchObject({ url: 'https://yaac.tail.ts.net' })
    expect(logged(deps)).toContain('Tailscale operator present')
    // An operator installed some other way (helm) is its installer's to
    // upgrade, so install only checks it.
    expect(appliedOf('IngressClass')).toEqual([])
    expect(deps.fetchText).not.toHaveBeenCalled()
  })

  it('--tailnet installs the pinned operator on a kind cluster that lacks it, before any layer', async () => {
    vi.stubEnv('TS_OAUTH_CLIENT_ID', 'client-id')
    vi.stubEnv('TS_OAUTH_CLIENT_SECRET', 'client-secret')
    const deps = makeDeps({ run: tailnetRun('absent'), readTextFile: operatorReads(), fetchText: operatorFetch() })
    await expect(runClusterInstall({ tailnet: true }, deps)).resolves.toBeUndefined()

    expect(deps.fetchText).toHaveBeenCalledWith(
      'https://raw.githubusercontent.com/tailscale/tailscale/v1.102.4/cmd/k8s-operator/deploy/manifests/operator.yaml',
    )
    // The OAuth Secret comes from the client, never the manifest's placeholder.
    expect(appliedOf('Secret', 'operator-oauth')).toEqual([expect.objectContaining({
      stringData: { client_id: 'client-id', client_secret: 'client-secret' },
    })])
    const [operator] = appliedOf('Deployment', 'operator') as unknown as Array<{
      metadata: { labels: Record<string, string> }
      spec: { template: { spec: { containers: Array<{ image: string; env: Array<{ name: string; value?: string }> }> } } }
    }>
    const [container] = operator.spec.template.spec.containers
    expect(container.image).toMatch(/^tailscale\/k8s-operator:v1\.102\.4@sha256:[0-9a-f]{64}$/)
    expect(container.env).toEqual([
      { name: 'OPERATOR_HOSTNAME', value: 'yaac-operator' },
      { name: 'PROXY_IMAGE', value: expect.stringMatching(/^tailscale\/tailscale:v1\.102\.4@sha256:/) as string },
    ])
    // Labeled, so the next install converges it.
    expect(operator.metadata.labels).toMatchObject({ 'app.kubernetes.io/managed-by': 'yaac' })
    expect(appliedOf('IngressClass', 'tailscale')).toHaveLength(1)
    expect(logged(deps)).toContain('Tailscale operator present')
    // Before the first layer, so a refusal or a failed rollout leaves the
    // cluster as it was.
    const operatorAt = cluster.applied.indexOf(operator as unknown as Applied)
    expect(cluster.applied.findIndex((m) => m.kind === 'Deployment' && m.metadata.name === SERVER_APP_NAME))
      .toBeGreaterThan(operatorAt)
    expect(appliedOf('Ingress')).toHaveLength(1)
  })

  it('--tailnet converges the operator an earlier install put there, keeping its Secret', async () => {
    fakeCluster.seed(...OPERATOR.map(yaacManaged))
    const deps = makeDeps({ readTextFile: operatorReads(), fetchText: operatorFetch() })
    await expect(runClusterInstall({ tailnet: true }, deps)).resolves.toBeUndefined()
    expect(appliedOf('Deployment', 'operator')).toHaveLength(1)
    expect(appliedOf('Secret', 'operator-oauth')).toEqual([])
  })

  it.each([
    ['IngressClass', 'the operator\'s IngressClass (tailscale)'],
    ['CustomResourceDefinition', 'the ProxyClass CRD (proxyclasses.tailscale.com)'],
  ])('--tailnet refuses to take over a %s another operator install left, with no operator here', async (kind, what) => {
    // A helm install in another namespace, or a half-removed one: applying
    // would force the shared cluster-wide objects over to yaac.
    vi.stubEnv('TS_OAUTH_CLIENT_ID', 'client-id')
    vi.stubEnv('TS_OAUTH_CLIENT_SECRET', 'client-secret')
    fakeCluster.seed(...OPERATOR.filter((o) => o.kind === kind))
    const deps = makeDeps({ readTextFile: operatorReads(), fetchText: operatorFetch() })
    const err = await runClusterInstall({ tailnet: true }, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterInstallError)
    expect((err as Error).message).toContain(`but ${what} is already in this cluster`)
    expect(deps.fetchText).not.toHaveBeenCalled()
    expect(cluster.applied).toEqual([])
    expect(ran('ensurePriorityClasses')).toBe(0)
  })

  it('--tailnet refuses an operator manifest naming an image it has no digest for', async () => {
    // A later manifest could add a container; it must not run by tag.
    vi.stubEnv('TS_OAUTH_CLIENT_ID', 'client-id')
    vi.stubEnv('TS_OAUTH_CLIENT_SECRET', 'client-secret')
    const manifest = FAKE_OPERATOR_MANIFEST.replace(
      '      containers:',
      '      initContainers:\n      - image: tailscale/k8s-operator-init:stable\n      containers:',
    )
    const sha = crypto.createHash('sha256').update(manifest, 'utf8').digest('hex')
    const deps = makeDeps({
      readTextFile: operatorReads(sha),
      fetchText: vi.fn().mockResolvedValue(manifest),
    })
    const err = await runClusterInstall({ tailnet: true }, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterInstallError)
    expect((err as Error).message).toContain('tailscale/k8s-operator-init:stable, which has no pinned digest')
    expect(cluster.applied).toEqual([])
  })

  it('--tailnet without the operator or an OAuth client refuses before anything is applied', async () => {
    // Without the operator the Ingress never gets a hostname, and install
    // would wait out the publish timeout. Refuse up front with both ways on.
    const deps = makeDeps({ run: tailnetRun('absent') })
    const err = await runClusterInstall({ tailnet: true }, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterInstallError)
    expect((err as Error).message).toContain('TS_OAUTH_CLIENT_ID=<id> TS_OAUTH_CLIENT_SECRET=<secret>')
    expect((err as Error).message).toContain('yaac cluster install --tailnet <this machine')
    expect(ran('ensurePriorityClasses')).toBe(0)
    expect(ran('ensureMainRegistry')).toBe(0)
    expect(ran('deployServerWorkload')).toBe(0)
  })

  it('--tailnet <host> publishes through this machine\'s tailscale serve, needing no operator', async () => {
    const deps = makeDeps({ run: tailnetRun('absent') })
    await expect(runClusterInstall({ tailnet: 'Srv.Tail.ts.net', owner: 'alice@example.com' }, deps))
      .resolves.toBeUndefined()
    // The kind forwarder serve points at, and no Ingress.
    expect(appliedOf('Ingress')).toEqual([])
    expect(appliedOf('Deployment', 'yaac-server-front')).toHaveLength(1)
    const env = serverPod().containers[0].env
    expect(env).toContainEqual({ name: 'YAAC_ACCESS_MODE', value: 'tailnet' })
    expect(env).toContainEqual({ name: 'YAAC_ALLOWED_HOSTS', value: 'srv.tail.ts.net' })
    expect(env).toContainEqual({ name: 'YAAC_ACCESS_OWNER', value: 'alice@example.com' })
    expect(vi.mocked(globalThis.fetch).mock.calls.map(([u]) => u))
      .toContain('https://srv.tail.ts.net/api/health')
    expect(await readServerConfig()).toMatchObject({ url: 'https://srv.tail.ts.net' })
    expect(await readInstallRecord()).toMatchObject({ driver: 'k8s' })
    expect(logged(deps)).not.toContain('Tailscale Kubernetes operator')
  })

  it('--tailnet reports an operator it could not evaluate, never as absent', async () => {
    // An unreachable apiserver is unknown, not "not installed"; the fix is
    // the kubeconfig, not helm.
    const deps = makeDeps({ run: tailnetRun('unreachable') })
    const err = await runClusterInstall({ tailnet: true }, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterInstallError)
    expect((err as Error).message).toContain('could not be evaluated')
    expect((err as Error).message).not.toContain('helm')
    expect(ran('ensurePriorityClasses')).toBe(0)
  })

  // --byo: installing into a cluster yaac did not create
  // -------------------------------------------------------------------

  it('--byo installs into the cluster it is given: layers, class-backed claims, a tailnet server', async () => {
    stageAdoptCidrs()
    const deps = makeDeps({ run: adoptRun() })
    await runClusterInstall(BYO, deps)

    // Nothing destructive and no CNI: the cluster and its Calico are the
    // user's.
    expect(deps.run.mock.calls.some(([f, a]) => f === 'kind' && a[0] === 'delete')).toBe(false)
    expect(deps.runStreaming).not.toHaveBeenCalled()
    expect(deps.fetchText).not.toHaveBeenCalled()
    expect(deps.run.mock.calls.some(([f, a]) =>
      f === 'kubectl' && a.includes('daemonset/calico-node'))).toBe(false)

    // Every in-cluster layer is still installed.
    expect(ran('ensurePriorityClasses')).toBe(1)
    expect(ran('ensureMainRegistry')).toBe(1)
    expect(ran('ensureBuilderRoleGuard')).toBe(1)
    expect(ran('ensureGvisorRuntime')).toBe(1)
    expect(ran('ensureNetd')).toBe(1)

    // The server is behind the tailnet (no loopback on a cloud cluster), at
    // the fixed byo uid, with claims from the named RWX class and the default
    // block class, and a new install id recorded before anything is applied.
    expect(appliedOf('Ingress')).toHaveLength(1)
    expect(serverPod().securityContext).toMatchObject({ runAsUser: 1000, runAsGroup: 1000 })
    expect(claimClasses()).toEqual({ 'yaac-global': 'byo-nfs', 'yaac-server-local': 'standard', 'yaac-checkouts': '' })
    // The binder stamps the volumes with the id recorded before anything
    // was applied.
    const binderArgs = (appliedOf('Pod')[0] as unknown as {
      spec: { containers: Array<{ command: string[] }> }
    }).spec.containers[0].command.slice(-3)
    expect(binderArgs.slice(0, 2)).toEqual(['1000', '1000'])
    expect(binderArgs[2]).toMatch(/^[0-9a-f-]{36}$/)
    expect(await readInstallRecord()).toEqual({
      driver: 'k8s', byo: true, installId: binderArgs[2], clusterUid: 'uid-byo', kubeContext: 'byo-context',
      origin: expect.stringMatching(/^https:\/\//) as unknown,
    })

    // No node exec: the kind fixups are for kind node containers.
    expect(deps.run.mock.calls.some(([f, a]) => f === 'podman' && (a[0] === 'exec' || a[0] === 'update')))
      .toBe(false)

    // The logged findings are the audit trail for a cluster yaac does not
    // own.
    const log = logged(deps)
    expect(log).toContain('chainInsertMode: Insert')
    expect(log).toContain('10.244.0.0/24')
    expect(log).toContain('192.168.0.0/16')
    expect(log).toContain('veth prefix: cali*')
    expect(log).toContain('yaac-global through byo-nfs, yaac-server-local through standard')
  })

  it('--byo takes a named RWO class over the default, and needs no kind', async () => {
    stageAdoptCidrs()
    const classes = [...BYO_CLASSES, { metadata: { name: 'fast-ssd' }, provisioner: 'pd.csi.storage.gke.io' }]
    const deps = makeDeps({ run: adoptRun({ kind: false, classes }) })
    await expect(runClusterInstall({ ...BYO, rwoStorageClass: 'fast-ssd' }, deps)).resolves.toBeUndefined()
    expect(claimClasses()).toEqual({ 'yaac-global': 'byo-nfs', 'yaac-server-local': 'fast-ssd', 'yaac-checkouts': '' })
  })

  it('--byo refuses the flag combinations it cannot honor, before touching anything', async () => {
    // --nodes configures nodes install creates; byo creates none.
    for (const [opts, message] of [
      [{ ...BYO, nodes: 3 }, /--nodes cannot be combined with --byo/],
      [{ byo: true }, /--byo needs --rwx-storage-class/],
      [{ rwxStorageClass: 'byo-nfs' }, /--rwx-storage-class is for --byo only/],
      [{ rwoStorageClass: 'fast' }, /--rwo-storage-class is for --byo only/],
      // --owner only means anything on the switch to tailnet.
      [{ owner: 'alice@example.com' }, /--owner .* needs --tailnet/],
      // A byo cluster has no loopback port for this machine's serve.
      [{ ...BYO, tailnet: 'srv.tail.ts.net' }, /--byo install is published through the Tailscale operator/],
      [{ tailnet: 'https://srv.tail.ts.net' }, /--tailnet takes the bare MagicDNS name/],
    ] as const) {
      const d = makeDeps({ run: adoptRun() })
      const err = await runClusterInstall(opts, d).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ClusterInstallError)
      expect((err as Error).message).toMatch(message)
      expect(d.run).not.toHaveBeenCalled()
      expect(ran('ensureMainRegistry')).toBe(0)
    }
  })

  it('--byo refuses a node pool it cannot build for or install onto, naming the nodes', async () => {
    stageAdoptCidrs()
    const other = HOST_ARCH === 'amd64' ? 'arm64' : 'amd64'
    const cases: Array<[AdoptFacts, RegExp]> = [
      [{ nodeInfo: { architecture: other } }, new RegExp(`every node is ${other}, and this machine is ${HOST_ARCH}`)],
      [
        { nodes: [{ name: 'a' }, { name: 'b' }], nodeInfo: { architecture: other } },
        new RegExp(`from a ${other} machine`),
      ],
      [{ nodeInfo: { containerRuntimeVersion: 'cri-o://1.30.0' } }, /runs cri-o:\/\/1\.30\.0, not containerd/],
      [{ nodeInfo: { osImage: 'Bottlerocket OS 1.20.0 (aws-k8s-1.30)' } }, /Bottlerocket .* an immutable OS/],
      [
        { nodeInfo: { kubeletVersion: 'v1.36.4+k3s1', containerRuntimeVersion: 'containerd://2.1.5-k3s1' } },
        /runs k3s's embedded containerd .*--container-runtime-endpoint/,
      ],
    ]
    for (const [facts, message] of cases) {
      const deps = makeDeps({ run: adoptRun(facts) })
      const err = await runClusterInstall(BYO, deps).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ClusterInstallError)
      expect((err as Error).message).toMatch(message)
      // Refused before touching podman on this host.
      expect(deps.run.mock.calls.some(([f, a]) => f === 'podman' && a[0] === 'info')).toBe(false)
      expect(ran('ensureMainRegistry')).toBe(0)
      expect(ran('buildBuiltinImages')).toBe(0)
    }
  })

  it('--byo refuses storage classes that cannot back the install', async () => {
    stageAdoptCidrs()
    const block = { metadata: { name: 'byo-nfs' }, provisioner: 'ebs.csi.aws.com' }
    const cases: Array<[AdoptFacts, Partial<typeof BYO & { rwoStorageClass: string }>, RegExp]> = [
      [{ classes: BYO_CLASSES.slice(1) }, {}, /there is no StorageClass "byo-nfs" \(this cluster has: standard\)/],
      [{ classes: [block, BYO_CLASSES[1]] }, {}, /provisions through ebs\.csi\.aws\.com, which is not NFS-family/],
      [{}, { rwoStorageClass: 'nope' }, /--rwo-storage-class: there is no StorageClass "nope"/],
      [{ classes: BYO_CLASSES.slice(0, 1) }, {}, /no default StorageClass/],
    ]
    for (const [facts, extra, message] of cases) {
      const deps = makeDeps({ run: adoptRun(facts) })
      const err = await runClusterInstall({ ...BYO, ...extra }, deps).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ClusterInstallError)
      expect((err as Error).message).toMatch(message)
      expect(ran('ensureMainRegistry')).toBe(0)
    }
    // Azure Files counts only over NFS.
    const azure = { metadata: { name: 'byo-nfs' }, provisioner: 'file.csi.azure.com', parameters: { protocol: 'nfs' } }
    await expect(runClusterInstall(BYO, makeDeps({ run: adoptRun({ classes: [azure, BYO_CLASSES[1]] }) })))
      .resolves.toBeUndefined()
  })

  it('--byo refuses without the Tailscale operator, the fronting it implies', async () => {
    stageAdoptCidrs()
    const run = adoptRun()
    replaceKind('CustomResourceDefinition', [])
    replaceKind('IngressClass', [])
    const deps = makeDeps({ run })
    const err = await runClusterInstall(BYO, deps).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/--byo needs the Tailscale Kubernetes operator/)
    expect(ran('ensureMainRegistry')).toBe(0)
  })

  it('--byo refuses another install\'s Deployment, another cluster, a switch of kind, and a Tor listener here', async () => {
    stageAdoptCidrs()
    // Another install's server in the namespace: installing over it would
    // take its storage.
    let deps = makeDeps({ run: adoptRun({ deployed: { installId: 'theirs', dataDir: '/elsewhere/.yaac' } }) })
    let err = await runClusterInstall(BYO, deps).catch((e: unknown) => e)
    expect((err as Error).message)
      .toMatch(/another install \(install id theirs, installed from the data dir \/elsewhere\/\.yaac; this data dir's is [0-9a-f-]{36}\)/)
    expect(await readInstallRecord()).toBeNull()

    // This install's own server is a re-install.
    const mine = { driver: 'k8s' as const, installId: 'mine', byo: true }
    await writeRecord({ ...mine, clusterUid: 'uid-byo', kubeContext: 'byo-context' })
    deps = makeDeps({ run: adoptRun({ deployed: { installId: 'mine', dataDir: '/elsewhere/.yaac' } }) })
    await expect(runClusterInstall(BYO, deps)).resolves.toBeUndefined()
    events.length = 0

    // Recorded in one cluster, run against another: matched by uid.
    await writeRecord({ ...mine, clusterUid: 'uid-prod', kubeContext: 'prod' })
    deps = makeDeps({ run: adoptRun({ context: 'dev', clusterUid: 'uid-dev' }) })
    err = await runClusterInstall(BYO, deps).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/kube context "prod"[\s\S]*kubectl config use-context prod/)
    deps = makeDeps({ run: adoptRun({ context: 'prod', clusterUid: 'uid-dev' }) })
    err = await runClusterInstall(BYO, deps).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/same name but is a different cluster/)
    expect(ran('ensureMainRegistry')).toBe(0)

    // A byo data dir cannot take the kind path, nor a kind one the byo path.
    deps = makeDeps({ run: adoptRun() })
    err = await runClusterInstall({}, deps).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/This data dir is a --byo install\. Re-run with --byo/)
    expect(deps.run).not.toHaveBeenCalled()
    await writeRecord({ driver: 'k8s', installId: 'kind-one' })
    err = await runClusterInstall(BYO, deps).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/This data dir is a kind install, so --byo cannot install from it/)
    expect(deps.run).not.toHaveBeenCalled()

    // A containerless data dir is refused too.
    await writeRecord({ driver: 'containerless' })
    deps = makeDeps({ run: adoptRun() })
    err = await runClusterInstall(BYO, deps).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/is a containerless install[\s\S]*~\/\.yaac-cluster/)
    await clearRecord()

    vi.stubEnv('YAAC_USE_TOR', '1')
    deps = makeDeps({ run: adoptRun() })
    err = await runClusterInstall(BYO, deps).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/YAAC_USE_TOR/)
    expect(ran('ensureMainRegistry')).toBe(0)
  })

  it('--byo refuses Calico\'s eBPF dataplane, from the CR or the container env', async () => {
    // eBPF host routing bypasses host netfilter (as Cilium does), so netd's
    // DNAT would never see workspace egress and every workspace would silently
    // lose the internet. This must refuse, not warn.
    const cases: AdoptFacts[] = [
      { felix: [{ spec: { bpfEnabled: true } }] },
      {
        calico: {
          status: { numberReady: 1, desiredNumberScheduled: 1 },
          spec: {
            template: {
              spec: {
                containers: [{
                  name: 'calico-node',
                  env: [{ name: 'FELIX_BPFENABLED', value: 'true' }],
                }],
              },
            },
          },
        },
      },
    ]
    for (const facts of cases) {
      stageAdoptCidrs()
      const deps = makeDeps({ run: adoptRun(facts) })
      const err = await runClusterInstall(BYO, deps).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ClusterInstallError)
      expect((err as Error).message).toMatch(/eBPF dataplane/)
      expect((err as Error).message).toContain('bpfEnabled')
      // Refused before anything is applied.
      expect(ran('ensureMainRegistry')).toBe(0)
      expect(ran('ensureNetd')).toBe(0)
    }
  })

  it('--byo refuses every other silent-failure shape, naming which one it is', async () => {
    const refuse = async (facts: AdoptFacts, cidrs?: Parameters<typeof stageAdoptCidrs>[0]) => {
      stageAdoptCidrs(cidrs)
      const deps = makeDeps({ run: adoptRun(facts) })
      const err = await runClusterInstall(BYO, deps).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ClusterInstallError)
      expect(ran('ensureMainRegistry')).toBe(0)
      return (err as Error).message
    }

    // No Calico, which is also how a Cilium cluster looks; Cilium cannot
    // support the veth redirect.
    expect(await refuse({ calico: null })).toMatch(/no calico-node found in kube-system or calico-system/)
    expect(await refuse({ calico: null })).toMatch(/Cilium is not supported/)

    // Not fully rolled out: a node without Felix has no egress lockdown.
    expect(await refuse({
      calico: { status: { numberReady: 1, desiredNumberScheduled: 3 } },
    })).toMatch(/calico-node is 1\/3 ready/)

    // netd's Envoy dials the proxy's ClusterIP from the host network, which
    // needs kube-proxy.
    expect(await refuse({ kubeProxyPods: [] })).toMatch(/no kube-proxy pod found/)
    // So does Calico replacing kube-proxy.
    expect(await refuse({ felix: [{ spec: { bpfKubeProxyIptablesCleanupEnabled: true } }] }))
      .toMatch(/replacing kube-proxy/)

    // No pod CIDR: an empty set would redirect pod-to-pod traffic into the
    // proxy, so adopt mode refuses instead of assuming kind's default.
    const noCidrs = await refuse({}, { pools: [], nodeCidrs: [] })
    expect(noCidrs).toMatch(/no pod CIDR could be resolved/)
    expect(noCidrs).toContain('YAAC_POD_CIDRS')

    // netd uses system-node-critical; without it no netd pod is created.
    expect(await refuse({ systemNodeCritical: false }))
      .toMatch(/system-node-critical PriorityClass is missing/)
  })

  it('--byo records Append chainInsertMode and the node-podCIDR-only shape as warnings', async () => {
    // Neither breaks the datapath (netd appends its own jump), but the
    // operator should be told.
    stageAdoptCidrs({ pools: [], nodeCidrs: ['10.244.0.0/24'] })
    const deps = makeDeps({ run: adoptRun({ felix: [{ spec: { chainInsertMode: 'Append' } }] }) })
    await expect(runClusterInstall(BYO, deps)).resolves.toBeUndefined()

    const log = logged(deps)
    expect(log).toContain('chainInsertMode: Append')
    expect(log).toMatch(/Append chainInsertMode/)
    expect(log).toMatch(/only pod-CIDR source is node spec\.podCIDR/)
    expect(log).toContain('YAAC_POD_CIDRS')
  })

  it('--byo honors an explicit pod-CIDR and veth-prefix config', async () => {
    // The EKS shape: operator-managed, policy-only Calico (in calico-system)
    // over the VPC CNI, so pod IPs in no IPPool or podCIDR, and `eni*` veths.
    // Whether the prefix matches the nodes' routes is the cluster check's
    // veth-source gate.
    vi.stubEnv('YAAC_POD_CIDRS', '172.31.0.0/16')
    vi.stubEnv('YAAC_CNI_VETH_PREFIX', 'eni')
    stageAdoptCidrs({ pools: [], nodeCidrs: [] })
    const deps = makeDeps({
      run: adoptRun({
        calicoNamespace: 'calico-system',
        routes: '10.0.3.41 dev enia7b3c9d1e2f4 scope link',
      }),
    })
    await expect(runClusterInstall(BYO, deps)).resolves.toBeUndefined()

    const log = logged(deps)
    expect(log).toContain('172.31.0.0/16')
    expect(log).toContain('from YAAC_POD_CIDRS')
    expect(log).toContain('veth prefix: eni*')
  })

  it('--byo refuses a check it could not EVALUATE, not just one that failed', async () => {
    // A failed read must not count as absence: an RBAC-denied
    // FelixConfiguration would otherwise let an eBPF cluster through.
    for (const denied of ['felix', 'kube-proxy', 'nodes', 'calico'] as const) {
      stageAdoptCidrs()
      const deps = makeDeps({ run: adoptRun({ denied }) })
      const err = await runClusterInstall(BYO, deps).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ClusterInstallError)
      expect((err as Error).message).toMatch(/could not be evaluated/)
      expect((err as Error).message).toMatch(/403: .*forbidden/)
      expect(ran('ensureMainRegistry')).toBe(0)
      // A failed read must not also be reported as an absence, which would
      // point at the wrong fix.
      const absenceClaims: Record<typeof denied, RegExp> = {
        calico: /no calico-node found/,
        'kube-proxy': /no kube-proxy pod found/,
        nodes: /no pod CIDR could be resolved/,
        felix: /eBPF dataplane/,
      }
      expect((err as Error).message).not.toMatch(absenceClaims[denied])
      // Nor may the log claim a finding the check never established.
      if (denied === 'felix') expect(logged(deps)).not.toMatch(/chainInsertMode/)
    }

    // An RBAC denial on `ippools` alone must not look like "no pools" and
    // narrow the exclusion set.
    resetClusterCidrCache()
    cluster.poolsDenied = true
    cluster.nodes = [{ podCIDR: '10.244.0.0/24' }]
    const cidrDeps = makeDeps({ run: adoptRun() })
    const cidrErr = await runClusterInstall(BYO, cidrDeps).catch((e: unknown) => e)
    expect(cidrErr).toBeInstanceOf(ClusterInstallError)
    expect((cidrErr as Error).message).toMatch(/pod-CIDR source: Calico IPPools/)
    expect(ran('ensureMainRegistry')).toBe(0)

    // A CRD the cluster does not serve is genuine absence: no
    // FelixConfiguration means Felix's iptables defaults, which is fine.
    stageAdoptCidrs()
    const absent = makeDeps({ run: adoptRun() })
    await expect(runClusterInstall(BYO, absent)).resolves.toBeUndefined()
    expect(logged(absent)).toMatch(/no FelixConfiguration sets it/)
  })

  it('--byo sees eBPF in a per-node FelixConfiguration and in Felix\'s wider booleans', async () => {
    const refuse = async (facts: AdoptFacts): Promise<string> => {
      stageAdoptCidrs()
      const deps = makeDeps({ run: adoptRun(facts) })
      const err = await runClusterInstall(BYO, deps).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ClusterInstallError)
      expect(ran('ensureNetd')).toBe(0)
      return (err as Error).message
    }

    // Felix has per-node overrides, so `node.<name>` objects are read too.
    expect(await refuse({
      felix: [
        { metadata: { name: 'default' }, spec: { chainInsertMode: 'Insert' } },
        { metadata: { name: 'node.worker-1' }, spec: { bpfEnabled: true } },
      ],
    })).toMatch(/eBPF dataplane/)

    // Felix accepts more true spellings than true|1, such as `yes`.
    const withEnv = (value?: string, valueFrom?: object): AdoptFacts => ({
      calico: {
        status: { numberReady: 1, desiredNumberScheduled: 1 },
        spec: {
          template: {
            spec: {
              containers: [{
                name: 'calico-node',
                env: [{ name: 'FELIX_BPFENABLED', ...(valueFrom ? { valueFrom } : { value }) }],
              }],
            },
          },
        },
      },
    })
    for (const truthy of ['yes', 'Y', 't', 'ON', '1', 'TRUE']) {
      expect(await refuse(withEnv(truthy))).toMatch(/eBPF dataplane/)
    }

    // A `valueFrom` entry has no literal value, so the dataplane is unknown,
    // which must refuse rather than count as off.
    expect(await refuse(withEnv(undefined, { configMapKeyRef: { name: 'felix', key: 'bpf' } })))
      .toMatch(/valueFrom/)

    // Recognized false values still pass.
    for (const falsey of ['false', 'no', '0', 'off', 'F']) {
      stageAdoptCidrs()
      const deps = makeDeps({ run: adoptRun(withEnv(falsey)) })
      await expect(runClusterInstall(BYO, deps)).resolves.toBeUndefined()
    }
  })

  it('--byo finds kube-proxy however the cluster labels it, and accepts a declared external one', async () => {
    // kubeadm/EKS/kind label kube-proxy `k8s-app`; GKE and AKS use
    // `component`.
    stageAdoptCidrs()
    const gke = makeDeps({ run: adoptRun({ kubeProxyLabel: 'component' }) })
    await expect(runClusterInstall(BYO, gke)).resolves.toBeUndefined()

    // k3s runs kube-proxy inside the kubelet, with no pod. The refusal names
    // the case and an explicit acknowledgement clears it (and is logged).
    stageAdoptCidrs()
    const k3sRefusal = await runClusterInstall(
      BYO, makeDeps({ run: adoptRun({ kubeProxyPods: [] }) }),
    ).catch((e: unknown) => (e as Error).message)
    expect(k3sRefusal).toMatch(/YAAC_KUBE_PROXY_EXTERNAL=1/)
    expect(k3sRefusal).toMatch(/k3s runs it in-process/)

    // With that, a k3s node on the host's containerd installs.
    vi.stubEnv('YAAC_KUBE_PROXY_EXTERNAL', '1')
    stageAdoptCidrs()
    const k3s = makeDeps({
      run: adoptRun({ kubeProxyPods: [], nodeInfo: { kubeletVersion: 'v1.36.4+k3s1' } }),
    })
    await expect(runClusterInstall(BYO, k3s)).resolves.toBeUndefined()
    expect(logged(k3s)).toMatch(/declared external/)
  })

  it('--byo warns per NODE about kube-proxy', async () => {
    // Each workspace-capable node needs its own kube-proxy, or its workspaces
    // lose egress while others work.
    const nodes = [{ name: 'cp' }, { name: 'w1' }, { name: 'w2' }]
    stageAdoptCidrs()
    const partial = makeDeps({
      run: adoptRun({
        nodes,
        kubeProxyPods: [
          { spec: { nodeName: 'cp' }, status: { phase: 'Running' } },
          { spec: { nodeName: 'w1' }, status: { phase: 'Running' } },
        ],
      }),
    })
    await expect(runClusterInstall(BYO, partial)).resolves.toBeUndefined()
    expect(logged(partial)).toMatch(/no running kube-proxy on 1 session-capable node\(s\): w2/)

    // Nodes are matched against the gvisor RuntimeClass's tolerations, as
    // `cluster check` does, so a tainted workspace pool counts.
    stageAdoptCidrs()
    const pool = makeDeps({
      run: adoptRun({
        nodes: [{ name: 'cp', taint: 'node-role.kubernetes.io/control-plane' },
          { name: 'pool-1', taint: 'yaac.sessions' },
          { name: 'pool-2', taint: 'yaac.sessions' }],
        tolerations: [{ key: 'yaac.sessions', operator: 'Exists' }],
        kubeProxyPods: [{ spec: { nodeName: 'pool-1' }, status: { phase: 'Running' } }],
      }),
    })
    await expect(runClusterInstall(BYO, pool)).resolves.toBeUndefined()
    // pool-2 is tolerated, so in scope and uncovered; the control plane is
    // not tolerated, so out of scope.
    expect(logged(pool)).toMatch(/no running kube-proxy on 1 session-capable node\(s\): pool-2/)
    expect(logged(pool)).not.toMatch(/\bcp\b/)
  })

  it('--byo refuses a YAAC_POD_CIDRS entry it cannot use rather than dropping it', async () => {
    // Silently dropping a typo would narrow the exclusion set, sending those
    // pods' 443/80 into the proxy, so bad entries are refused.
    vi.stubEnv('YAAC_POD_CIDRS', '172.31.0.0/16, 172.31/16, 999.1.1.1/99, 10.0.0.0/33')
    stageAdoptCidrs()
    const deps = makeDeps({ run: adoptRun() })
    const err = await runClusterInstall(BYO, deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClusterInstallError)
    const msg = (err as Error).message
    expect(msg).toMatch(/not usable IPv4 CIDRs/)
    // Out-of-range values are refused too; one bad line makes
    // iptables-restore reject the whole update.
    expect(msg).toContain('172.31/16')
    expect(msg).toContain('999.1.1.1/99')
    expect(msg).toContain('10.0.0.0/33')
    expect(ran('ensureMainRegistry')).toBe(0)
  })

  it('mirrors the deduped image set the Calico manifest names, and nothing else', async () => {
    const manifest = [
      '        - name: upgrade-ipam',
      '          image: quay.io/calico/cni:v3.32.1',
      '        - name: install-cni',
      '          image: quay.io/calico/cni:v3.32.1',
      '          image: quay.io/calico/node:v3.32.1',
      '  # image: not-a-ref',
      '  imagePullPolicy: IfNotPresent',
    ].join('\n')
    const sha = crypto.createHash('sha256').update(manifest, 'utf8').digest('hex')
    const deps = makeDeps({
      run: freshRun(),
      readTextFile: vi.fn((p: string) => Promise.resolve(
        p.endsWith('.sha256')
          ? `${sha}  calico.yaml\n`
          : p.includes('calico')
            ? manifest
            : FAKE_KIND_CONFIG,
      )),
    })
    await runClusterInstall({}, deps)

    const pulled = deps.run.mock.calls
      .filter(([f, a]) => f === 'podman' && a[0] === 'image' && a[1] === 'exists')
      .map(([, a]) => a[2])
    // Deduped and sorted; prose and non-image keys are skipped.
    expect(pulled.filter((r) => r.includes('calico'))).toEqual([
      'quay.io/calico/cni:v3.32.1',
      'quay.io/calico/node:v3.32.1',
    ])
    expect(pulled).not.toContain('not-a-ref')
  })
})
