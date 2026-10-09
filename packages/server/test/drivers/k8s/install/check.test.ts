import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { apiError, fakeCluster, type FakeObject } from '@yaac/test-utils/k8s-stub'
import type * as apiModule from '#drivers/k8s/substrate/api'

// The process boundary (kubectl/podman children), the install namespace,
// and a fixed data-dir hash for the volume labels. Object reads and writes
// go to `fakeCluster`.
vi.mock('#drivers/k8s/substrate/api', async (importOriginal) => ({
  ...await importOriginal<typeof apiModule>(),
  dataDirHash: () => 'ddh16',
  execFileAsync: vi.fn(),
  k8sNamespace: () => 'test-ns',
}))

// The fsprobe pod's image; ensuring it would pull and push.
vi.mock('#drivers/k8s/cluster/builder-image', () => ({
  ensureBuilderImage: vi.fn().mockResolvedValue('localhost:5000/podman-stable:mirror'),
}))

vi.mock('#drivers/k8s/container/registry', () => ({
  REGISTRY_NAMESPACE: 'yaac',
  REGISTRY_SERVICE_NAME: 'yaac-registry',
  REGISTRY_SERVICE_PORT: 5000,
  registryEndpoint: vi.fn().mockResolvedValue('127.0.0.1:41234'),
  registryReachable: vi.fn().mockResolvedValue(true),
  registryHost: vi.fn(() => 'yaac-registry.yaac.svc.cluster.local:5000'),
  registryRef: vi.fn((tag: string) => `yaac-registry.yaac.svc.cluster.local:5000/${tag}`),
  registryHasTag: vi.fn().mockResolvedValue(true),
  pushImageToRegistry: vi.fn().mockResolvedValue(
    'yaac-registry.yaac.svc.cluster.local:5000/yaac-cluster-probe:busybox-1.36',
  ),
}))

import { runClusterCheck } from '#drivers/k8s/install'
import type { CheckResult } from '@yaac/shared/types'
import { execFileAsync } from '#drivers/k8s/substrate/api'
import { pushImageToRegistry, registryReachable } from '#drivers/k8s/container/registry'
import { resetClusterCidrCache } from '#drivers/k8s/cluster/cluster-cidrs'
import {
  buildPriorityClassManifests, buildRuntimeClassManifests, GVISOR_NODE_LABEL, WORKSPACE_POOL_KEY,
} from '#drivers/k8s/substrate'
import type { NodeTaint } from '#drivers/k8s/substrate'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { globalRoot, serverLocalRoot } from '@yaac/shared/paths'
import { writeServerConfig } from '@yaac/shared/server-config'

const NS = 'test-ns'
const mockRun = vi.mocked(execFileAsync)
const mockPush = vi.mocked(pushImageToRegistry)
const mockReachable = vi.mocked(registryReachable)

type RunMock = ReturnType<typeof vi.fn<
  (file: string, args: string[], opts?: unknown) => Promise<{ stdout: string; stderr: string }>
>>

/** Every manifest the last run applied, oldest first, as `[manifest]` tuples. */
function applied(): Array<[unknown]> {
  return fakeCluster.callsOf('apply').map((c) => [c.body])
}

/** The script (`sh -c <script>`) of the last probe pod applied under `name`. */
function appliedPodCommand(name: string): string {
  const pod = applied()
    .map((c) => c[0] as { kind?: string; metadata?: { name?: string }; spec?: { containers?: Array<{ command?: string[] }> } })
    .filter((m) => m.kind === 'Pod' && m.metadata?.name === name)
    .pop()
  return pod?.spec?.containers?.[0]?.command?.[2] ?? ''
}

/**
 * The args an applied probe pod got after its script (`sh -c <script> --
 * <args>`), which is how the fakes learn the nonce a peer pod publishes.
 */
function appliedPodArgs(name: string): string[] {
  const pod = applied()
    .map((c) => c[0] as {
      kind?: string
      metadata?: { name?: string }
      spec?: { containers?: Array<{ command?: string[] }> }
    })
    .filter((m) => m.kind === 'Pod' && m.metadata?.name === name)
    .pop()
  const command = pod?.spec?.containers?.[0]?.command ?? []
  return command.slice(command.indexOf('--') + 1)
}

interface LivePriorityClass {
  apiVersion: string
  kind: string
  metadata: { name: string }
  value: number
  preemptionPolicy: string
}

/**
 * The installed PriorityClasses as the apiserver returns them: as applied,
 * except Kubernetes fills in the omitted preemptionPolicy, which the check
 * must tolerate.
 */
function livePriorityClasses(): LivePriorityClass[] {
  return (buildPriorityClassManifests() as unknown as Array<{
    metadata: { name: string }
    value: number
    preemptionPolicy?: string
  }>).map((c) => ({
    apiVersion: 'scheduling.k8s.io/v1',
    kind: 'PriorityClass',
    metadata: { name: c.metadata.name },
    value: c.value,
    preemptionPolicy: c.preemptionPolicy ?? 'PreemptLowerPriority',
  }))
}

/**
 * A dedicated workspace pool's taints (both effects), which the gvisor
 * RuntimeClass tolerates. Admission adds the toleration to every pod using
 * the class.
 */
const POOL_TAINTS: NodeTaint[] = [
  { key: WORKSPACE_POOL_KEY, value: 'true', effect: 'NoSchedule' },
  { key: WORKSPACE_POOL_KEY, value: 'true', effect: 'NoExecute' },
]
/** A pool tainted with a key of its own, which no workspace tolerates. */
const FOREIGN_POOL_TAINTS: NodeTaint[] = [
  { key: 'yaac.dev/sessions', value: 'true', effect: 'NoSchedule' },
  { key: 'yaac.dev/sessions', value: 'true', effect: 'NoExecute' },
]
/** A transient taint kubelet adds and removes on its own. */
const MEMORY_PRESSURE: NodeTaint = {
  key: 'node.kubernetes.io/memory-pressure', effect: 'NoSchedule',
}

/** A node object with the fields the readiness checks read: Ready, cordon and taints. */
function nodeItem(
  name: string,
  opts: {
    ready?: boolean
    cordoned?: boolean
    /** Shorthand for the kubeadm control-plane taint. */
    tainted?: boolean
    taints?: NodeTaint[]
    /**
     * Omit the gVisor installer's node label, as on a node the runtime has
     * not reached yet. The RuntimeClass will not schedule there.
     */
    gvisorLabel?: boolean
    labels?: Record<string, string>
    nodeInfo?: Record<string, string>
  } = {},
): FakeObject {
  const taints = [
    ...(opts.tainted
      ? [{ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' }]
      : []),
    ...(opts.taints ?? []),
  ]
  return {
    apiVersion: 'v1',
    kind: 'Node',
    metadata: {
      name,
      labels: {
        'kubernetes.io/hostname': name,
        ...(opts.gvisorLabel === false ? {} : { [GVISOR_NODE_LABEL]: 'true' }),
        ...opts.labels,
      },
    },
    spec: {
      ...(opts.cordoned ? { unschedulable: true } : {}),
      ...(taints.length > 0 ? { taints } : {}),
    },
    status: {
      conditions: [{ type: 'Ready', status: opts.ready === false ? 'False' : 'True' }],
      addresses: [{ type: 'InternalIP', address: '10.89.0.7' }],
      nodeInfo: {
        architecture: process.arch === 'x64' ? 'amd64' : process.arch,
        osImage: 'Debian GNU/Linux 13 (trixie)',
        containerRuntimeVersion: 'containerd://2.3.4',
        kubeletVersion: 'v1.37.0',
        ...opts.nodeInfo,
      },
    },
  }
}

/** The cluster's nodes; one control-plane node by default. */
let clusterNodes: FakeObject[] = []
/** The RuntimeClasses installed; a case drops one. */
let runtimeClassNames: string[] = []
/** The live PriorityClasses; a case edits. */
let priorityClasses: LivePriorityClass[] = []
/** The server Deployment's pod securityContext, or null for none deployed. */
let serverSecurityContext: Record<string, number> | null = null
/** Pod name -> terminal phase, for probe pods a test wants to fail. */
let podPhases: Record<string, string> = {}
/** Nodes whose gVisor installer pod is not Ready; a case edits. */
let installerNotReady: string[] = []
/** How many nodes still run an older installer revision; a case edits. */
let installerStale = 0
/** Whether the gVisor installer DaemonSet exists; a case edits. */
let installerDeployed = true
/** Whether the end-to-end probe's write reached its peer; a case edits. */
let peerSawWrite = true
/** Pod name -> the kubelet Warning event (`<reason>|<message>`) for a pod that never ran. */
let podEvents: Record<string, string> = {}
/** The storage claims as the apiserver reports them; a case edits. */
let storageClaims: Record<string, { spec: { volumeName: string }; status: { phase: string } }> = {}
/** PV name -> the volume, replacing the static hostPath default; a case edits. */
let volumes: Record<string, { metadata?: Record<string, unknown>; spec: Record<string, unknown> }> = {}
/** The provisioner of the `byo-nfs` StorageClass, or null for no class. */
let storageClassProvisioner: string | null = null
const FSPROBE_ALL_PASS = [
  'PASS  creation ownership (uid passthrough)  uid/gid 1000/1000 preserved',
  'PASS  O_EXCL exclusive create               second create correctly EEXIST',
  'PASS  flock (LOCK_EX)                       flock excludes',
  '',
  '11/11 passed',
].join('\n')
/** The npm cache's Service IP, or null for an install without one; a case edits. */
let npmCacheIp: string | null = null
/** Whether a cache pod is ready behind that Service; a case edits. */
let npmCacheReady = true
/** Service name -> ClusterIP, beyond the apiserver and the npm cache; a case adds. */
let serviceIps: Record<string, string> = {}
/** Whether the deployed proxy has its egress NetworkPolicy; a case edits. */
let proxyEgressPolicy = true
/** `ready/desired` for the two datapath DaemonSets; null for not deployed. */
let datapathReady: Record<'calico-node' | 'yaac-netd', string | null> = { 'calico-node': '1/1', 'yaac-netd': '1/1' }
/** Where calico-node runs: a manifest install's kube-system, or the Tigera operator's calico-system. */
let calicoNamespace = 'kube-system'
/** netd's pods' container statuses; a case edits. */
let netdContainerStatuses: unknown[] = []
/** Pod name -> what its log says, over the healthy defaults; a case edits. */
let podLogs: Record<string, string> = {}

/** Healthy probe logs; the end-to-end probe echoes back its peer's nonce. */
function logsFor(name: string): string {
  if (name in podLogs) return podLogs[name]
  switch (name) {
    case 'yaac-cluster-check-node-2':
      return 'sh: can\'t create /probe/.cluster-check: Permission denied\n'
    case 'yaac-cluster-check-peer':
      return `PEER_NODE=yaac-control-plane\nPEER_RTT_MS=7\nPEER_SAW_WRITE=${peerSawWrite ? 'ok' : ''}\n`
    case 'yaac-cluster-check-gvisor': return 'GVISOR_SANDBOXED\n'
    case 'yaac-cluster-check-fsprobe': return FSPROBE_ALL_PASS
    case 'yaac-cluster-check-egress': return 'NP_BLOCKED\n'
    case 'yaac-cluster-check-npm-cache': return 'NPM_CACHE_OK\n'
    case 'yaac-cluster-check-nested': return 'NESTED_MOUNT_OK\n'
    case 'yaac-cluster-check': {
      const [, nonce] = appliedPodArgs('yaac-cluster-check-peer')
      return `PROBE_NODE=yaac-control-plane\nPROBE_READ=${nonce}\n`
    }
    default: return ''
  }
}

const service = (name: string, namespace: string, ip: string): FakeObject =>
  ({ apiVersion: 'v1', kind: 'Service', metadata: { name, namespace }, spec: { clusterIP: ip } })

function daemonSet(name: string, namespace: string, status: Record<string, number>): FakeObject {
  return { apiVersion: 'apps/v1', kind: 'DaemonSet', metadata: { name, namespace }, status }
}

/** Put the state above into the fake cluster. */
function seedCluster(): void {
  fakeCluster.seed(
    ...clusterNodes,
    ...(priorityClasses as unknown as FakeObject[]),
    ...(buildRuntimeClassManifests() as unknown as FakeObject[])
      .filter((rc) => runtimeClassNames.includes(rc.metadata.name)),
    ...(runtimeClassNames.includes('runc')
      ? [{ apiVersion: 'node.k8s.io/v1', kind: 'RuntimeClass', metadata: { name: 'runc' } }]
      : []),
    ...Object.entries(storageClaims).map(([name, claim]) =>
      ({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name, namespace: NS }, ...claim })),
    ...Object.values(storageClaims).map(({ spec: { volumeName } }) => ({
      apiVersion: 'v1',
      kind: 'PersistentVolume',
      metadata: { name: volumeName, ...volumes[volumeName]?.metadata },
      spec: volumes[volumeName]?.spec ?? {
        persistentVolumeReclaimPolicy: 'Retain',
        hostPath: { path: volumeName.startsWith('yaac-server-local') ? serverLocalRoot() : globalRoot() },
      },
    })).filter((pv) => pv.metadata.name),
    ...(storageClassProvisioner
      ? [{ apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', metadata: { name: 'byo-nfs' }, provisioner: storageClassProvisioner }]
      : []),
    service('kubernetes', 'default', '10.96.0.1'),
    ...Object.entries(serviceIps).map(([name, ip]) => service(name, name === 'yaac-registry' ? 'yaac' : NS, ip)),
    ...(npmCacheIp ? [
      service('yaac-npm-cache', NS, npmCacheIp),
      {
        apiVersion: 'discovery.k8s.io/v1',
        kind: 'EndpointSlice',
        metadata: { name: 'yaac-npm-cache-x', namespace: NS, labels: { 'kubernetes.io/service-name': 'yaac-npm-cache' } },
        endpoints: [{ conditions: { ready: npmCacheReady } }],
      },
    ] : []),
    ...(proxyEgressPolicy
      ? [{ apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: 'yaac-proxy-egress', namespace: NS } }]
      : []),
    ...(serverSecurityContext ? [{
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'yaac-server', namespace: NS },
      spec: { template: { spec: { securityContext: serverSecurityContext } } },
    }] : []),
    ...(installerDeployed ? [daemonSet('yaac-gvisor-install', NS, {
      desiredNumberScheduled: clusterNodes.length,
      numberReady: clusterNodes.length - installerNotReady.length,
      updatedNumberScheduled: clusterNodes.length - installerStale,
    })] : []),
    // The gVisor installer's pods, one per node.
    ...clusterNodes.map((n, i) => ({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: `yaac-gvisor-install-${String(i)}`, namespace: NS, labels: { app: 'yaac-gvisor-install' } },
      spec: { nodeName: n.metadata.name },
      status: { containerStatuses: [{ ready: !installerNotReady.includes(n.metadata.name) }] },
    })),
    ...Object.entries(datapathReady).flatMap(([name, ratio]) => {
      if (ratio === null) return []
      const [ready, desired] = ratio.split('/').map(Number)
      return [daemonSet(name, name === 'calico-node' ? calicoNamespace : NS, {
        numberReady: ready, desiredNumberScheduled: desired,
      })]
    }),
    {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'yaac-netd-0', namespace: NS, labels: { app: 'yaac-netd' } },
      spec: { nodeName: 'yaac-control-plane' },
      status: { phase: 'Running', containerStatuses: netdContainerStatuses },
    },
    // Events outlive a probe pod that never ran; selected by its uid.
    ...Object.entries(podEvents).map(([pod, event]) => {
      const [reason, message] = event.split('|')
      return {
        apiVersion: 'v1',
        kind: 'Event',
        metadata: { name: `${pod}.event`, namespace: NS },
        involvedObject: { uid: `uid-${pod}` },
        type: 'Warning',
        reason,
        message,
      }
    }),
  )
  // A probe pod reaches its terminal phase as soon as it is read, with a
  // uid its events can name.
  fakeCluster.intercept((call) => {
    if (call.verb !== 'read' || call.kind !== 'Pod' || !call.name) return
    const pod = fakeCluster.get<FakeObject>('Pod', call.name, call.namespace)
    if (!pod || pod.status) return
    fakeCluster.seed({
      ...pod,
      metadata: { ...pod.metadata, uid: `uid-${call.name}` },
      status: { phase: podPhases[call.name] ?? 'Succeeded' },
    })
  })
}

/** Run the check against a fresh fake cluster built from the state above. */
async function check(): ReturnType<typeof runClusterCheck> {
  fakeCluster.reset()
  seedCluster()
  return runClusterCheck()
}

/**
 * The child processes on the all-pass path: kubectl and podman present,
 * the kind node fixups applied, and netd's routes naming two workload veths.
 */
function happyResponses(
  file: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return Promise.resolve(happyResponse(file, args))
}

function happyResponse(file: string, args: string[]): { stdout: string; stderr: string } {
  if (file === 'kubectl' && args[0] === 'exec' && args.includes('route')) {
    // A healthy Calico node: two workload veths under the default prefix.
    return {
      stdout: '10.244.169.193 dev calibb6b64b7901 scope link\n'
        + '10.244.169.197 dev calia132c78e002 scope link\n',
      stderr: '',
    }
  }
  if (file === 'podman' && args[0] === 'exec') {
    return { stdout: 'hk=ok\n', stderr: '' }
  }
  if (file === 'podman' && args[0] === 'inspect') {
    return { stdout: '32768\n', stderr: '' }
  }
  return { stdout: '', stderr: '' }
}

function happyRun(): RunMock {
  return vi.fn(happyResponses)
}

/**
 * A byo install's global volume as install leaves it: NFS-provisioned,
 * labelled, Retain, with the lowered actimeo.
 */
function byoGlobalVolume(): {
  metadata: { labels: Record<string, string> }
  spec: Record<string, unknown>
} {
  return {
    metadata: { labels: { 'yaac.data-dir-hash': 'ddh16', 'yaac.claim': 'yaac-global' } },
    spec: {
      persistentVolumeReclaimPolicy: 'Retain',
      storageClassName: 'byo-nfs',
      csi: { driver: 'nfs.csi.k8s.io', volumeAttributes: { server: '10.96.5.5' } },
      mountOptions: ['nfsvers=4.1', 'hard', 'actimeo=1'],
    },
  }
}

interface Staged {
  run: RunMock
  pushImage: typeof mockPush
}

/**
 * Install the process and registry fakes one check run needs (subprocess
 * runner, registry ping and push) and return their call records.
 */
function stage(overrides: { run?: RunMock; registryReachable?: boolean } = {}): Staged {
  const run = overrides.run ?? happyRun()
  mockRun.mockClear()
  mockPush.mockClear()
  mockRun.mockImplementation(run as never)
  mockReachable.mockResolvedValue(overrides.registryReachable ?? true)
  mockPush.mockResolvedValue('localhost:5000/yaac-cluster-probe:busybox-1.36')
  return { run, pushImage: mockPush }
}

/** What the registry answers an anonymous upload; null for no answer. */
let gateStatus: number | null = 401
const gateProbes: Array<{ url: string; method?: string }> = []

function byName(results: CheckResult[], name: string): CheckResult | undefined {
  return results.find((r) => r.name === name)
}

describe('runClusterCheck', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    resetClusterCidrCache()
    clusterNodes = [nodeItem('yaac-control-plane')]
    runtimeClassNames = ['gvisor', 'gvisor-nested', 'runc']
    priorityClasses = livePriorityClasses()
    serverSecurityContext = null
    podPhases = {}
    installerNotReady = []
    installerStale = 0
    installerDeployed = true
    peerSawWrite = true
    podEvents = {}
    storageClaims = {
      'yaac-global': { spec: { volumeName: 'yaac-global-ddh' }, status: { phase: 'Bound' } },
      'yaac-server-local': { spec: { volumeName: 'yaac-server-local-ddh' }, status: { phase: 'Bound' } },
      'yaac-checkouts': { spec: { volumeName: 'yaac-checkouts-ddh' }, status: { phase: 'Bound' } },
    }
    volumes = {}
    storageClassProvisioner = null
    npmCacheIp = '10.96.4.2'
    npmCacheReady = true
    serviceIps = {}
    proxyEgressPolicy = true
    datapathReady = { 'calico-node': '1/1', 'yaac-netd': '1/1' }
    calicoNamespace = 'kube-system'
    netdContainerStatuses = []
    podLogs = {}
    vi.spyOn(fakeCluster.podLogs, 'get').mockImplementation(logsFor)
    // The registry's write gate refuses an anonymous upload.
    gateStatus = 401
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      gateProbes.push({ url, method: init?.method })
      return gateStatus === null
        ? Promise.reject(new Error('ECONNRESET'))
        : Promise.resolve({ status: gateStatus } as Response)
    }))
    gateProbes.length = 0
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await cleanupTempDir(tmpDir)
  })

  it('passes every check on a healthy single-node cluster', async () => {
    const deps = stage()
    const { ok, results } = await check()

    expect(results.map((r) => [r.name, r.status])).toEqual([
      ['kubectl', 'pass'],
      ['cluster', 'pass'],
      ['nodes', 'pass'],
      ['architecture', 'pass'],
      ['node-os', 'pass'],
      ['podman', 'pass'],
      ['registry', 'pass'],
      ['namespace', 'pass'],
      ['storage', 'pass'],
      ['priority-classes', 'pass'],
      ['node-fixups', 'pass'],
      ['gvisor', 'pass'],
      ['gvisor-installer', 'pass'],
      ['probe', 'pass'],
      ['egress', 'pass'],
      ['npm-cache', 'pass'],
      ['datapath', 'pass'],
      // Checked on every run: netd can be Ready with zero pod-to-veth
      // mappings, so nothing else would notice a wrong prefix.
      ['veth-source', 'pass'],
      // Skipped on one node; the checks above cover it.
      ['per-node', 'skip'],
      ['nested-mount', 'pass'],
      ['storage-semantics', 'pass'],
      ['vap', 'pass'],
    ])
    expect(ok).toBe(true)
    expect(byName(results, 'datapath')?.detail).toContain('calico-node and yaac-netd ready')

    expect(deps.pushImage).toHaveBeenCalledWith('yaac-cluster-probe:busybox-1.36')
    const probePod = applied()
      .map((c) => c[0] as { kind: string; metadata?: { name?: string } })
      .find((m) => m.kind === 'Pod' && m.metadata?.name === 'yaac-cluster-check')
    expect(probePod).toBeDefined()
    const podManifest = probePod as {
      kind: string
      spec: {
        hostUsers?: boolean
        runtimeClassName?: string
        securityContext: {
          seccompProfile: { type: string }
          runAsUser?: number
          supplementalGroups?: number[]
        }
        containers: Array<{
          securityContext?: { runAsUser?: number }
          volumeMounts: Array<{ readOnly?: boolean }>
        }>
        volumes: Array<{ hostPath?: { path: string }; persistentVolumeClaim?: { claimName: string } }>
      }
    }
    expect(podManifest.kind).toBe('Pod')
    // The global claim, as workspace pods mount it.
    expect(podManifest.spec.volumes[0].persistentVolumeClaim?.claimName).toBe('yaac-global')
    // Like a workspace pod: gvisor, no user namespace.
    expect(podManifest.spec.runtimeClassName).toBe('gvisor')
    expect(podManifest.spec.hostUsers).toBeUndefined()
    // Same identity as a workspace pod, with a read-write mount.
    expect(podManifest.spec.securityContext).toEqual({
      seccompProfile: { type: 'RuntimeDefault' },
      runAsUser: process.getuid?.(),
      runAsGroup: process.getgid?.(),
      supplementalGroups: [0],
    })
    expect(podManifest.spec.containers[0].securityContext).toBeUndefined()
    expect(podManifest.spec.containers[0].volumeMounts[0].readOnly).toBeUndefined()
    // The peer runs like the server: runc, same identity, the whole claim
    // mounted. It prefers a different node, to measure a cross-node round
    // trip.
    const peer = applied()
      .map((c) => c[0] as typeof podManifest & {
        metadata: { name: string }
        spec: { affinity?: Record<string, unknown> }
      })
      .find((m) => m.kind === 'Pod' && m.metadata.name === 'yaac-cluster-check-peer')
    expect(peer?.spec.runtimeClassName).toBeUndefined()
    expect(peer?.spec.volumes[0].persistentVolumeClaim?.claimName).toBe('yaac-global')
    expect(peer?.spec.securityContext).toEqual(podManifest.spec.securityContext)
    expect(JSON.stringify(peer?.spec.affinity)).toContain('podAntiAffinity')
    expect(byName(results, 'probe')?.detail).toContain('round trip 7ms')
    expect(byName(results, 'probe')?.detail).not.toContain('cross-node')
  })

  it('runs its probe pods at the identity the server Deployment records, not this machine\'s', async () => {
    // A byo install from a laptop: the Deployment records the install uid,
    // and only that uid can write the claim.
    serverSecurityContext = { runAsUser: 4242, runAsGroup: 4242 }
    stage()
    const { results } = await check()
    const pods = applied()
      .map((c) => c[0] as { kind: string; metadata?: { name?: string }; spec?: { securityContext?: { runAsUser?: number } } })
      .filter((m) => m.kind === 'Pod'
        && ['yaac-cluster-check', 'yaac-cluster-check-peer', 'yaac-cluster-check-fsprobe'].includes(m.metadata?.name ?? ''))
    expect(pods).toHaveLength(3)
    for (const pod of pods) expect(pod.spec?.securityContext?.runAsUser).toBe(4242)
    expect(byName(results, 'probe')?.detail).toContain('uid 4242')
  })

  it('reports an unreadable install identity as itself rather than probing at a guess', async () => {
    // At the wrong uid the probes would fail misleadingly; the read failure
    // is the real diagnosis.
    stage()
    fakeCluster.reset()
    seedCluster()
    fakeCluster.intercept((call) => {
      if (call.kind === 'Deployment') throw apiError(500, 'Unable to connect to the server: dial tcp: i/o timeout')
    })
    const { ok, results } = await runClusterCheck()
    expect(ok).toBe(false)
    expect(byName(results, 'probe')).toMatchObject({ status: 'fail' })
    expect(byName(results, 'probe')?.detail).toMatch(/could not read the install identity .*i\/o timeout/)
    expect(byName(results, 'egress')?.status).toBe('skip')
    expect(applied().map((c) => (c[0] as { metadata?: { name?: string } }).metadata?.name))
      .not.toContain('yaac-cluster-check-peer')
  })

  it('warns rather than crashing when the node list cannot be read', async () => {
    stage()
    fakeCluster.reset()
    seedCluster()
    fakeCluster.intercept((call) => {
      if (call.verb === 'list' && call.kind === 'Node') throw apiError(500, 'connection refused')
    })
    const { results } = await runClusterCheck()
    // Node count is advisory, so an unreadable list only warns.
    expect(byName(results, 'nodes')).toMatchObject({ status: 'warn' })
    expect(byName(results, 'nodes')?.detail).toMatch(/could not list nodes.*connection refused/)
  })

  it('fails the namespace check with a rights hint when the namespace cannot be created', async () => {
    stage()
    fakeCluster.reset()
    seedCluster()
    fakeCluster.intercept((call) => {
      if (call.verb === 'apply' && call.kind === 'Namespace') throw apiError(403, 'namespaces is forbidden')
    })
    const { ok, results } = await runClusterCheck()
    expect(ok).toBe(false)
    expect(byName(results, 'namespace')).toMatchObject({ status: 'fail' })
    expect(byName(results, 'namespace')?.detail).toMatch(/cannot create namespace.*forbidden/)
    expect(byName(results, 'namespace')?.fix).toMatch(/admin rights/)
  })

  it('short-circuits with a single failure when kubectl is missing', async () => {
    const run = vi.fn((file: string, args: string[]) => {
      if (file === 'kubectl' && args.includes('--client')) {
        return Promise.reject(new Error('ENOENT: kubectl'))
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }) as RunMock
    stage({ run })
    const { ok, results } = await check()

    expect(ok).toBe(false)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ name: 'kubectl', status: 'fail' })
    expect(results[0].fix).toContain('Install kubectl')
  })

  it('names the yaac-cluster formula for missing tools on macOS', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      const run = vi.fn((file: string, args: string[]) => {
        if (file === 'kubectl' && args.includes('--client')) return Promise.reject(new Error('ENOENT: kubectl'))
        return Promise.resolve({ stdout: '', stderr: '' })
      }) as RunMock
      stage({ run })
      const { results } = await check()
      expect(results[0].fix).toContain('brew install bsklaroff/yaac/yaac-cluster')
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('short-circuits after the cluster check when the API server is unreachable', async () => {
    stage()
    fakeCluster.reset()
    fakeCluster.unreachable = new Error('connect ECONNREFUSED 127.0.0.1:6443')
    const { ok, results } = await runClusterCheck()

    expect(ok).toBe(false)
    expect(results.map((r) => r.name)).toEqual(['kubectl', 'cluster'])
    expect(byName(results, 'cluster')).toMatchObject({ status: 'fail' })
    expect(byName(results, 'cluster')?.detail).toBe('API server unreachable (connect ECONNREFUSED 127.0.0.1:6443)')
  })

  it('runs a session pod on every session-eligible node of a multi-node cluster', async () => {
    // What `--nodes 3` produces: kind keeps the control-plane taint once
    // there are workers, so workspaces run on the workers.
    clusterNodes = [
      nodeItem('yaac-control-plane', { tainted: true }),
      nodeItem('yaac-worker'),
      nodeItem('yaac-worker2'),
    ]
    stage()
    const { ok, results } = await check()

    expect(ok).toBe(true)
    // The excluded node is named with its taint, since "2 of 3" alone does
    // not say why.
    expect(byName(results, 'nodes')?.detail).toBe(
      '3 nodes, 2 able to schedule sessions; skipping yaac-control-plane '
      + '(untolerated taint node-role.kubernetes.io/control-plane:NoSchedule)',
    )
    const perNode = byName(results, 'per-node')
    expect(perNode).toMatchObject({ status: 'pass' })
    expect(perNode?.detail).toContain('all 2 session-capable nodes')
    expect(perNode?.detail).toContain(
      'not swept: yaac-control-plane (untolerated taint node-role.kubernetes.io/control-plane:NoSchedule)',
    )

    // One pod per eligible node, pinned by nodeName, on the gvisor tier, at
    // the workspace identity, writing the global claim.
    const nodePods = applied()
      .map((c) => c[0] as {
        metadata?: { name?: string }
        spec?: {
          nodeName?: string
          runtimeClassName?: string
          tolerations?: unknown[]
          securityContext?: { runAsUser?: number; supplementalGroups?: number[] }
          containers: Array<{ imagePullPolicy?: string }>
          volumes: Array<{ persistentVolumeClaim?: { claimName: string } }>
        }
      })
      .filter((m) => m.metadata?.name?.startsWith('yaac-cluster-check-node-'))
    expect(nodePods.map((p) => p.spec?.nodeName).sort()).toEqual(['yaac-worker', 'yaac-worker2'])
    for (const pod of nodePods) {
      expect(pod.spec?.runtimeClassName).toBe('gvisor')
      // Only what the RuntimeClass declares, as for a workspace pod.
      expect(pod.spec?.tolerations).toBeUndefined()
      // Always, so a cached layer cannot hide an unreachable registry.
      expect(pod.spec?.containers[0].imagePullPolicy).toBe('Always')
      expect(pod.spec?.securityContext?.runAsUser).toBe(process.getuid?.())
      expect(pod.spec?.securityContext?.supplementalGroups).toEqual([0])
      expect(pod.spec?.volumes[0].persistentVolumeClaim?.claimName).toBe('yaac-global')
    }
  })

  it('names each node a session pod cannot run on, with the kubelet\'s reason', async () => {
    // worker has no runsc handler, worker2 cannot mount the claim, and
    // worker3 is one the gVisor installer has not labelled, so it is
    // reported without being probed.
    clusterNodes = [
      nodeItem('yaac-control-plane', { tainted: true }),
      nodeItem('yaac-worker'),
      nodeItem('yaac-worker2'),
      nodeItem('yaac-worker4'),
      nodeItem('yaac-worker3', { gvisorLabel: false }),
    ]
    podPhases = {
      'yaac-cluster-check-node-0': 'Failed',
      'yaac-cluster-check-node-1': 'Failed',
      'yaac-cluster-check-node-2': 'Failed',
    }
    podEvents = {
      'yaac-cluster-check-node-0': 'FailedCreatePodSandBox|no runtime for "runsc" is configured',
      'yaac-cluster-check-node-1':
        'FailedMount|MountVolume.SetUp failed: hostPath type check failed: /home/x is not a directory',
    }
    stage()
    const { ok, results } = await check()

    // Advisory: never fails the run.
    expect(ok).toBe(true)
    const perNode = byName(results, 'per-node')
    expect(perNode).toMatchObject({ status: 'warn' })
    expect(perNode?.detail).toContain(`yaac-worker3 (no ${GVISOR_NODE_LABEL} label)`)
    expect(perNode?.detail).toContain('yaac-worker (FailedCreatePodSandBox: no runtime for "runsc"')
    expect(perNode?.detail).toContain('yaac-worker2 (FailedMount: MountVolume.SetUp failed')
    // A nonzero exit raises no event, so the pod's log names the cause.
    expect(perNode?.detail).toContain('yaac-worker4 (phase Failed: sh: can\'t create /probe/.cluster-check: Permission denied)')
    expect(perNode?.fix).toContain('yaac cluster install')
    expect(perNode?.fix).toContain('extraMount')
    const probed = applied()
      .map((c) => c[0] as { metadata?: { name?: string }; spec?: { nodeName?: string } })
      .filter((m) => m.metadata?.name?.startsWith('yaac-cluster-check-node-'))
      .map((m) => m.spec?.nodeName)
    expect(probed).toEqual(['yaac-worker', 'yaac-worker2', 'yaac-worker4'])
  })

  it('leaves NotReady and cordoned nodes out of the per-node sweep', async () => {
    clusterNodes = [
      nodeItem('yaac-control-plane'),
      nodeItem('yaac-worker', { ready: false }),
      nodeItem('yaac-worker2', { cordoned: true }),
    ]
    stage()
    const { ok, results } = await check()

    expect(ok).toBe(true)
    // The inventory flags the node that can run nothing.
    expect(byName(results, 'nodes')).toMatchObject({ status: 'warn' })
    expect(byName(results, 'nodes')?.detail).toContain('NotReady: yaac-worker')
    const probed = applied()
      .map((c) => c[0] as { metadata?: { name?: string }; spec?: { nodeName?: string } })
      .filter((m) => m.metadata?.name?.startsWith('yaac-cluster-check-node-'))
      .map((m) => m.spec?.nodeName)
    expect(probed).toEqual(['yaac-control-plane'])
    expect(byName(results, 'per-node')).toMatchObject({ status: 'pass' })
    expect(byName(results, 'per-node')?.detail)
      .toContain('not swept: yaac-worker (NotReady), yaac-worker2 (cordoned)')
  })

  it('treats a pool tainted with the workspace pool key as usable', async () => {
    // The gvisor RuntimeClass tolerates the key, and so does every probe pod.
    clusterNodes = [
      nodeItem('yaac-control-plane', { tainted: true }),
      nodeItem('yaac-pool-1', { taints: POOL_TAINTS }),
      // A pool node under memory pressure genuinely cannot take a workspace,
      // and stays visible as such.
      nodeItem('yaac-pool-2', { taints: [...POOL_TAINTS, MEMORY_PRESSURE] }),
    ]
    stage()
    const { ok, results } = await check()

    expect(ok).toBe(true)
    expect(byName(results, 'nodes')?.detail).toContain('3 nodes, 1 able to schedule sessions')
    expect(byName(results, 'nodes')?.detail).toContain(
      'yaac-pool-2 (untolerated taint node.kubernetes.io/memory-pressure:NoSchedule)',
    )
    const probed = applied()
      .map((c) => c[0] as { metadata?: { name?: string }; spec?: { nodeName?: string } })
      .filter((m) => m.metadata?.name?.startsWith('yaac-cluster-check-node-'))
      .map((m) => m.spec?.nodeName)
    expect(probed).toEqual(['yaac-pool-1'])
    expect(byName(results, 'per-node')).toMatchObject({ status: 'pass' })
    expect(byName(results, 'per-node')?.detail).toContain(
      'yaac-pool-2 (untolerated taint node.kubernetes.io/memory-pressure:NoSchedule)',
    )
  })

  it('leaves infrastructure-only nodes out, and skips the sandboxed gates while no other node is up', async () => {
    // An EKS-style system node labelled infrastructure-only beside a
    // tainted worker: only the worker is swept.
    clusterNodes = [
      nodeItem('system-1', { labels: { [WORKSPACE_POOL_KEY]: 'false' } }),
      nodeItem('pool-1', { taints: POOL_TAINTS }),
    ]
    stage()
    let { results } = await check()
    expect(byName(results, 'nodes')).toMatchObject({ status: 'pass' })
    expect(byName(results, 'nodes')?.detail)
      .toContain(`skipping system-1 (infrastructure only (${WORKSPACE_POOL_KEY}=false))`)
    const probed = applied()
      .map((c) => c[0] as { metadata?: { name?: string }; spec?: { nodeName?: string } })
      .filter((m) => m.metadata?.name?.startsWith('yaac-cluster-check-node-'))
      .map((m) => m.spec?.nodeName)
    expect(probed).toEqual(['pool-1'])

    // The pool scaled to zero: nowhere to run a sandboxed pod. The check
    // still passes; those gates skip and no probe pod starts, while the
    // rest still run.
    clusterNodes = [nodeItem('system-1', { labels: { [WORKSPACE_POOL_KEY]: 'false' } })]
    stage()
    const idle = await check()
    results = idle.results
    expect(idle.ok).toBe(true)
    expect(byName(results, 'nodes')).toMatchObject({ status: 'warn' })
    expect(byName(results, 'nodes')?.detail).toContain('1 node(s), none taking workspaces')
    expect(byName(results, 'nodes')?.detail).toContain('the gates that run a sandboxed pod are skipped')
    for (const gate of ['gvisor', 'probe', 'egress', 'npm-cache', 'nested-mount', 'per-node', 'storage-semantics']) {
      expect(byName(results, gate)).toMatchObject({ status: 'skip' })
      expect(byName(results, gate)?.detail).toContain('no Ready node takes workspaces')
    }
    for (const gate of ['gvisor-installer', 'datapath', 'veth-source', 'vap']) {
      expect(byName(results, gate)?.status).not.toBe('skip')
    }
    expect(applied().map((c) => (c[0] as { metadata?: { name?: string } }).metadata?.name)
      .filter((n) => n?.startsWith('yaac-cluster-check'))).toEqual([])

    // A pool node that is up but unusable is not an idle pool: the
    // sandboxed gates run, and the fix is the scheduling one.
    for (const pool of [
      nodeItem('pool-1', { taints: FOREIGN_POOL_TAINTS }),
      nodeItem('pool-1', { taints: POOL_TAINTS, cordoned: true }),
    ]) {
      clusterNodes = [nodeItem('system-1', { labels: { [WORKSPACE_POOL_KEY]: 'false' } }), pool]
      stage()
      results = (await check()).results
      expect(byName(results, 'nodes')).toMatchObject({ status: 'warn' })
      expect(byName(results, 'nodes')?.detail).toContain('none able to schedule a session')
      expect(byName(results, 'nodes')?.fix).toContain(`taint it with the ${WORKSPACE_POOL_KEY} key`)
      for (const gate of ['gvisor', 'probe']) {
        expect(byName(results, gate)?.detail ?? '').not.toContain('no Ready node takes workspaces')
      }
    }
  })

  it('points a pool tainted with a key of its own at the pool key, not at removing the taint', async () => {
    // No workspace tolerates the pool's own key, but the fix must not be
    // removing the taint that keeps other workloads off it.
    clusterNodes = [
      nodeItem('yaac-pool-1', { taints: FOREIGN_POOL_TAINTS }),
      nodeItem('yaac-pool-2', { taints: FOREIGN_POOL_TAINTS }),
    ]
    stage()
    const { ok, results } = await check()

    expect(ok).toBe(true)
    const nodes = byName(results, 'nodes')
    expect(nodes).toMatchObject({ status: 'warn' })
    expect(nodes?.detail).toContain('2 node(s), none able to schedule a session')
    expect(nodes?.detail).toContain(
      'yaac-pool-1 (untolerated taint yaac.dev/sessions=true:NoSchedule, '
      + 'yaac.dev/sessions=true:NoExecute)',
    )
    expect(nodes?.fix).toContain(`taint it with the ${WORKSPACE_POOL_KEY} key`)
    expect(nodes?.fix).toContain('rather than removing the taint')
    // The per-node check names the nodes too, rather than passing over an
    // empty set.
    expect(byName(results, 'per-node')).toMatchObject({ status: 'warn' })
    expect(byName(results, 'per-node')?.detail).toContain('no node can schedule a session')
    expect(byName(results, 'per-node')?.detail).toContain('yaac-pool-1 (untolerated taint')
  })

  it('skips the end-to-end probe when an earlier check failed', async () => {
    const run = happyRun()
    run.mockImplementation((file: string, args: string[]) => {
      if (file === 'podman' && args[0] === '--version') {
        return Promise.reject(new Error('podman missing'))
      }
      return happyResponses(file, args)
    })
    const deps = stage({ run })
    const { ok, results } = await check()

    expect(ok).toBe(false)
    expect(byName(results, 'podman')).toMatchObject({ status: 'fail' })
    expect(byName(results, 'node-fixups')).toMatchObject({ status: 'skip' })
    expect(byName(results, 'gvisor-installer')).toMatchObject({ status: 'skip' })
    expect(byName(results, 'probe')).toMatchObject({ status: 'skip' })
    expect(byName(results, 'egress')).toMatchObject({ status: 'skip' })
    expect(byName(results, 'datapath')).toMatchObject({ status: 'skip' })
    expect(byName(results, 'nested-mount')).toMatchObject({ status: 'skip' })
    expect(deps.pushImage).not.toHaveBeenCalled()
    // No probe object was applied (the namespace ensure may still have run).
    const appliedKinds = applied().map((c) => (c[0] as { kind: string }).kind)
    expect(appliedKinds).not.toContain('Pod')
  })

  it('warns on node-fixups (pointing at install) when a kind fixup went missing', async () => {
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'podman' && args[0] === 'exec') {
        return { stdout: 'hk=missing\n', stderr: '' }
      }
      if (file === 'podman' && args[0] === 'inspect') {
        return { stdout: '2048\n', stderr: '' } // podman's default pids ceiling
      }
      return happyResponses(file, args)
    })
    stage({ run })
    const { ok, results } = await check()
    const fixups = byName(results, 'node-fixups')
    expect(fixups).toMatchObject({ status: 'warn' })
    expect(fixups?.detail).toContain('kubelet housekeeping-interval')
    expect(fixups?.detail).toContain('pids-limit')
    expect(fixups?.fix).toContain('yaac cluster install')
    expect(ok).toBe(true) // warn-only: these fixups fail late, not at pod start
  })

  it('skips node-fixups when the node is not a podman container (non-kind backend)', async () => {
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'podman' && args[0] === 'exec') {
        return Promise.reject(new Error('no such container'))
      }
      return happyResponses(file, args)
    })
    stage({ run })
    const { results } = await check()
    const fixups = byName(results, 'node-fixups')
    expect(fixups).toMatchObject({ status: 'skip' })
    expect(fixups?.detail).toContain('not a podman container')
  })

  it('warns on gvisor-installer, naming the nodes whose installer pod is not Ready', async () => {
    // The installer marks its pod Ready only after a pass, e.g. not yet on
    // a node that just restarted.
    clusterNodes = [nodeItem('yaac-control-plane'), nodeItem('yaac-worker'), nodeItem('yaac-worker2')]
    installerNotReady = ['yaac-worker2']
    stage()
    const { ok, results } = await check()
    const installer = byName(results, 'gvisor-installer')
    expect(installer).toMatchObject({ status: 'warn' })
    expect(installer?.detail).toBe('Ready on 2 of 3 node(s), current revision on 3; not ready on yaac-worker2')
    expect(installer?.fix).toContain('logs -l app=yaac-gvisor-install')
    expect(installer?.fix).toContain('yaac cluster install')
    expect(ok).toBe(true) // warn-only: the installer's next pass repairs it

    // A new revision that fails to roll out leaves the old pods Ready.
    installerNotReady = []
    installerStale = 1
    stage()
    const stale = byName((await check()).results, 'gvisor-installer')
    expect(stale).toMatchObject({ status: 'warn', detail: 'Ready on 3 of 3 node(s), current revision on 2' })
    installerStale = 0

    // No DaemonSet at all warns too.
    installerDeployed = false
    const none = byName((await check()).results, 'gvisor-installer')
    expect(none).toMatchObject({ status: 'warn', detail: expect.stringContaining('not deployed') as string })
  })

  it('fails priority-classes (and skips the probes) when a class is missing', async () => {
    // The apiserver rejects a pod naming a missing class, so a workspace
    // Job would apply and then hang with no pod.
    priorityClasses = livePriorityClasses().filter((c) => c.metadata.name !== 'yaac-workspace')
    stage()
    const { ok, results } = await check()
    expect(ok).toBe(false)
    const pcs = byName(results, 'priority-classes')
    expect(pcs).toMatchObject({ status: 'fail' })
    expect(pcs?.detail).toContain('yaac-workspace')
    expect(pcs?.fix).toContain('yaac cluster install')
    expect(byName(results, 'probe')).toMatchObject({ status: 'skip' })
  })

  it('warns (without failing) when an installed PriorityClass has drifted', async () => {
    // Different values still schedule, just ranked wrong, so only a warning.
    priorityClasses = livePriorityClasses().map((c) =>
      c.metadata.name === 'yaac-infra' ? { ...c, value: 42 } : c)
    stage()
    const { ok, results } = await check()
    expect(ok).toBe(true)
    const pcs = byName(results, 'priority-classes')
    expect(pcs).toMatchObject({ status: 'warn' })
    expect(pcs?.detail).toContain('yaac-infra')
    expect(byName(results, 'probe')).toMatchObject({ status: 'pass' })
  })

  it('fails gvisor (and skips the probes) when a RuntimeClass is missing', async () => {
    runtimeClassNames = ['runc']
    stage()
    const { ok, results } = await check()
    expect(ok).toBe(false)
    const gvisor = byName(results, 'gvisor')
    expect(gvisor).toMatchObject({ status: 'fail' })
    expect(gvisor?.detail).toContain('gvisor-nested')
    expect(gvisor?.fix).toContain('yaac cluster install')
    // A gvisor pod would sit Pending, so the probes are skipped.
    expect(byName(results, 'probe')).toMatchObject({ status: 'skip' })
    expect(byName(results, 'egress')).toMatchObject({ status: 'skip' })
  })

  it('fails gvisor when a pod on the gvisor class is not sentry-sandboxed', async () => {
    // The handler ran the pod on runc: no gVisor boot messages in the ring
    // buffer.
    podLogs['yaac-cluster-check-gvisor'] = 'GVISOR_NOT_SANDBOXED\n'
    stage()
    const { ok, results } = await check()
    expect(ok).toBe(false)
    expect(byName(results, 'gvisor')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('not sentry-sandboxed') as string,
    })
  })

  it('passes the egress check when a session-labeled pod cannot reach the apiserver', async () => {
    stage()
    const { results } = await check()
    expect(byName(results, 'egress')).toMatchObject({
      status: 'pass',
      detail: expect.stringContaining('default-denied at the CNI') as string,
    })
  })

  it('fails the egress check when the CNI does not enforce NetworkPolicy', async () => {
    podLogs['yaac-cluster-check-egress'] = 'NP_REACHED\n'
    stage()
    const { ok, results } = await check()
    expect(ok).toBe(false)
    const egress = byName(results, 'egress')
    expect(egress).toMatchObject({ status: 'fail' })
    expect(egress?.detail).toContain('not enforcing NetworkPolicy')
    expect(egress?.fix).toContain('Calico')
  })

  it.each([
    ['dial a transparent port (forgery lock open)', 'yaac-proxy', 'PROXY', 'forgery lock is open', 'proxy-ingress'],
    // Either server policy could be the missing one, so the fix names both.
    ['reach the yaac server', 'yaac-server', 'SERVER', 'reached the yaac server',
      'yaac-server-ingress and yaac-server-ingress-front'],
    ['reach the image registry', 'yaac-registry', 'REGISTRY', 'reached the image registry', 'builder'],
  ])('fails the egress check when a session pod can %s', async (_, svc, key, detail, fix) => {
    serviceIps[svc] = '10.96.7.7'
    podLogs['yaac-cluster-check-egress'] = `NP_BLOCKED\nNP_${key}_OPEN\n`
    stage()
    const { ok, results } = await check()
    expect(ok).toBe(false)
    const egress = byName(results, 'egress')
    expect(egress).toMatchObject({ status: 'fail' })
    expect(egress?.detail).toContain(detail)
    expect(egress?.fix).toContain(fix)
    const pod = applied()
      .map((c) => c[0] as { metadata?: { name?: string }; spec?: { containers?: Array<{ command: string[] }> } })
      .find((m) => m.metadata?.name === 'yaac-cluster-check-egress')
    expect(pod?.spec?.containers?.[0].command[2]).toContain('nc -w 4 10.96.7.7 ')
  })

  it('fails the egress check when the deployed proxy has no egress policy', async () => {
    // The proxy dials whatever a `*` allowlist names, including the kind
    // fronting's node port, where the server would treat it as the node.
    // This checks the proxy's egress policy blocks that.
    serviceIps['yaac-proxy'] = '10.96.7.7'
    proxyEgressPolicy = false
    stage()
    const { ok, results } = await check()
    expect(ok).toBe(false)
    const egress = byName(results, 'egress')
    expect(egress).toMatchObject({ status: 'fail' })
    expect(egress?.detail).toContain('yaac-proxy-egress')
    expect(egress?.fix).toContain('yaac server restart')
  })

  // A workspace pod fetching through the Service checks the egress rule,
  // the cache's ingress policy and its route out at once.
  it('passes npm-cache when a session pod fetches a package through the Service\'s IP', async () => {
    stage()
    const { results } = await check()

    expect(byName(results, 'npm-cache')?.status).toBe('pass')
    const pod = applied().map((c) => c[0] as {
      kind: string
      metadata: { name: string; labels: Record<string, string> }
      spec: { runtimeClassName?: string; containers: Array<{ command: string[] }> }
    }).find((m) => m.metadata.name === 'yaac-cluster-check-npm-cache')
    expect(pod?.metadata.labels['yaac.workspace-id']).toBeDefined()
    expect(pod?.metadata.labels['yaac.npm-cache']).toBe('true')
    expect(pod?.spec.runtimeClassName).toBe('gvisor')
    expect(pod?.spec.containers[0].command[2])
      .toContain('http://10.96.4.2:4873/is-number/-/is-number-7.0.0.tgz')
  })

  it('warns, without failing, on an install with no npm cache', async () => {
    npmCacheIp = null
    stage()
    const { ok, results } = await check()

    expect(byName(results, 'npm-cache')?.status).toBe('warn')
    expect(byName(results, 'npm-cache')?.fix).toContain('yaac cluster install')
    expect(ok).toBe(true)
  })

  // Workspaces are not pointed at a cache with no ready pod, so this only
  // slows installs.
  it('warns, without probing, when the npm cache has no ready pod', async () => {
    npmCacheReady = false
    stage()
    const { ok, results } = await check()

    expect(byName(results, 'npm-cache')).toMatchObject({ status: 'warn' })
    expect(byName(results, 'npm-cache')?.detail).toContain('no ready pod')
    expect(applied().some((c) =>
      (c[0] as { metadata?: { name?: string } }).metadata?.name === 'yaac-cluster-check-npm-cache')).toBe(false)
    expect(ok).toBe(true)
  })

  // With a ready pod, workspaces use the cache, so one that cannot serve
  // breaks every install.
  it('fails npm-cache when the Service does not serve', async () => {
    podLogs['yaac-cluster-check-npm-cache'] = 'wget: server returned error: HTTP/1.1 503\nNPM_CACHE_FAILED\n'
    stage()
    const { ok, results } = await check()

    expect(byName(results, 'npm-cache')?.status).toBe('fail')
    expect(byName(results, 'npm-cache')?.detail).toContain('503')
    expect(ok).toBe(false)
  })

  it('passes datapath when calico-node and netd are both rolled out', async () => {
    stage()
    const { results } = await check()
    expect(byName(results, 'datapath')).toMatchObject({
      status: 'pass',
      detail: expect.stringContaining('policy enforced, egress redirected') as string,
    })

    // The Tigera operator (EKS, AKS) runs calico-node in calico-system.
    calicoNamespace = 'calico-system'
    stage()
    const operator = await check()
    expect(byName(operator.results, 'datapath')).toMatchObject({ status: 'pass' })
  })

  it('fails veth-source when the redirect resolves no workload veth, though netd is Ready', async () => {
    // netd is Ready once Envoy acks its config, even with zero pod-to-veth
    // mappings, so a wrong prefix leaves every workspace without egress while
    // the datapath check passes. Checked every run, since a node pool added
    // later may differ.
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'exec' && args.includes('route')) {
        return { stdout: '10.0.3.41 dev enia7b3c9d1e2f4 scope link\n', stderr: '' }
      }
      return happyResponses(file, args)
    })
    stage({ run })
    const { ok, results } = await check()

    expect(ok).toBe(false)
    // The datapath check still passes, which is why this check exists.
    expect(byName(results, 'datapath')).toMatchObject({ status: 'pass' })
    const veth = byName(results, 'veth-source')
    expect(veth).toMatchObject({ status: 'fail' })
    expect(veth?.detail).toContain('cali*')
    expect(veth?.detail).toMatch(/YAAC_CNI_VETH_PREFIX=eni\b/)
  })

  it('leaves veth-source unverified, not failed, when a netd pod cannot be exec\'d', async () => {
    // "Could not read the routes" differs from "no workload routes"; only
    // the second means a broken cluster.
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'exec' && args.includes('route')) {
        throw new Error('unable to upgrade connection: container not found')
      }
      return happyResponses(file, args)
    })
    stage({ run })
    const { ok, results } = await check()

    expect(ok).toBe(true)
    expect(byName(results, 'veth-source')).toMatchObject({ status: 'warn' })
    expect(byName(results, 'veth-source')?.detail).toContain('unverified on yaac-control-plane')
  })

  it('fails datapath when calico-node is not ready (policy unenforced)', async () => {
    datapathReady['calico-node'] = '0/1'
    stage()
    const { ok, results } = await check()
    expect(ok).toBe(false)
    const datapath = byName(results, 'datapath')
    expect(datapath).toMatchObject({ status: 'fail' })
    expect(datapath?.detail).toContain('calico-node is 0/1 ready — NetworkPolicy is not being enforced')
  })

  it('names the unhealthy netd container when the DaemonSet is not ready', async () => {
    // netd's readiness is Envoy's config ack, so the DaemonSet counters
    // cannot tell a broken sidecar from a broken netd.
    datapathReady['yaac-netd'] = '0/1'
    netdContainerStatuses = [
      { name: 'netd', ready: false },
      { name: 'envoy', ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } },
    ]
    stage()
    const { results } = await check()
    const datapath = byName(results, 'datapath')
    expect(datapath).toMatchObject({ status: 'fail' })
    expect(datapath?.detail).toContain('envoy: CrashLoopBackOff')
    expect(datapath?.fix).toContain('-c envoy')
  })

  it('names each unhealthy netd container once, across pods', async () => {
    datapathReady['yaac-netd'] = '0/2'
    // Ready and nameless containers are not faults.
    netdContainerStatuses = [
      { name: 'envoy', ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } },
      { name: 'netd', ready: true },
      { ready: false },
    ]
    stage()
    fakeCluster.reset()
    seedCluster()
    const second = fakeCluster.get<FakeObject>('Pod', 'yaac-netd-0', NS)!
    fakeCluster.seed({ ...second, metadata: { ...second.metadata, name: 'yaac-netd-1' } })
    const detail = byName((await runClusterCheck()).results, 'datapath')?.detail ?? ''
    expect(detail.match(/envoy: CrashLoopBackOff/g)).toHaveLength(1)
    expect(detail).not.toContain('netd: ')

    netdContainerStatuses = [{ name: 'netd', ready: false }]
    expect(byName((await check()).results, 'datapath')?.detail).toContain('netd: not ready')
  })

  it('fails datapath when netd is absent (session egress has no redirect)', async () => {
    // Fails closed (workspaces lose egress), unlike a missing Calico, so the
    // two are reported differently.
    datapathReady['yaac-netd'] = null
    stage()
    const { ok, results } = await check()
    expect(ok).toBe(false)
    const datapath = byName(results, 'datapath')
    expect(datapath).toMatchObject({ status: 'fail' })
    expect(datapath?.detail).toContain('not deployed')
  })

  it('runs the nested-mount probe under the exact nested session securityContext', async () => {
    stage()
    const { results } = await check()
    expect(byName(results, 'nested-mount')).toMatchObject({ status: 'pass' })

    const probePod = applied()
      .map((c) => c[0] as { kind: string; metadata?: { name?: string } })
      .find((m) => m.kind === 'Pod' && m.metadata?.name === 'yaac-cluster-check-nested') as {
      spec: {
        hostUsers?: boolean
        runtimeClassName?: string
        securityContext: { seccompProfile: { type: string } }
        containers: Array<{
          securityContext?: Record<string, unknown>
          command: string[]
        }>
      }
    } | undefined
    expect(probePod).toBeDefined()
    // Like a nested workspace: gvisor-nested, no user namespace, root in the
    // sandbox with the engine's caps.
    expect(probePod?.spec.runtimeClassName).toBe('gvisor-nested')
    expect(probePod?.spec.hostUsers).toBeUndefined()
    expect(probePod?.spec.securityContext).toEqual({
      seccompProfile: { type: 'RuntimeDefault' },
    })
    expect(probePod?.spec.containers[0].securityContext).toEqual({
      runAsUser: 0,
      capabilities: {
        add: [
          'SYS_ADMIN', 'SYS_CHROOT', 'MKNOD', 'SETFCAP',
          'NET_RAW', 'NET_ADMIN', 'SYS_PTRACE', 'SYS_RESOURCE',
        ],
      },
    })
    // Root in the sandbox must be able to mount a tmpfs.
    expect(probePod?.spec.containers[0].command.join(' ')).toContain('mount -t tmpfs')
  })

  it('fails storage — and gates the probes — when a claim is absent or unbound', async () => {
    delete storageClaims['yaac-server-local']
    storageClaims['yaac-global'] = { spec: { volumeName: '' }, status: { phase: 'Pending' } }
    stage()
    const { ok, results } = await check()
    expect(ok).toBe(false)
    const storage = byName(results, 'storage')!
    expect(storage.status).toBe('fail')
    expect(storage.detail).toContain('yaac-global: Pending')
    expect(storage.detail).toContain('yaac-server-local: no such claim')
    expect(storage.fix).toMatch(/yaac cluster install/)
    // The probe mounts the global claim, so it is skipped rather than left
    // Pending.
    expect(byName(results, 'probe')!.status).toBe('skip')
  })

  it('mounts the global claim in the probe pods, never the data dir by hostPath', async () => {
    stage()
    clusterNodes = [nodeItem('yaac-control-plane'), nodeItem('yaac-worker'), nodeItem('yaac-worker2')]
    await check()
    const pods = applied()
      .map(([m]) => m as { kind: string; metadata: { name: string }; spec: { volumes?: Array<{ hostPath?: { path: string }; persistentVolumeClaim?: { claimName: string } }> } })
      .filter((m) => m.kind === 'Pod' && /^yaac-cluster-check(-node-\d+|-fsprobe)?$/.test(m.metadata.name))
    expect(pods.length).toBeGreaterThanOrEqual(4)
    for (const pod of pods) {
      expect(pod.spec.volumes?.some((v) => v.persistentVolumeClaim?.claimName === 'yaac-global')).toBe(true)
      expect(pod.spec.volumes?.some((v) => v.hostPath?.path.startsWith(tmpDir))).toBe(false)
    }
  })

  it('fails on storage-semantics naming the failing probes', async () => {
    podLogs['yaac-cluster-check-fsprobe'] = [
      'PASS  creation ownership (uid passthrough)  uid/gid 1000/1000 preserved',
      'FAIL  flock (LOCK_EX)                       AssertionError: second flock did not block',
      'FAIL  hardlink / link(2)                    OSError: [Errno 95] Operation not supported',
      '',
      '9/11 passed',
    ].join('\n')
    podPhases = { 'yaac-cluster-check-fsprobe': 'Failed' }
    stage()
    const { ok, results } = await check()
    // Fails on any backend: storage failing one of these breaks workspaces in
    // ways nothing else explains.
    expect(ok).toBe(false)
    const semantics = byName(results, 'storage-semantics')!
    expect(semantics.status).toBe('fail')
    expect(semantics.detail).toContain('flock (LOCK_EX)')
    expect(semantics.detail).toContain('hardlink / link(2)')
    expect(semantics.detail).toContain('9/11 passed')
  })

  it('passes storage-semantics over a waived probe, naming it and why', async () => {
    // NFS before 4.2 has no xattrs, which the shared tier does not need, so
    // it is reported but not a failure.
    podLogs['yaac-cluster-check-fsprobe'] = [
      'PASS  creation ownership (uid passthrough)  uid/gid 1000/1000 preserved',
      'FAIL  user.* xattr                          AssertionError: setxattr user.* failed',
      '',
      '10/11 passed',
    ].join('\n')
    podPhases = { 'yaac-cluster-check-fsprobe': 'Failed' }
    stage()
    const { results } = await check()
    const semantics = byName(results, 'storage-semantics')!
    expect(semantics.status).toBe('pass')
    expect(semantics.detail).toMatch(/10\/11 passed; waived: user\.\* xattr \(nothing yaac keeps on the shared tier uses xattrs\)/)
  })

  it('fails on storage-semantics when the probe printed no summary, rather than passing on silence', async () => {
    podLogs['yaac-cluster-check-fsprobe'] = ''
    stage()
    const { ok, results } = await check()
    expect(ok).toBe(false)
    const semantics = byName(results, 'storage-semantics')!
    expect(semantics.status).toBe('fail')
    expect(semantics.detail).toContain('no summary')
  })

  it('judges a class-provisioned global volume by its labels, its class and its actimeo', async () => {
    // A byo install's provisioned volume is held to what install set on it.
    let volume = byoGlobalVolume()
    volumes['yaac-global-ddh'] = volume
    storageClassProvisioner = 'nfs.csi.k8s.io'
    stage()
    let { results } = await check()
    expect(byName(results, 'storage')).toMatchObject({ status: 'pass' })
    expect(byName(results, 'storage')?.detail).toContain('yaac-global → yaac-global-ddh (byo-nfs)')
    // The egress probe also dials the NFS server, which trusts any uid a
    // client claims; the fake pod was blocked, so it passes.
    const egressPod = applied()
      .map((c) => c[0] as { metadata?: { name?: string }; spec?: { containers?: Array<{ command: string[] }> } })
      .find((m) => m.metadata?.name === 'yaac-cluster-check-egress')
    expect(egressPod?.spec?.containers?.[0].command[2]).toContain('nc -w 4 10.96.5.5 2049')
    expect(byName(results, 'egress')?.detail).toContain('the NFS server 10.96.5.5')

    // A non-NFS provisioner, a lost label and the class's own actimeo are
    // each named.
    storageClassProvisioner = 'ebs.csi.aws.com'
    volume = {
      ...volume,
      metadata: { labels: {} },
      spec: { ...volume.spec, mountOptions: ['nfsvers=4.1', 'actimeo=30'] },
    }
    volumes['yaac-global-ddh'] = volume
    ;({ results } = await check())
    const storage = byName(results, 'storage')!
    expect(storage.status).toBe('fail')
    expect(storage.detail).toContain('does not carry this install\'s labels')
    expect(storage.detail).toContain('class byo-nfs (ebs.csi.aws.com) is not NFS-family')
    expect(storage.detail).toContain('actimeo=30, not actimeo<=1')
  })

  it('judges the checkouts volume as a copy of the global one with second-long directory caching', async () => {
    volumes['yaac-global-ddh'] = byoGlobalVolume()
    storageClassProvisioner = 'nfs.csi.k8s.io'
    const copy = {
      metadata: { labels: { 'yaac.data-dir-hash': 'ddh16', 'yaac.claim': 'yaac-checkouts' } },
      spec: {
        persistentVolumeReclaimPolicy: 'Retain',
        storageClassName: '',
        csi: { driver: 'nfs.csi.k8s.io', volumeHandle: 'h#checkouts', volumeAttributes: { server: '10.96.5.5' } },
        mountOptions: ['nfsvers=4.1', 'acregmin=3', 'acregmax=60', 'acdirmin=1', 'acdirmax=1'],
      },
    }
    volumes['yaac-global-ddh'].spec.csi = { driver: 'nfs.csi.k8s.io', volumeHandle: 'h', volumeAttributes: { server: '10.96.5.5' } }
    volumes['yaac-checkouts-ddh'] = copy
    stage()
    let { results } = await check()
    expect(byName(results, 'storage')).toMatchObject({ status: 'pass' })

    // Another directory, the global volume's own handle, no labels and a
    // minute of directory caching are each named.
    volumes['yaac-checkouts-ddh'] = {
      metadata: { labels: {} },
      spec: {
        ...copy.spec,
        csi: { driver: 'nfs.csi.k8s.io', volumeHandle: 'h', volumeAttributes: { server: '10.96.9.9' } },
        mountOptions: ['acdirmax=60'],
      },
    }
    ;({ results } = await check())
    const storage = byName(results, 'storage')!
    expect(storage.status).toBe('fail')
    expect(storage.detail).toContain('yaac-checkouts: volume yaac-checkouts-ddh is not a copy of the yaac-global volume yaac-global-ddh')
    expect(storage.detail).toContain('yaac-checkouts: volume yaac-checkouts-ddh does not carry this install\'s labels')
    expect(storage.detail).toContain('caches directories for longer than a second')

    // On kind it is a hostPath, which must be the global tier's directory.
    volumes['yaac-checkouts-ddh'] = { spec: { persistentVolumeReclaimPolicy: 'Retain', hostPath: { path: '/elsewhere' } } }
    ;({ results } = await check())
    expect(byName(results, 'storage')?.detail).toContain('yaac-checkouts: volume yaac-checkouts-ddh is /elsewhere')
  })

  it('tells a provisioned hostPath volume (local-path) from kind\'s static one by its class', async () => {
    // local-path (k3s, kind-byo) provisions hostPath volumes at its own path,
    // which the static-pair checks would wrongly flag.
    await writeServerConfig({
      url: 'https://yaac.tailnet.ts.net', enabled: true, saved: [], driver: 'k8s', installId: 'install-1', byo: true,
    })
    const labelled = (claim: string, id: string): Record<string, string> =>
      ({ 'yaac.install-id': id, 'yaac.data-dir-hash': 'ddh16', 'yaac.claim': claim })
    const localVolume = (id: string): typeof volumes[string] => ({
      metadata: { labels: labelled('yaac-server-local', id) },
      spec: {
        persistentVolumeReclaimPolicy: 'Retain', storageClassName: 'local-path',
        hostPath: { path: '/var/lib/rancher/k3s/storage/pvc-1_yaac_yaac-server-local' },
      },
    })
    volumes = {
      'yaac-global-ddh': { ...byoGlobalVolume(), metadata: { labels: labelled('yaac-global', 'install-1') } },
      'yaac-server-local-ddh': localVolume('install-1'),
    }
    storageClassProvisioner = 'nfs.csi.k8s.io'
    stage()
    let { results } = await check()
    expect(byName(results, 'storage')).toMatchObject({ status: 'pass' })
    expect(byName(results, 'storage')?.detail).toContain('(local-path)')

    // With an install id recorded, the id (not the path hash) decides
    // ownership, as re-adoption does.
    volumes['yaac-server-local-ddh'] = localVolume('install-2')
    ;({ results } = await check())
    expect(byName(results, 'storage')?.status).toBe('fail')
    expect(byName(results, 'storage')?.detail).toMatch(/yaac-server-local: volume .* does not carry this install's labels/)
  })

  it('fails egress when a session pod reaches the NFS server behind the global claim', async () => {
    volumes['yaac-global-ddh'] = byoGlobalVolume()
    storageClassProvisioner = 'nfs.csi.k8s.io'
    podLogs['yaac-cluster-check-egress'] = 'NP_BLOCKED\nNP_NFS0_OPEN\n'
    stage()
    const { results } = await check()
    expect(byName(results, 'egress')).toMatchObject({ status: 'fail' })
    expect(byName(results, 'egress')?.detail).toMatch(/reached the NFS server .*10\.96\.5\.5/)
  })

  it('dials every EFS mount target the nodes use, resolved from inside the cluster', async () => {
    // An EFS volume names a file system, not a server. Each node zone has a
    // mount target whose zone-specific name only the VPC resolves.
    const zone = (z: string): Record<string, string> =>
      ({ 'topology.kubernetes.io/region': 'us-east-1', 'topology.kubernetes.io/zone': z })
    clusterNodes = [
      nodeItem('yaac-control-plane', { labels: zone('us-east-1a') }),
      nodeItem('worker-b', { labels: zone('us-east-1b') }),
    ]
    volumes['yaac-global-ddh'] = {
      ...byoGlobalVolume(),
      spec: { ...byoGlobalVolume().spec, csi: { driver: 'efs.csi.aws.com', volumeHandle: 'fs-0abc::fsap-1' } },
    }
    storageClassProvisioner = 'efs.csi.aws.com'
    // Zone b's target does not resolve, and is reported as unverified.
    podLogs['yaac-cluster-check-efs-resolve'] = 'EFS_IP us-east-1a.fs-0abc.efs.us-east-1.amazonaws.com 10.0.1.5\n'
      + 'EFS_IP us-east-1b.fs-0abc.efs.us-east-1.amazonaws.com\n'
    stage()
    let { results } = await check()
    const resolver = appliedPodCommand('yaac-cluster-check-efs-resolve')
    expect(resolver).toContain('nslookup us-east-1a.fs-0abc.efs.us-east-1.amazonaws.com')
    expect(resolver).toContain('nslookup us-east-1b.fs-0abc.efs.us-east-1.amazonaws.com')
    expect(appliedPodCommand('yaac-cluster-check-egress')).toContain('nc -w 4 10.0.1.5 2049')
    expect(byName(results, 'egress')).toMatchObject({ status: 'pass' })
    expect(byName(results, 'egress')?.detail).toContain('the NFS server us-east-1a.fs-0abc.efs.us-east-1.amazonaws.com')
    expect(byName(results, 'egress')?.detail)
      .toContain('NFS server us-east-1b.fs-0abc.efs.us-east-1.amazonaws.com unresolvable from here')

    podLogs['yaac-cluster-check-egress'] = 'NP_BLOCKED\nNP_NFS0_OPEN\n'
    ;({ results } = await check())
    expect(byName(results, 'egress')).toMatchObject({ status: 'fail' })
    expect(byName(results, 'egress')?.detail).toMatch(/reached the NFS server .*us-east-1a\.fs-0abc/)

    // A zone label is the node's to set, so one that is not a DNS name is
    // never put in the resolver's script, and that target is unverified.
    delete podLogs['yaac-cluster-check-egress']
    clusterNodes = [nodeItem('yaac-control-plane', { labels: zone('a;reboot') })]
    ;({ results } = await check())
    expect(appliedPodCommand('yaac-cluster-check-efs-resolve')).not.toContain('reboot')
    expect(byName(results, 'egress')?.detail).toContain('NFS server a;reboot.fs-0abc.efs.us-east-1.amazonaws.com unresolvable')

    // A handle naming a mount target by DNS name is looked up as is.
    volumes['yaac-global-ddh'].spec.csi = {
      driver: 'efs.csi.aws.com', volumeHandle: 'us-east-1b.fs-0abc.efs.us-east-1.amazonaws.com::fsap-1',
    }
    podLogs['yaac-cluster-check-efs-resolve'] = 'EFS_IP us-east-1b.fs-0abc.efs.us-east-1.amazonaws.com 10.0.2.7\n'
    ;({ results } = await check())
    expect(appliedPodCommand('yaac-cluster-check-egress')).toContain('nc -w 4 10.0.2.7 2049')
  })

  it('fails a pool that has drifted from what --byo installed on, naming the nodes', async () => {
    // The same checks `--byo` runs, repeated to catch nodes added later.
    clusterNodes = [
      nodeItem('pool-a'),
      nodeItem('pool-b', { nodeInfo: { architecture: 'ppc64le' } }),
      nodeItem('pool-c', { nodeInfo: { osImage: 'Bottlerocket OS 1.20.0' } }),
    ]
    stage()
    const { ok, results } = await check()
    expect(ok).toBe(false)
    expect(byName(results, 'architecture')?.status).toBe('fail')
    expect(byName(results, 'architecture')?.detail).toMatch(/mixes architectures .*ppc64le: pool-b/)
    expect(byName(results, 'node-os')?.detail).toMatch(/pool-c runs Bottlerocket OS 1\.20\.0, an immutable OS/)
  })

  it('leaves the kind node fixups alone on a byo install, whose nodes are the pool\'s', async () => {
    // kind-byo's nodes are podman containers with node names, so checking
    // podman alone would probe a cluster install never touched.
    await writeServerConfig({ url: 'https://yaac.tailnet.ts.net', enabled: true, saved: [], driver: 'k8s', byo: true })
    const deps = stage()
    const { results } = await check()
    expect(byName(results, 'node-fixups')).toMatchObject({ status: 'skip' })
    expect(deps.run.mock.calls.some(([f, a]) => f === 'podman' && a[0] === 'exec')).toBe(false)
  })

  it('warns (without failing) when the nested sentry mount fails', async () => {
    podLogs['yaac-cluster-check-nested'] = 'NESTED_MOUNT_FAIL\n'
    stage()
    const { ok, results } = await check()
    const nested = byName(results, 'nested-mount')
    expect(nested).toMatchObject({ status: 'warn' })
    expect(nested?.fix).toContain('cluster install')
    expect(ok).toBe(true) // warn-only — only nestedContainers sessions are affected
  })

  it('fails on vap when the ValidatingAdmissionPolicy API is unavailable', async () => {
    stage()
    fakeCluster.reset()
    seedCluster()
    fakeCluster.removeKind('ValidatingAdmissionPolicy')
    const { ok, results } = await runClusterCheck()
    const vap = byName(results, 'vap')
    expect(vap).toMatchObject({ status: 'fail' })
    expect(vap?.detail).toContain('ValidatingAdmissionPolicy API unavailable')
    expect(vap?.fix).toContain('image builds')
    // Fails: without the API the guard refuses to apply, so no workspace
    // image can be built.
    expect(ok).toBe(false)
  })

  // The VAP gate runs last; a denied list must not throw away the report.
  it('reports vap as unreadable when the list is denied, keeping every other result', async () => {
    stage()
    fakeCluster.reset()
    seedCluster()
    fakeCluster.intercept((c) => {
      if (c.kind === 'ValidatingAdmissionPolicy') throw apiError(403, 'forbidden')
      return undefined
    })
    const { ok, results } = await runClusterCheck()
    expect(byName(results, 'vap')).toMatchObject({
      status: 'fail', detail: expect.stringContaining('could not query the ValidatingAdmissionPolicy API (403') as unknown,
    })
    expect(byName(results, 'kubectl')).toBeDefined()
    expect(ok).toBe(false)
  })

  it('fails the registry check when an anonymous write is accepted', async () => {
    stage()
    const healthy = byName((await check()).results, 'registry')
    expect(healthy).toMatchObject({ status: 'pass' })
    expect(healthy?.detail).toContain('writes need a grant')
    // Probed with an anonymous upload start.
    expect(gateProbes).toEqual([
      { url: 'http://127.0.0.1:41234/v2/yaac-cluster-probe/blobs/uploads/', method: 'POST' },
    ])

    // An ungated registry answers reads too; only a write shows the gate is
    // missing.
    gateStatus = 202
    const { ok, results } = await check()
    expect(ok).toBe(false)
    expect(byName(results, 'registry')).toMatchObject({ status: 'fail' })
    expect(byName(results, 'registry')?.fix).toContain('yaac cluster install')

    gateStatus = null
    const unverified = byName((await check()).results, 'registry')
    expect(unverified).toMatchObject({ status: 'warn' })
    expect(unverified?.detail).toContain('no answer')
  })

  it('fails the registry check with repair instructions when nothing answers', async () => {
    stage({
      registryReachable: false,
    })
    const { ok, results } = await check()
    expect(ok).toBe(false)
    const registry = byName(results, 'registry')
    expect(registry).toMatchObject({ status: 'fail' })
    // The fix is a repair install and a look at the Deployment.
    expect(registry?.fix).toContain('yaac cluster install')
    expect(registry?.fix).toContain('app=yaac-main-registry')
  })

  it('fails the probe with wiring hints when the pod ends in a non-Succeeded phase', async () => {
    // Only the e2e probe pod fails; the gvisor probe still succeeds.
    podPhases = { 'yaac-cluster-check': 'Failed' }
    stage()
    const { ok, results } = await check()
    expect(ok).toBe(false)
    const probe = byName(results, 'probe')
    expect(probe).toMatchObject({ status: 'fail' })
    expect(probe?.detail).toContain('phase Failed')
    expect(probe?.fix).toContain('ImagePullBackOff')
  })

  it('fails the probe when the pod write never reaches its peer', async () => {
    // The probe read the nonce, but its write never reached the server's view
    // of the claim (uid mismatch, or a volume root the install uid does not
    // own).
    peerSawWrite = false
    stage()
    const { ok, results } = await check()
    expect(ok).toBe(false)
    const probe = byName(results, 'probe')
    expect(probe).toMatchObject({ status: 'fail' })
    expect(probe?.detail).toContain('never reached its peer')
    expect(probe?.fix).toContain('uid')
  })

  it('fails the probe, naming the peer, when the pod never sees the peer\'s nonce', async () => {
    podLogs['yaac-cluster-check'] = 'PROBE_READ=\n'
    podPhases = { 'yaac-cluster-check-peer': 'Failed' }
    stage()
    const { ok, results } = await check()
    expect(ok).toBe(false)
    expect(byName(results, 'probe')?.detail).toMatch(/never saw the nonce.*peer: phase Failed/)
  })

  it('fails the probe when the pod reads stale data', async () => {
    podLogs['yaac-cluster-check'] = 'PROBE_READ=some-stale-nonce\n'
    stage()
    const { ok, results } = await check()
    expect(ok).toBe(false)
    expect(byName(results, 'probe')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('stale data') as string,
    })
  })
})
