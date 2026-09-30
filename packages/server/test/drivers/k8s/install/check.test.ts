import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type * as sharedGitModule from '@yaac/shared/git'

vi.mock('#drivers/k8s/substrate/kubectl', async (importOriginal) => ({
  dataDirHash: () => 'ddh16',
  // The real predicate: these tests rely on telling "absent" apart from
  // "could not evaluate".
  isKubectlAbsentError: (await importOriginal<
    { isKubectlAbsentError: (err: unknown) => boolean }
  >()).isKubectlAbsentError,
  kubectlErrorSummary: (await importOriginal<
    { kubectlErrorSummary: (err: unknown) => string }
  >()).kubectlErrorSummary,
  execFileAsync: vi.fn(),
  k8sNamespace: vi.fn(() => 'test-ns'),
  kubectlApply: vi.fn(),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn(),
}))

// This host's git identity. Mocked because a developer machine always has
// one, which would hide the matching and absent cases.
const mockGitUserConfig = vi.hoisted(() => vi.fn())
vi.mock('@yaac/shared/git', async (importOriginal) => ({
  ...(await importOriginal<typeof sharedGitModule>()),
  getGitUserConfig: mockGitUserConfig,
}))

// The fsprobe pod's image; ensuring it would pull and push.
vi.mock('#drivers/k8s/cluster/builder-image', () => ({
  ensureBuilderImage: vi.fn().mockResolvedValue('localhost:5000/podman-stable:mirror'),
}))

vi.mock('#drivers/k8s/container/registry', () => ({
  REGISTRY_NAMESPACE: 'yaac',
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
import { execFileAsync, kubectlApply, kubectlGetJson, kubectlWithRetry } from '#drivers/k8s/substrate/kubectl'
import { pushImageToRegistry, registryReachable } from '#drivers/k8s/container/registry'
import { resetClusterCidrCache } from '#drivers/k8s/cluster/cluster-cidrs'
import {
  buildPriorityClassManifests, buildRuntimeClassManifests, GVISOR_NODE_LABEL, NODE_TASKSMAX_LIVE,
  NODE_TUNING_SYSCTLS,
} from '#drivers/k8s/substrate'
import type { NodeTaint, PodToleration } from '#drivers/k8s/substrate'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { globalRoot, serverLocalRoot } from '@yaac/shared/paths'
import { writeServerConfig } from '@yaac/shared/server-config'

const mockGetJson = vi.mocked(kubectlGetJson)
const mockRun = vi.mocked(execFileAsync)
const mockApply = vi.mocked(kubectlApply)
const mockPush = vi.mocked(pushImageToRegistry)
const mockReachable = vi.mocked(registryReachable)
// vapAvailable() uses kubectlWithRetry rather than deps.run.
const mockRetry = vi.mocked(kubectlWithRetry)

type RunMock = ReturnType<typeof vi.fn<
  (file: string, args: string[], opts?: unknown) => Promise<{ stdout: string; stderr: string }>
>>

/**
 * The args an applied probe pod got after its script (`sh -c <script> --
 * <args>`), which is how the fakes learn the nonce a peer pod publishes.
 */
function appliedPodArgs(name: string): string[] {
  const pod = mockApply.mock.calls
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
  { key: 'yaac.dev/sessions', value: 'true', effect: 'NoSchedule' },
  { key: 'yaac.dev/sessions', value: 'true', effect: 'NoExecute' },
]
const POOL_TOLERATIONS: PodToleration[] = [
  { key: 'yaac.dev/sessions', operator: 'Equal', value: 'true', effect: 'NoSchedule' },
  { key: 'yaac.dev/sessions', operator: 'Equal', value: 'true', effect: 'NoExecute' },
]
/** A transient taint kubelet adds and removes on its own. */
const MEMORY_PRESSURE: NodeTaint = {
  key: 'node.kubernetes.io/memory-pressure', effect: 'NoSchedule',
}

/**
 * A node object with the fields the readiness checks read: Ready,
 * cordon/taints, and the kubelet's runtime-handler list.
 */
function nodeItem(
  name: string,
  opts: {
    ready?: boolean
    cordoned?: boolean
    /** Shorthand for the kubeadm control-plane taint. */
    tainted?: boolean
    taints?: NodeTaint[]
    handlers?: string[]
    /**
     * Omit the gVisor installer's node label, as on a node the runtime has
     * not reached yet. The RuntimeClass will not schedule there.
     */
    gvisorLabel?: boolean
    labels?: Record<string, string>
    nodeInfo?: Record<string, string>
  } = {},
): Record<string, unknown> {
  const taints = [
    ...(opts.tainted
      ? [{ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' }]
      : []),
    ...(opts.taints ?? []),
  ]
  return {
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
      runtimeHandlers: (opts.handlers ?? ['runc', 'runsc', 'runsc-nested'])
        .map((h) => ({ name: h })),
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

/** The nodes `kubectl get nodes` returns; one control-plane node by default. */
let clusterNodes: Array<Record<string, unknown>> = []
/**
 * The gvisor RuntimeClass's `scheduling.tolerations`, which workspace pods
 * inherit. Empty on a local cluster.
 */
let gvisorTolerations: PodToleration[] = []
/** What the server Deployment states for env, read by the identity check. */
let serverDeployEnv: Array<{ name: string; value?: string }> = []
/** Pod name → terminal phase, for probe pods a test wants to fail. */
let podPhases: Record<string, string> = {}
/** Per-node probe indices whose pod "ran" without its write reaching the peer. */
let nodeMarkerFails: Set<string> = new Set()
/** Whether the end-to-end probe's write reached its peer; a case edits. */
let peerSawWrite = true
/** Pod name -> the kubelet Warning event (`<reason>|<message>`) for a pod that never ran. */
let podEvents: Record<string, string> = {}
/** The two storage claims as the apiserver reports them; a case edits. */
let storageClaims: Record<string, { spec: { volumeName: string }; status: { phase: string } }> = {}
const FSPROBE_ALL_PASS = [
  'PASS  creation ownership (uid passthrough)  uid/gid 1000/1000 preserved',
  'PASS  O_EXCL exclusive create               second create correctly EEXIST',
  'PASS  flock (LOCK_EX)                       flock excludes',
  '',
  '11/11 passed',
].join('\n')
/** What the fsprobe pod printed; a case edits. */
let fsprobeOutput = FSPROBE_ALL_PASS
/** The npm cache's Service, or null for an install without one; a case edits. */
let npmCacheService: { spec: { clusterIP: string } } | null = null
/** Whether a cache pod is ready behind that Service; a case edits. */
let npmCacheReady = true
/** What the npm-cache probe pod printed; a case edits. */
let npmCacheProbeOutput = 'NPM_CACHE_OK\n'

/**
 * deps.run for the all-pass path. `kubectl logs` echoes back the nonce and
 * the probe pod's write marker, so the end-to-end probe passes.
 */
function happyResponses(
  file: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return Promise.resolve(happyResponse(file, args))
}

function happyResponse(file: string, args: string[]): { stdout: string; stderr: string } {
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'nodes'
    && args.includes('jsonpath={.items[*].metadata.name}')) {
    // Honors `-l`, for the gvisor check's installer-label read.
    const selector = args[args.indexOf('-l') + 1]
    const [key, value] = args.includes('-l') ? selector.split('=') : []
    return {
      stdout: clusterNodes
        .filter((n) => key === undefined
          || (n.metadata as { labels?: Record<string, string> }).labels?.[key] === value)
        .map((n) => (n.metadata as { name: string }).name)
        .join(' '),
      stderr: '',
    }
  }
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'nodes') {
    return { stdout: JSON.stringify({ items: clusterNodes }), stderr: '' }
  }
  // The server Deployment's env, for the git-identity check.
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'deployment') {
    return { stdout: JSON.stringify(serverDeployEnv), stderr: '' }
  }
  // The gvisor RuntimeClass (handler, nodeSelector, tolerations), built by
  // the same function the installer uses.
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'runtimeclass'
    && args[2] === 'gvisor') {
    const gvisor = (buildRuntimeClassManifests({ tolerations: gvisorTolerations }) as Array<{
      metadata: { name: string }
    }>).find((rc) => rc.metadata.name === 'gvisor')
    return { stdout: JSON.stringify(gvisor), stderr: '' }
  }
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'runtimeclass') {
    return { stdout: 'gvisor gvisor-nested runc', stderr: '' }
  }
  // Events for a probe pod that never ran; a Pending pod has no container
  // statuses to read.
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'events') {
    const pod = (args.find((a) => a.startsWith('involvedObject.name=')) ?? '').split('=')[1]
    const [reason, message] = (podEvents[pod] ?? '').split('|')
    return {
      stdout: JSON.stringify({
        items: reason ? [{ type: 'Warning', reason, message }] : [],
      }),
      stderr: '',
    }
  }
  if (file === 'kubectl' && args[0] === 'logs' && args[1].startsWith('yaac-cluster-check-node-')) {
    const [, nonce] = appliedPodArgs('yaac-cluster-check-sweep-peer')
    return { stdout: `GVISOR_SANDBOXED\n${nonce}\n`, stderr: '' }
  }
  // The sweep's peer reports the marker of each node probe whose write
  // reached it.
  if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-sweep-peer') {
    const count = Number(appliedPodArgs('yaac-cluster-check-sweep-peer')[2])
    return {
      stdout: Array.from({ length: count }, (_, i) => String(i))
        .filter((i) => !nodeMarkerFails.has(i))
        .map((i) => `PEER_MARKER=${i}\n`).join(''),
      stderr: '',
    }
  }
  if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-peer') {
    return {
      stdout: `PEER_NODE=yaac-control-plane\nPEER_RTT_MS=7\nPEER_SAW_WRITE=${peerSawWrite ? 'ok' : ''}\n`,
      stderr: '',
    }
  }
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'priorityclass') {
    return { stdout: JSON.stringify({ items: livePriorityClasses() }), stderr: '' }
  }
  if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-gvisor') {
    return { stdout: 'GVISOR_SANDBOXED\n', stderr: '' }
  }
  // The node-tuning check reads sysctls and DefaultTasksMax through each
  // node's installer pod, and the DaemonSet's desired count.
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'daemonset'
    && args.includes('jsonpath={.status.desiredNumberScheduled}')) {
    return { stdout: String(clusterNodes.length), stderr: '' }
  }
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'pods'
    && args.includes('app=yaac-gvisor-install')) {
    return {
      stdout: JSON.stringify({
        items: clusterNodes.map((n, i) => ({
          metadata: { name: `yaac-gvisor-install-${i}` },
          spec: { nodeName: (n.metadata as { name: string }).name },
          status: { phase: 'Running' },
        })),
      }),
      stderr: '',
    }
  }
  if (file === 'kubectl' && args[0] === 'exec' && args[1].startsWith('yaac-gvisor-install-')) {
    return { stdout: tunedReport(), stderr: '' }
  }
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'pods'
    && args.includes('app=yaac-netd')) {
    // The veth-source check lists netd pods, then reads each node's routes.
    return {
      stdout: JSON.stringify({
        items: [{
          metadata: { name: 'yaac-netd-0' },
          spec: { nodeName: 'yaac-control-plane' },
          status: { phase: 'Running' },
        }],
      }),
      stderr: '',
    }
  }
  if (file === 'kubectl' && args[0] === 'exec' && args.includes('route')) {
    // A healthy Calico node: two workload veths under the default prefix.
    return {
      stdout: '10.244.169.193 dev calibb6b64b7901 scope link\n'
        + '10.244.169.197 dev calia132c78e002 scope link\n',
      stderr: '',
    }
  }
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'pods') {
    // runtime-stamp sweep (-A): every untrusted pod must be on gvisor;
    // unstamped infra (the proxy) is fine, and kube-system is out of scope.
    return {
      stdout: JSON.stringify({
        items: [
          {
            metadata: {
              name: 'yaac-session-abc', namespace: 'test-ns',
              labels: { 'yaac.workspace-id': 'abc' },
            },
            spec: { runtimeClassName: 'gvisor' },
          },
          { metadata: { name: 'yaac-proxy-abc', namespace: 'test-ns' }, spec: {} },
          { metadata: { name: 'coredns-xyz', namespace: 'kube-system' }, spec: {} },
        ],
      }),
      stderr: '',
    }
  }
  if (file === 'podman' && args[0] === 'exec') {
    return { stdout: 'hk=ok\n', stderr: '' }
  }
  if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-fsprobe') {
    return { stdout: fsprobeOutput, stderr: '' }
  }
  if (file === 'podman' && args[0] === 'inspect') {
    return { stdout: '32768\n', stderr: '' }
  }
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'svc' && args[2] === 'kubernetes') {
    return { stdout: '10.96.0.1', stderr: '' }
  }
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'svc' && args[2] === 'kube-dns') {
    return { stdout: '10.96.0.10', stderr: '' }
  }
  if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-egress') {
    return { stdout: 'NP_BLOCKED\n', stderr: '' }
  }
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'daemonset') {
    // Both datapath DaemonSets report fully rolled out.
    return { stdout: '1/1', stderr: '' }
  }
  if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-npm-cache') {
    return { stdout: npmCacheProbeOutput, stderr: '' }
  }
  if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-nested') {
    return { stdout: 'NESTED_MOUNT_OK\n', stderr: '' }
  }
  if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check') {
    const [, nonce] = appliedPodArgs('yaac-cluster-check-peer')
    return { stdout: `PROBE_NODE=yaac-control-plane\nPROBE_READ=${nonce}\n`, stderr: '' }
  }
  return { stdout: '', stderr: '' }
}

function happyRun(): RunMock {
  return vi.fn(happyResponses)
}

/** What a tuned node's installer pod reports: every target met. */
function tunedReport(overrides: Record<string, string> = {}): string {
  return NODE_TUNING_SYSCTLS
    .map((t) => `${t.path}=${overrides[t.path] ?? String(t.value)}`)
    .concat(overrides.tasksmax ?? `tasksmax=${NODE_TASKSMAX_LIVE}`)
    .join('\n') + '\n'
}

/** kubectl get responses; probe pods succeed unless `podPhases` says otherwise. */
function happyGetJson(args: string[]): unknown {
  // The two storage claims, Bound to their static volumes.
  if (args[1] === 'pvc') {
    const claim = storageClaims[args[2]]
    return claim === undefined ? null : claim
  }
  if (args[1] === 'pv') {
    const hostPath = args[2].startsWith('yaac-global') ? globalRoot() : serverLocalRoot()
    return { spec: { persistentVolumeReclaimPolicy: 'Retain', hostPath: { path: hostPath } } }
  }
  // Node and apiserver reads for the real cluster-cidrs probe.
  if (args[1] === 'nodes') {
    return { items: [{ status: { addresses: [{ type: 'InternalIP', address: '10.89.0.7' }] } }] }
  }
  if (args[1] === 'endpoints') return { subsets: [{ addresses: [{ ip: '10.89.0.7' }] }] }
  if (args[1] === 'service' && args[2] === 'yaac-npm-cache') return npmCacheService
  if (args[1] === 'endpointslices') {
    return { items: npmCacheService ? [{ endpoints: [{ conditions: { ready: npmCacheReady } }] }] : [] }
  }
  if (args[1] === 'pod') return { status: { phase: podPhases[args[2]] ?? 'Succeeded' } }
  return { status: { phase: 'Succeeded' } }
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
  apply: typeof mockApply
  pushImage: typeof mockPush
}

/**
 * Install the fakes one check run needs (subprocess runner, registry ping
 * and push, kubectl apply) and return their call records. `ensureNamespace`
 * runs for real, so its Namespace apply shows up in `apply`.
 */
function stage(overrides: { run?: RunMock; registryReachable?: boolean } = {}): Staged {
  const run = overrides.run ?? happyRun()
  mockRun.mockClear()
  mockApply.mockClear()
  mockPush.mockClear()
  mockRun.mockImplementation(run as never)
  mockReachable.mockResolvedValue(overrides.registryReachable ?? true)
  mockPush.mockResolvedValue('localhost:5000/yaac-cluster-probe:busybox-1.36')
  mockApply.mockResolvedValue(undefined)
  return { run, apply: mockApply, pushImage: mockPush }
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
    mockGetJson.mockReset()
    resetClusterCidrCache()
    clusterNodes = [nodeItem('yaac-control-plane')]
    gvisorTolerations = []
    serverDeployEnv = []
    mockGitUserConfig.mockResolvedValue({ name: 'A B', email: 'a@b.co' })
    podPhases = {}
    nodeMarkerFails = new Set()
    peerSawWrite = true
    podEvents = {}
    storageClaims = {
      'yaac-global': { spec: { volumeName: 'yaac-global-ddh' }, status: { phase: 'Bound' } },
      'yaac-server-local': { spec: { volumeName: 'yaac-server-local-ddh' }, status: { phase: 'Bound' } },
    }
    fsprobeOutput = FSPROBE_ALL_PASS
    npmCacheService = { spec: { clusterIP: '10.96.4.2' } }
    npmCacheReady = true
    npmCacheProbeOutput = 'NPM_CACHE_OK\n'
    mockGetJson.mockImplementation((args: string[]) => Promise.resolve(happyGetJson(args)))
    mockRetry.mockReset()
    mockRetry.mockResolvedValue({ stdout: '', stderr: '' })
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
    const { ok, results } = await runClusterCheck()

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
      ['node-tuning', 'pass'],
      ['probe', 'pass'],
      ['egress', 'pass'],
      ['npm-cache', 'pass'],
      ['datapath', 'pass'],
      // Checked on every run: netd can be Ready with zero pod-to-veth
      // mappings, so nothing else would notice a wrong prefix.
      ['veth-source', 'pass'],
      // Per-node checks are skipped on one node; the checks above cover it.
      ['runsc-nodes', 'skip'],
      ['registry-nodes', 'skip'],
      ['volume-nodes', 'skip'],
      ['nested-mount', 'pass'],
      ['storage-semantics', 'pass'],
      ['vap', 'pass'],
      ['runtime-stamp', 'pass'],
    ])
    expect(ok).toBe(true)
    expect(byName(results, 'datapath')?.detail).toContain('calico-node and yaac-netd ready')

    expect(deps.pushImage).toHaveBeenCalledWith('yaac-cluster-probe:busybox-1.36')
    const probePod = vi.mocked(deps.apply).mock.calls
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
    const peer = vi.mocked(deps.apply).mock.calls
      .map((c) => c[0] as unknown as typeof podManifest & {
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
    const deps = stage()
    mockGetJson.mockImplementation((args: string[]) => Promise.resolve(
      args[1] === 'deployment'
        ? { spec: { template: { spec: { securityContext: { runAsUser: 4242, runAsGroup: 4242 } } } } }
        : happyGetJson(args),
    ))
    const { results } = await runClusterCheck()
    const pods = vi.mocked(deps.apply).mock.calls
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
    const deps = stage()
    mockGetJson.mockImplementation((args: string[]) => args[1] === 'deployment'
      ? Promise.reject(new Error('Unable to connect to the server: dial tcp: i/o timeout'))
      : Promise.resolve(happyGetJson(args)))
    const { ok, results } = await runClusterCheck()
    expect(ok).toBe(false)
    expect(byName(results, 'probe')).toMatchObject({ status: 'fail' })
    expect(byName(results, 'probe')?.detail).toMatch(/could not read the install identity .*i\/o timeout/)
    expect(byName(results, 'egress')?.status).toBe('skip')
    expect(vi.mocked(deps.apply).mock.calls.map((c) => (c[0] as { metadata?: { name?: string } }).metadata?.name))
      .not.toContain('yaac-cluster-check-peer')
  })

  it('warns rather than crashing when the node list cannot be read', async () => {
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'nodes'
        && args.includes('json')) {
        throw new Error('connection refused')
      }
      return happyResponses(file, args)
    })
    stage({ run })
    const { results } = await runClusterCheck()
    // Node count is advisory, so an unreadable list only warns.
    expect(byName(results, 'nodes')).toMatchObject({ status: 'warn' })
    expect(byName(results, 'nodes')?.detail).toMatch(/could not list nodes.*connection refused/)
  })

  it('fails the namespace check with a rights hint when the namespace cannot be created', async () => {
    stage()
    mockApply.mockRejectedValue(new Error('namespaces is forbidden'))
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
    const { ok, results } = await runClusterCheck()

    expect(ok).toBe(false)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ name: 'kubectl', status: 'fail' })
    expect(results[0].fix).toContain('Install kubectl')
  })

  it('short-circuits after the cluster check when the API server is unreachable', async () => {
    const run = vi.fn((file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'version' && !args.includes('--client')) {
        return Promise.reject(new Error('connection refused'))
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }) as RunMock
    stage({ run })
    const { ok, results } = await runClusterCheck()

    expect(ok).toBe(false)
    expect(results.map((r) => r.name)).toEqual(['kubectl', 'cluster'])
    expect(byName(results, 'cluster')).toMatchObject({ status: 'fail' })
    expect(byName(results, 'cluster')?.detail).toContain('API server unreachable')
  })

  it('probes every session-eligible node of a multi-node cluster for runsc, registry pulls and the shared volume', async () => {
    // What `--nodes 3` produces: kind keeps the control-plane taint once
    // there are workers, so workspaces run on the workers.
    clusterNodes = [
      nodeItem('yaac-control-plane', { tainted: true }),
      nodeItem('yaac-worker'),
      nodeItem('yaac-worker2'),
    ]
    const deps = stage()
    const { ok, results } = await runClusterCheck()

    expect(ok).toBe(true)
    // Multi-node is supported, and the two counts are reported separately.
    expect(byName(results, 'nodes')).toMatchObject({ status: 'pass' })
    // The excluded node is named with its taint, since "2 of 3" alone does
    // not say why.
    expect(byName(results, 'nodes')?.detail).toBe(
      '3 nodes, 2 able to schedule sessions; skipping yaac-control-plane '
      + '(untolerated taint node-role.kubernetes.io/control-plane:NoSchedule)',
    )
    expect(byName(results, 'runsc-nodes')).toMatchObject({ status: 'pass' })
    expect(byName(results, 'runsc-nodes')?.detail).toContain('all 2 session-capable nodes')
    // The per-node checks name it too.
    for (const gate of ['runsc-nodes', 'registry-nodes', 'volume-nodes']) {
      expect(byName(results, gate)?.detail, gate).toContain(
        'not swept: yaac-control-plane '
        + '(untolerated taint node-role.kubernetes.io/control-plane:NoSchedule)',
      )
    }
    // The sentry fingerprint is reported when the probe can read dmesg.
    expect(byName(results, 'runsc-nodes')?.detail).toContain('2 sentry-verified')
    expect(byName(results, 'registry-nodes')).toMatchObject({ status: 'pass' })
    expect(byName(results, 'volume-nodes')).toMatchObject({ status: 'pass' })

    // One pod per eligible node, pinned by nodeName, on the gvisor tier. The
    // tainted control plane is skipped: no workspace can run there.
    const nodePods = vi.mocked(deps.apply).mock.calls
      .map((c) => c[0] as {
        kind: string
        metadata?: { name?: string }
        spec?: {
          nodeName?: string
          runtimeClassName?: string
          securityContext?: { runAsUser?: number; supplementalGroups?: number[] }
          containers: Array<{
            imagePullPolicy?: string
            securityContext?: { runAsUser?: number }
          }>
          volumes: Array<{ hostPath?: { path?: string }; persistentVolumeClaim?: { claimName: string } }>
        }
      })
      .filter((m) => m.metadata?.name?.startsWith('yaac-cluster-check-node-'))
    expect(nodePods.map((p) => p.spec?.nodeName).sort())
      .toEqual(['yaac-worker', 'yaac-worker2'])
    for (const pod of nodePods) {
      expect(pod.spec?.runtimeClassName).toBe('gvisor')
      // Always, so a cached layer cannot hide an unreachable registry.
      expect(pod.spec?.containers[0].imagePullPolicy).toBe('Always')
      expect(pod.spec?.securityContext?.runAsUser).toBe(process.getuid?.())
      expect(pod.spec?.securityContext?.supplementalGroups).toEqual([0])
      expect(pod.spec?.volumes[0].persistentVolumeClaim?.claimName).toBe('yaac-global')
    }

    await expect(
      fs.access(path.join(globalRoot(), '.cluster-check-nodes-nonce')),
    ).rejects.toThrow()
    await expect(
      fs.access(path.join(globalRoot(), '.cluster-check-node-0')),
    ).rejects.toThrow()
  })

  it('attributes a probe pod that never ran to the gate that can fix it', async () => {
    // Three broken nodes that all look like "the pod did not run":
    //   worker  - containerd has no runsc handler (the kubelet's handler
    //             list says so).
    //   worker2 - no $HOME extraMount, so the hostPath cannot mount. Volumes
    //             are set up before the pull, so the registry is never hit.
    //   worker3 - the pod ran, but its write never reached the host.
    clusterNodes = [
      nodeItem('yaac-control-plane', { tainted: true }),
      nodeItem('yaac-worker', { handlers: ['runc'] }),
      nodeItem('yaac-worker2'),
      nodeItem('yaac-worker3'),
    ]
    // The phase alone says nothing; the sweep attributes failures from the
    // kubelet events.
    podPhases = {
      'yaac-cluster-check-node-0': 'Failed',
      'yaac-cluster-check-node-1': 'Failed',
    }
    podEvents = {
      'yaac-cluster-check-node-0': 'FailedCreatePodSandBox|no runtime for "runsc" is configured',
      'yaac-cluster-check-node-1':
        'FailedMount|MountVolume.SetUp failed: hostPath type check failed: /home/x is not a directory',
    }
    nodeMarkerFails = new Set(['2'])
    stage()
    const { ok, results } = await runClusterCheck()

    // The per-node checks are advisory and never fail the run.
    expect(ok).toBe(true)

    const runsc = byName(results, 'runsc-nodes')
    expect(runsc).toMatchObject({ status: 'warn' })
    expect(runsc?.detail).toContain('yaac-worker')
    expect(runsc?.fix).toContain('yaac cluster install')

    // The mount failure is not reported as a registry problem, whose fix
    // (hosts.toml) would not help.
    const registry = byName(results, 'registry-nodes')
    expect(registry).toMatchObject({ status: 'warn' })
    expect(registry?.detail).not.toContain('could not pull')
    expect(registry?.detail).toContain('unverified on yaac-worker, yaac-worker2')
    expect(registry?.fix).toBeUndefined()

    // It is reported here, with the extraMount fix, alongside the node whose
    // write did not reach the host.
    const volume = byName(results, 'volume-nodes')
    expect(volume).toMatchObject({ status: 'warn' })
    expect(volume?.detail).toContain('yaac-worker2 (FailedMount')
    expect(volume?.detail).toContain('yaac-worker3')
    expect(volume?.detail).toContain('unverified on yaac-worker')
    expect(volume?.fix).toContain('extraMount')
  })

  it('claims no gate for a probe failure it cannot attribute', async () => {
    // A CNI-broken node also fails with FailedCreatePodSandBox, so an
    // unrecognized cause is reported as unverified, not blamed on runsc.
    clusterNodes = [
      nodeItem('yaac-control-plane', { tainted: true }),
      nodeItem('yaac-worker', { handlers: [] }),
      nodeItem('yaac-worker2', { handlers: [] }),
    ]
    podPhases = { 'yaac-cluster-check-node-0': 'Failed' }
    podEvents = {
      'yaac-cluster-check-node-0':
        'FailedCreatePodSandBox|failed to setup network for sandbox: plugin type="calico" failed',
    }
    stage()
    const { results } = await runClusterCheck()

    for (const name of ['runsc-nodes', 'registry-nodes', 'volume-nodes']) {
      const gate = byName(results, name)
      expect(gate, name).toMatchObject({ status: 'warn' })
      expect(gate?.detail).toContain('unverified on yaac-worker')
      expect(gate?.fix, name).toBeUndefined()
    }
  })

  it('reports a node the gVisor installer has not reached instead of dropping it', async () => {
    // An unlabelled node cannot be probed, but it is still reported: the
    // runtime missing there is the finding.
    clusterNodes = [
      nodeItem('yaac-control-plane', { tainted: true }),
      nodeItem('yaac-worker'),
      nodeItem('yaac-worker2', { gvisorLabel: false }),
    ]
    const deps = stage()
    const { ok, results } = await runClusterCheck()

    expect(ok).toBe(true)
    const runsc = byName(results, 'runsc-nodes')
    expect(runsc).toMatchObject({ status: 'warn' })
    expect(runsc?.detail).toContain(`yaac-worker2 (no ${GVISOR_NODE_LABEL} label)`)
    expect(runsc?.fix).toContain('yaac-gvisor-install')

    // The other checks report it as unverified rather than passing.
    expect(byName(results, 'registry-nodes')?.detail).toContain('unverified on yaac-worker2')
    expect(byName(results, 'volume-nodes')?.detail).toContain('unverified on yaac-worker2')

    const probed = vi.mocked(deps.apply).mock.calls
      .map((c) => c[0] as { metadata?: { name?: string }; spec?: { nodeName?: string } })
      .filter((m) => m.metadata?.name?.startsWith('yaac-cluster-check-node-'))
      .map((m) => m.spec?.nodeName)
    expect(probed).toEqual(['yaac-worker'])
  })

  it('judges runsc per node when only some kubelets publish their runtime handlers', async () => {
    // Mixed kubelet versions: worker lists handlers without runsc; worker2
    // lists none, so its successful probe decides.
    clusterNodes = [
      nodeItem('yaac-control-plane', { tainted: true }),
      nodeItem('yaac-worker', { handlers: ['runc'] }),
      nodeItem('yaac-worker2', { handlers: [] }),
    ]
    podPhases = { 'yaac-cluster-check-node-0': 'Failed' }
    podEvents = {
      'yaac-cluster-check-node-0': 'FailedCreatePodSandBox|no runtime for "runsc" is configured',
    }
    stage()
    const { results } = await runClusterCheck()

    const runsc = byName(results, 'runsc-nodes')
    expect(runsc).toMatchObject({ status: 'warn' })
    expect(runsc?.detail).toContain('yaac-worker')
    expect(runsc?.detail).not.toContain('yaac-worker2')
  })

  it('leaves NotReady and cordoned nodes out of the readiness sweep', async () => {
    clusterNodes = [
      nodeItem('yaac-control-plane'),
      nodeItem('yaac-worker', { ready: false }),
      nodeItem('yaac-worker2', { cordoned: true }),
    ]
    const deps = stage()
    const { ok, results } = await runClusterCheck()

    expect(ok).toBe(true)
    // The inventory flags the node that can run nothing.
    expect(byName(results, 'nodes')).toMatchObject({ status: 'warn' })
    expect(byName(results, 'nodes')?.detail).toContain('NotReady: yaac-worker')
    // Only the node a workspace can use is probed.
    const probed = vi.mocked(deps.apply).mock.calls
      .map((c) => c[0] as { metadata?: { name?: string }; spec?: { nodeName?: string } })
      .filter((m) => m.metadata?.name?.startsWith('yaac-cluster-check-node-'))
      .map((m) => m.spec?.nodeName)
    expect(probed).toEqual(['yaac-control-plane'])
    expect(byName(results, 'runsc-nodes')).toMatchObject({ status: 'pass' })
    expect(byName(results, 'volume-nodes')?.detail).toContain('all 1 session-eligible nodes')
    // NotReady and cordoned are named separately.
    expect(byName(results, 'volume-nodes')?.detail)
      .toContain('not swept: yaac-worker (NotReady), yaac-worker2 (cordoned)')
  })

  it('treats a tainted sessions pool as usable when the RuntimeClass tolerates it', async () => {
    // A tainted workspace pool whose toleration is on the gvisor
    // RuntimeClass (and so on every probe pod).
    clusterNodes = [
      nodeItem('yaac-control-plane', { tainted: true }),
      nodeItem('yaac-pool-1', { taints: POOL_TAINTS }),
      // A pool node under memory pressure genuinely cannot take a workspace,
      // and stays visible as such.
      nodeItem('yaac-pool-2', { taints: [...POOL_TAINTS, MEMORY_PRESSURE] }),
    ]
    gvisorTolerations = POOL_TOLERATIONS
    const deps = stage()
    const { ok, results } = await runClusterCheck()

    expect(ok).toBe(true)
    expect(byName(results, 'nodes')).toMatchObject({ status: 'pass' })
    expect(byName(results, 'nodes')?.detail)
      .toContain('3 nodes, 1 able to schedule sessions')
    expect(byName(results, 'nodes')?.detail).toContain(
      'yaac-pool-2 (untolerated taint node.kubernetes.io/memory-pressure:NoSchedule)',
    )

    // Only the healthy pool node is probed: a NoExecute taint the probe does
    // not tolerate would evict it mid-sweep.
    const probed = vi.mocked(deps.apply).mock.calls
      .map((c) => c[0] as { metadata?: { name?: string }; spec?: { nodeName?: string } })
      .filter((m) => m.metadata?.name?.startsWith('yaac-cluster-check-node-'))
      .map((m) => m.spec?.nodeName)
    expect(probed).toEqual(['yaac-pool-1'])
    for (const gate of ['runsc-nodes', 'registry-nodes', 'volume-nodes']) {
      expect(byName(results, gate), gate).toMatchObject({ status: 'pass' })
      expect(byName(results, gate)?.detail, gate).toContain(
        'yaac-pool-2 (untolerated taint node.kubernetes.io/memory-pressure:NoSchedule)',
      )
      expect(byName(results, gate)?.detail, gate).not.toContain('yaac-pool-1 (')
    }
  })

  it('points an all-tainted cluster at the RuntimeClass toleration, not at removing the taint', async () => {
    // A workspace pool whose toleration was never declared: no workspace can
    // run, but the fix must not be removing the taint.
    clusterNodes = [
      nodeItem('yaac-pool-1', { taints: POOL_TAINTS }),
      nodeItem('yaac-pool-2', { taints: POOL_TAINTS }),
    ]
    stage()
    const { ok, results } = await runClusterCheck()

    expect(ok).toBe(true)
    const nodes = byName(results, 'nodes')
    expect(nodes).toMatchObject({ status: 'warn' })
    expect(nodes?.detail).toContain('2 node(s), none able to schedule a session')
    expect(nodes?.detail).toContain(
      'yaac-pool-1 (untolerated taint yaac.dev/sessions=true:NoSchedule, '
      + 'yaac.dev/sessions=true:NoExecute)',
    )
    expect(nodes?.fix).toContain('scheduling.tolerations')
    expect(nodes?.fix).toContain('rather than removing the taint')

    // The per-node checks name the nodes too, rather than passing over an
    // empty set.
    for (const gate of ['runsc-nodes', 'registry-nodes', 'volume-nodes']) {
      expect(byName(results, gate), gate).toMatchObject({ status: 'warn' })
      expect(byName(results, gate)?.detail, gate).toContain('no node can schedule a session')
      expect(byName(results, gate)?.detail, gate).toContain('yaac-pool-1 (untolerated taint')
    }
  })

  it('skips the end-to-end probe when an earlier check failed', async () => {
    const run = happyRun()
    run.mockImplementation((file: string, args: string[]) => {
      if (file === 'podman' && args[0] === '--version') {
        return Promise.reject(new Error('podman missing'))
      }
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'nodes') {
        return Promise.resolve({ stdout: JSON.stringify({ items: [{}] }), stderr: '' })
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    })
    const deps = stage({ run })
    const { ok, results } = await runClusterCheck()

    expect(ok).toBe(false)
    expect(byName(results, 'podman')).toMatchObject({ status: 'fail' })
    expect(byName(results, 'node-fixups')).toMatchObject({ status: 'skip' })
    expect(byName(results, 'node-tuning')).toMatchObject({ status: 'skip' })
    expect(byName(results, 'probe')).toMatchObject({ status: 'skip' })
    expect(byName(results, 'egress')).toMatchObject({ status: 'skip' })
    expect(byName(results, 'datapath')).toMatchObject({ status: 'skip' })
    expect(byName(results, 'nested-mount')).toMatchObject({ status: 'skip' })
    expect(deps.pushImage).not.toHaveBeenCalled()
    // No probe object was applied (the namespace ensure may still have run).
    const appliedKinds = deps.apply.mock.calls.map((c) => (c[0] as { kind: string }).kind)
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
    const { ok, results } = await runClusterCheck()
    const fixups = byName(results, 'node-fixups')
    expect(fixups).toMatchObject({ status: 'warn' })
    expect(fixups?.detail).toContain('kubelet housekeeping-interval')
    expect(fixups?.detail).toContain('pids-limit')
    // Sysctls and TasksMax belong to the node-tuning check, via the
    // installer DaemonSet.
    expect(fixups?.detail).not.toContain('DefaultTasksMax')
    expect(fixups?.detail).not.toMatch(/sysctl|min_free|inotify/)
    expect(fixups?.fix).toContain('yaac cluster install')
    expect(byName(results, 'node-tuning')).toMatchObject({ status: 'pass' })
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
    const { results } = await runClusterCheck()
    const fixups = byName(results, 'node-fixups')
    expect(fixups).toMatchObject({ status: 'skip' })
    expect(fixups?.detail).toContain('not a podman container')
    // Tuning is still checked through the installer's pod, which works on
    // nodes yaac has no shell on.
    expect(byName(results, 'node-tuning')).toMatchObject({ status: 'pass' })
  })

  it('warns on node-tuning, naming the node and the value, when the installer has not re-applied a sysctl', async () => {
    // One node restarted and its installer pod has not run yet, so it has
    // stock defaults. Values above the target are fine.
    clusterNodes = [nodeItem('yaac-control-plane'), nodeItem('yaac-worker')]
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'exec' && args[1] === 'yaac-gvisor-install-1') {
        return {
          stdout: tunedReport({
            'vm/min_free_kbytes': '67584',
            'fs/inotify/max_user_instances': '128',
            'fs/inotify/max_user_watches': '8192',
            // systemd's default: the drop-in was never applied.
            tasksmax: 'tasksmax=4915',
          }),
          stderr: '',
        }
      }
      if (file === 'kubectl' && args[0] === 'exec' && args[1] === 'yaac-gvisor-install-0') {
        // Above target, on a kernel without compaction_proactiveness (pre-5.9):
        // both are fine.
        return {
          stdout: tunedReport({
            'vm/min_free_kbytes': '1048576', 'vm/compaction_proactiveness': 'absent',
          }),
          stderr: '',
        }
      }
      return happyResponses(file, args)
    })
    stage({ run })
    const { ok, results } = await runClusterCheck()
    const tuning = byName(results, 'node-tuning')
    expect(tuning).toMatchObject({ status: 'warn' })
    expect(tuning?.detail).toContain('yaac-worker: ')
    expect(tuning?.detail).not.toContain('yaac-control-plane')
    expect(tuning?.detail).toContain('vm.min_free_kbytes=67584 (virtiofs I/O)')
    expect(tuning?.detail).toContain('fs.inotify.max_user_instances=128 (netd Envoy startup)')
    expect(tuning?.detail).toContain('fs.inotify.max_user_watches=8192')
    expect(tuning?.detail).not.toContain('compaction_proactiveness')
    expect(tuning?.detail).toContain('DefaultTasksMax=4915')
    expect(tuning?.fix).toContain('logs -l app=yaac-gvisor-install')
    expect(tuning?.fix).toContain('yaac cluster install')
    expect(ok).toBe(true) // warn-only: the installer's next pass repairs it
  })

  it('leaves node-tuning unverified, never passed, on a node with no running installer pod', async () => {
    clusterNodes = [nodeItem('yaac-control-plane'), nodeItem('yaac-worker'), nodeItem('yaac-worker2')]
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'pods'
        && args.includes('app=yaac-gvisor-install')) {
        return {
          stdout: JSON.stringify({
            items: [
              {
                metadata: { name: 'yaac-gvisor-install-0' },
                spec: { nodeName: 'yaac-control-plane' },
                status: { phase: 'Running' },
              },
              {
                metadata: { name: 'yaac-gvisor-install-1' },
                spec: { nodeName: 'yaac-worker' },
                status: { phase: 'Pending' },
              },
            ],
          }),
          stderr: '',
        }
      }
      if (file === 'kubectl' && args[0] === 'exec' && args[1] === 'yaac-gvisor-install-0') {
        return Promise.reject(new Error('container not ready'))
      }
      return happyResponses(file, args)
    })
    stage({ run })
    const { results } = await runClusterCheck()
    const tuning = byName(results, 'node-tuning')
    expect(tuning).toMatchObject({ status: 'warn' })
    // Each uncovered node is named: the failed exec, the pod not Running
    // (with its phase), and the node with no pod at all.
    expect(tuning?.detail).toContain('yaac-control-plane (')
    expect(tuning?.detail).toContain('yaac-worker (Pending)')
    expect(tuning?.detail).toContain('1 node(s) with no installer pod')
    expect(tuning?.detail).not.toMatch(/^sysctls and DefaultTasksMax in place/)

    // No installer pod anywhere also fails.
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'pods'
        && args.includes('app=yaac-gvisor-install')) {
        return { stdout: JSON.stringify({ items: [] }), stderr: '' }
      }
      return happyResponses(file, args)
    })
    const none = byName((await runClusterCheck()).results, 'node-tuning')
    expect(none).toMatchObject({ status: 'warn' })
    expect(none?.detail).toContain('unverified')
  })

  it('fails priority-classes (and skips the probes) when a class is missing', async () => {
    // The apiserver rejects a pod naming a missing class, so a workspace
    // Job would apply and then hang with no pod.
    const run = happyRun()
    run.mockImplementation((file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'priorityclass') {
        const items = livePriorityClasses().filter((c) => c.metadata.name !== 'yaac-workspace')
        return Promise.resolve({ stdout: JSON.stringify({ items }), stderr: '' })
      }
      return happyResponses(file, args)
    })
    stage({ run })
    const { ok, results } = await runClusterCheck()
    expect(ok).toBe(false)
    const pcs = byName(results, 'priority-classes')
    expect(pcs).toMatchObject({ status: 'fail' })
    expect(pcs?.detail).toContain('yaac-workspace')
    expect(pcs?.fix).toContain('yaac cluster install')
    expect(byName(results, 'probe')).toMatchObject({ status: 'skip' })
  })

  it('warns (without failing) when an installed PriorityClass has drifted', async () => {
    // Different values still schedule, just ranked wrong, so only a warning.
    const run = happyRun()
    run.mockImplementation((file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'priorityclass') {
        const items = livePriorityClasses().map((c) =>
          c.metadata.name === 'yaac-infra' ? { ...c, value: 42 } : c)
        return Promise.resolve({ stdout: JSON.stringify({ items }), stderr: '' })
      }
      return happyResponses(file, args)
    })
    stage({ run })
    const { ok, results } = await runClusterCheck()
    expect(ok).toBe(true)
    const pcs = byName(results, 'priority-classes')
    expect(pcs).toMatchObject({ status: 'warn' })
    expect(pcs?.detail).toContain('yaac-infra')
    expect(byName(results, 'probe')).toMatchObject({ status: 'pass' })
  })

  it('fails gvisor (and skips the probes) when a RuntimeClass is missing', async () => {
    const run = happyRun()
    run.mockImplementation((file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'runtimeclass') {
        return Promise.resolve({ stdout: 'runc', stderr: '' })
      }
      return happyResponses(file, args)
    })
    stage({ run })
    const { ok, results } = await runClusterCheck()
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
    const run = happyRun()
    run.mockImplementation((file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-gvisor') {
        // The handler ran the pod on runc: no gVisor boot messages in the ring
        // buffer.
        return Promise.resolve({ stdout: 'GVISOR_NOT_SANDBOXED\n', stderr: '' })
      }
      return happyResponses(file, args)
    })
    stage({ run })
    const { ok, results } = await runClusterCheck()
    expect(ok).toBe(false)
    expect(byName(results, 'gvisor')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('not sentry-sandboxed') as string,
    })
  })

  it('warns (without failing) on runtime-stamp when an untrusted pod is not gvisor-sandboxed', async () => {
    const run = happyRun()
    run.mockImplementation((file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'pods') {
        return Promise.resolve({
          stdout: JSON.stringify({
            items: [
              // Infra on runc is expected.
              { metadata: { name: 'yaac-proxy-abc', namespace: 'test-ns' }, spec: {} },
              // A workspace pod not on gvisor is a violation.
              {
                metadata: {
                  name: 'yaac-old-session', namespace: 'test-ns',
                  labels: { 'yaac.workspace-id': 'old' },
                },
                spec: {},
              },
              // Other namespaces are out of scope.
              { metadata: { name: 'coredns-xyz', namespace: 'kube-system' }, spec: {} },
            ],
          }),
          stderr: '',
        })
      }
      return happyResponses(file, args)
    })
    stage({ run })
    const { ok, results } = await runClusterCheck()
    const stamp = byName(results, 'runtime-stamp')
    expect(stamp).toMatchObject({ status: 'warn' })
    expect(stamp?.detail).toContain('test-ns/yaac-old-session')
    expect(stamp?.detail).not.toContain('yaac-proxy-abc')
    expect(stamp?.detail).not.toContain('kube-system')
    expect(ok).toBe(true) // warn-only: unsandboxed pods keep running
  })

  it('passes the egress check when a session-labeled pod cannot reach the apiserver', async () => {
    stage()
    const { results } = await runClusterCheck()
    expect(byName(results, 'egress')).toMatchObject({
      status: 'pass',
      detail: expect.stringContaining('default-denied at the CNI') as string,
    })
  })

  it('fails the egress check when the CNI does not enforce NetworkPolicy', async () => {
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-egress') {
        return { stdout: 'NP_REACHED\n', stderr: '' }
      }
      return happyResponses(file, args)
    })
    stage({ run })
    const { ok, results } = await runClusterCheck()
    expect(ok).toBe(false)
    const egress = byName(results, 'egress')
    expect(egress).toMatchObject({ status: 'fail' })
    expect(egress?.detail).toContain('not enforcing NetworkPolicy')
    expect(egress?.fix).toContain('Calico')
  })

  it('fails the egress check when a session pod can dial a transparent port (forgery lock open)', async () => {
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'svc' && args[2] === 'yaac-proxy') {
        return { stdout: '10.96.7.7', stderr: '' }
      }
      if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-egress') {
        return { stdout: 'NP_BLOCKED\nNP_PROXY_OPEN\n', stderr: '' }
      }
      return happyResponses(file, args)
    })
    stage({ run })
    const { ok, results } = await runClusterCheck()
    expect(ok).toBe(false)
    const egress = byName(results, 'egress')
    expect(egress).toMatchObject({ status: 'fail' })
    expect(egress?.detail).toContain('forgery lock is open')
  })

  it('fails the egress check when the deployed proxy has no egress policy', async () => {
    // The proxy dials whatever a `*` allowlist names, including the kind
    // fronting's node port, where the server would treat it as the node.
    // This checks the proxy's egress policy blocks that.
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'svc' && args[2] === 'yaac-proxy') {
        return { stdout: '10.96.7.7', stderr: '' }
      }
      return happyResponses(file, args)
    })
    stage({ run })
    mockGetJson.mockImplementation((args: string[]) => Promise.resolve(
      args[1] === 'networkpolicy' && args[2] === 'yaac-proxy-egress' ? null : happyGetJson(args),
    ))
    const { ok, results } = await runClusterCheck()
    expect(ok).toBe(false)
    const egress = byName(results, 'egress')
    expect(egress).toMatchObject({ status: 'fail' })
    expect(egress?.detail).toContain('yaac-proxy-egress')
    expect(egress?.fix).toContain('yaac server restart')
  })

  it('fails the egress check when a session pod can reach the yaac server', async () => {
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'svc' && args[2] === 'yaac-server') {
        return { stdout: '10.96.7.8', stderr: '' }
      }
      if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-egress') {
        return { stdout: 'NP_BLOCKED\nNP_SERVER_OPEN\n', stderr: '' }
      }
      return happyResponses(file, args)
    })
    stage({ run })
    const { ok, results } = await runClusterCheck()
    expect(ok).toBe(false)
    const egress = byName(results, 'egress')
    expect(egress).toMatchObject({ status: 'fail' })
    expect(egress?.detail).toContain('reached the yaac server')
    // Either policy could be the missing one, so the fix names both.
    expect(egress?.fix).toContain('yaac-server-ingress')
    expect(egress?.fix).toContain('yaac-server-ingress-front')
  })

  // A workspace pod fetching through the Service checks the egress rule,
  // the cache's ingress policy and its route out at once.
  it('passes npm-cache when a session pod fetches a package through the Service\'s IP', async () => {
    const deps = stage()
    const { results } = await runClusterCheck()

    expect(byName(results, 'npm-cache')?.status).toBe('pass')
    const pod = deps.apply.mock.calls.map((c) => c[0] as {
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
    npmCacheService = null
    stage()
    const { ok, results } = await runClusterCheck()

    expect(byName(results, 'npm-cache')?.status).toBe('warn')
    expect(byName(results, 'npm-cache')?.fix).toContain('yaac cluster install')
    expect(ok).toBe(true)
  })

  // Workspaces are not pointed at a cache with no ready pod, so this only
  // slows installs.
  it('warns, without probing, when the npm cache has no ready pod', async () => {
    npmCacheReady = false
    const deps = stage()
    const { ok, results } = await runClusterCheck()

    expect(byName(results, 'npm-cache')).toMatchObject({ status: 'warn' })
    expect(byName(results, 'npm-cache')?.detail).toContain('no ready pod')
    expect(deps.apply.mock.calls.some((c) =>
      (c[0] as { metadata?: { name?: string } }).metadata?.name === 'yaac-cluster-check-npm-cache')).toBe(false)
    expect(ok).toBe(true)
  })

  // With a ready pod, workspaces use the cache, so one that cannot serve
  // breaks every install.
  it('fails npm-cache when the Service does not serve', async () => {
    npmCacheProbeOutput = 'wget: server returned error: HTTP/1.1 503\nNPM_CACHE_FAILED\n'
    stage()
    const { ok, results } = await runClusterCheck()

    expect(byName(results, 'npm-cache')?.status).toBe('fail')
    expect(byName(results, 'npm-cache')?.detail).toContain('503')
    expect(ok).toBe(false)
  })

  it('passes datapath when calico-node and netd are both rolled out', async () => {
    stage()
    const { results } = await runClusterCheck()
    expect(byName(results, 'datapath')).toMatchObject({
      status: 'pass',
      detail: expect.stringContaining('policy enforced, egress redirected') as string,
    })
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
    const { ok, results } = await runClusterCheck()

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
    const { ok, results } = await runClusterCheck()

    expect(ok).toBe(true)
    expect(byName(results, 'veth-source')).toMatchObject({ status: 'warn' })
    expect(byName(results, 'veth-source')?.detail).toContain('unverified on yaac-control-plane')
  })

  it('fails datapath when calico-node is not ready (policy unenforced)', async () => {
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'daemonset'
        && args[2] === 'calico-node') {
        return { stdout: '0/1', stderr: '' }
      }
      return happyResponses(file, args)
    })
    stage({ run })
    const { ok, results } = await runClusterCheck()
    expect(ok).toBe(false)
    const datapath = byName(results, 'datapath')
    expect(datapath).toMatchObject({ status: 'fail' })
    expect(datapath?.detail).toContain('NetworkPolicy is not being enforced')
  })

  it('names the unhealthy netd container when the DaemonSet is not ready', async () => {
    // netd's readiness is Envoy's config ack, so the DaemonSet counters
    // cannot tell a broken sidecar from a broken netd.
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'daemonset'
        && args[2] === 'yaac-netd') {
        return { stdout: '0/1', stderr: '' }
      }
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'pods'
        && args.includes('app=yaac-netd')) {
        return {
          stdout: JSON.stringify({
            items: [{
              status: {
                containerStatuses: [
                  { name: 'netd', ready: false },
                  { name: 'envoy', ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } },
                ],
              },
            }],
          }),
          stderr: '',
        }
      }
      return happyResponses(file, args)
    })
    stage({ run })
    const { results } = await runClusterCheck()
    const datapath = byName(results, 'datapath')
    expect(datapath).toMatchObject({ status: 'fail' })
    expect(datapath?.detail).toContain('envoy: CrashLoopBackOff')
    expect(datapath?.fix).toContain('-c envoy')
  })

  it('dedupes the unhealthy netd containers and tolerates unreadable pod JSON', async () => {
    const withPods = async (podsStdout: string): Promise<string> => {
      const run = happyRun()
      run.mockImplementation(async (file: string, args: string[]) => {
        if (file === 'kubectl' && args[0] === 'get' && args[1] === 'daemonset'
          && args[2] === 'yaac-netd') {
          return { stdout: '0/1', stderr: '' }
        }
        if (file === 'kubectl' && args[0] === 'get' && args[1] === 'pods'
          && args.includes('app=yaac-netd')) {
          return { stdout: podsStdout, stderr: '' }
        }
        return happyResponses(file, args)
      })
      stage({ run })
      const { results } = await runClusterCheck()
      return byName(results, 'datapath')?.detail ?? ''
    }

    // Each fault is named once, however many pods have it. Ready and nameless
    // containers are not faults.
    const pod = {
      status: {
        containerStatuses: [
          { name: 'envoy', ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } },
          { name: 'netd', ready: true },
          { ready: false },
        ],
      },
    }
    const detail = await withPods(JSON.stringify({ items: [pod, pod] }))
    expect(detail.match(/envoy: CrashLoopBackOff/g)).toHaveLength(1)
    expect(detail).not.toContain('netd: ')

    expect(await withPods(JSON.stringify({
      items: [{ status: { containerStatuses: [{ name: 'netd', ready: false }] } }],
    }))).toContain('netd: not ready')

    // Unreadable output must not crash and hide the real failure.
    for (const junk of ['', 'not json', '{}']) {
      const d = await withPods(junk)
      expect(d).toContain('session egress has no redirect')
      expect(d).not.toContain('(')
    }
  })

  it('fails datapath when netd is absent (session egress has no redirect)', async () => {
    // Fails closed (workspaces lose egress), unlike a missing Calico, so the
    // two are reported differently.
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'daemonset'
        && args[2] === 'yaac-netd') {
        throw new Error('daemonsets.apps "yaac-netd" not found')
      }
      return happyResponses(file, args)
    })
    stage({ run })
    const { ok, results } = await runClusterCheck()
    expect(ok).toBe(false)
    const datapath = byName(results, 'datapath')
    expect(datapath).toMatchObject({ status: 'fail' })
    expect(datapath?.detail).toContain('not deployed')
  })

  it('runs the nested-mount probe under the exact nested session securityContext', async () => {
    const deps = stage()
    const { results } = await runClusterCheck()
    expect(byName(results, 'nested-mount')).toMatchObject({ status: 'pass' })

    const probePod = vi.mocked(deps.apply).mock.calls
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
    const { ok, results } = await runClusterCheck()
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
    const deps = stage()
    clusterNodes = [nodeItem('yaac-control-plane'), nodeItem('yaac-worker'), nodeItem('yaac-worker2')]
    await runClusterCheck()
    const pods = deps.apply.mock.calls
      .map(([m]) => m as { kind: string; metadata: { name: string }; spec: { volumes?: Array<{ hostPath?: { path: string }; persistentVolumeClaim?: { claimName: string } }> } })
      .filter((m) => m.kind === 'Pod' && /^yaac-cluster-check(-node-\d+|-fsprobe)?$/.test(m.metadata.name))
    expect(pods.length).toBeGreaterThanOrEqual(4)
    for (const pod of pods) {
      expect(pod.spec.volumes?.some((v) => v.persistentVolumeClaim?.claimName === 'yaac-global')).toBe(true)
      expect(pod.spec.volumes?.some((v) => v.hostPath?.path.startsWith(tmpDir))).toBe(false)
    }
  })

  it('fails on storage-semantics naming the failing probes', async () => {
    fsprobeOutput = [
      'PASS  creation ownership (uid passthrough)  uid/gid 1000/1000 preserved',
      'FAIL  flock (LOCK_EX)                       AssertionError: second flock did not block',
      'FAIL  hardlink / link(2)                    OSError: [Errno 95] Operation not supported',
      '',
      '9/11 passed',
    ].join('\n')
    podPhases = { 'yaac-cluster-check-fsprobe': 'Failed' }
    stage()
    const { ok, results } = await runClusterCheck()
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
    fsprobeOutput = [
      'PASS  creation ownership (uid passthrough)  uid/gid 1000/1000 preserved',
      'FAIL  user.* xattr                          AssertionError: setxattr user.* failed',
      '',
      '10/11 passed',
    ].join('\n')
    podPhases = { 'yaac-cluster-check-fsprobe': 'Failed' }
    stage()
    const { results } = await runClusterCheck()
    const semantics = byName(results, 'storage-semantics')!
    expect(semantics.status).toBe('pass')
    expect(semantics.detail).toMatch(/10\/11 passed; waived: user\.\* xattr \(nothing yaac keeps on the shared tier uses xattrs\)/)
  })

  it('fails on storage-semantics when the probe printed no summary, rather than passing on silence', async () => {
    fsprobeOutput = ''
    stage()
    const { ok, results } = await runClusterCheck()
    expect(ok).toBe(false)
    const semantics = byName(results, 'storage-semantics')!
    expect(semantics.status).toBe('fail')
    expect(semantics.detail).toContain('no summary')
  })

  it('judges a class-provisioned global volume by its labels, its class and its actimeo', async () => {
    // A byo install's provisioned volume is held to what install set on it.
    let volume = byoGlobalVolume()
    let provisioner = 'nfs.csi.k8s.io'
    mockGetJson.mockImplementation((args: string[]) => Promise.resolve(
      args[1] === 'pv' && args[2].startsWith('yaac-global') ? volume
        : args[1] === 'storageclass' ? { provisioner }
          : happyGetJson(args),
    ))
    const deps = stage()
    let { results } = await runClusterCheck()
    expect(byName(results, 'storage')).toMatchObject({ status: 'pass' })
    expect(byName(results, 'storage')?.detail).toContain('yaac-global → yaac-global-ddh (byo-nfs)')
    // The egress probe also dials the NFS server, which trusts any uid a
    // client claims; the fake pod was blocked, so it passes.
    const egressPod = vi.mocked(deps.apply).mock.calls
      .map((c) => c[0] as { metadata?: { name?: string }; spec?: { containers?: Array<{ command: string[] }> } })
      .find((m) => m.metadata?.name === 'yaac-cluster-check-egress')
    expect(egressPod?.spec?.containers?.[0].command[2]).toContain('nc -w 4 10.96.5.5 2049')
    expect(byName(results, 'egress')?.detail).toContain('the NFS server 10.96.5.5')

    // A non-NFS provisioner, a lost label and the class's own actimeo are
    // each named.
    provisioner = 'ebs.csi.aws.com'
    volume = {
      ...volume,
      metadata: { labels: {} },
      spec: { ...volume.spec, mountOptions: ['nfsvers=4.1', 'actimeo=30'] },
    }
    ;({ results } = await runClusterCheck())
    const storage = byName(results, 'storage')!
    expect(storage.status).toBe('fail')
    expect(storage.detail).toContain('does not carry this install\'s labels')
    expect(storage.detail).toContain('class byo-nfs (ebs.csi.aws.com) is not NFS-family')
    expect(storage.detail).toContain('actimeo=30, not actimeo<=1')
  })

  it('tells a provisioned hostPath volume (local-path) from kind\'s static one by its class', async () => {
    // local-path (k3s, kind-byo) provisions hostPath volumes at its own path,
    // which the static-pair checks would wrongly flag.
    await writeServerConfig({
      url: 'https://yaac.tailnet.ts.net', enabled: true, saved: [], driver: 'k8s', installId: 'install-1', byo: true,
    })
    const labelled = (claim: string, id: string): Record<string, string> =>
      ({ 'yaac.install-id': id, 'yaac.data-dir-hash': 'ddh16', 'yaac.claim': claim })
    let localId = 'install-1'
    mockGetJson.mockImplementation((args: string[]) => Promise.resolve(
      args[1] === 'pv' && args[2].startsWith('yaac-global')
        ? { ...byoGlobalVolume(), metadata: { labels: labelled('yaac-global', 'install-1') } }
        : args[1] === 'pv'
          ? {
            metadata: { labels: labelled('yaac-server-local', localId) },
            spec: {
              persistentVolumeReclaimPolicy: 'Retain', storageClassName: 'local-path',
              hostPath: { path: '/var/lib/rancher/k3s/storage/pvc-1_yaac_yaac-server-local' },
            },
          }
          : args[1] === 'storageclass' ? { provisioner: 'nfs.csi.k8s.io' }
            : happyGetJson(args),
    ))
    stage()
    let { results } = await runClusterCheck()
    expect(byName(results, 'storage')).toMatchObject({ status: 'pass' })
    expect(byName(results, 'storage')?.detail).toContain('(local-path)')

    // With an install id recorded, the id (not the path hash) decides
    // ownership, as re-adoption does.
    localId = 'install-2'
    ;({ results } = await runClusterCheck())
    expect(byName(results, 'storage')?.status).toBe('fail')
    expect(byName(results, 'storage')?.detail).toMatch(/yaac-server-local: volume .* does not carry this install's labels/)
  })

  it('fails egress when a session pod reaches the NFS server behind the global claim', async () => {
    mockGetJson.mockImplementation((args: string[]) => Promise.resolve(
      args[1] === 'pv' && args[2].startsWith('yaac-global') ? byoGlobalVolume()
        : args[1] === 'storageclass' ? { provisioner: 'nfs.csi.k8s.io' }
          : happyGetJson(args),
    ))
    const run = happyRun()
    run.mockImplementation((file: string, args: string[]) =>
      file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-egress'
        ? Promise.resolve({ stdout: 'NP_BLOCKED\nNP_NFS_OPEN\n', stderr: '' })
        : happyResponses(file, args))
    stage({ run })
    const { results } = await runClusterCheck()
    expect(byName(results, 'egress')).toMatchObject({ status: 'fail' })
    expect(byName(results, 'egress')?.detail).toMatch(/reached the NFS server .*10\.96\.5\.5/)
  })

  it('fails a pool that has drifted from what --byo installed on, naming the nodes', async () => {
    // The same checks `--byo` runs, repeated to catch nodes added later.
    clusterNodes = [
      nodeItem('pool-a'),
      nodeItem('pool-b', { nodeInfo: { architecture: 'ppc64le' } }),
      nodeItem('pool-c', { nodeInfo: { osImage: 'Bottlerocket OS 1.20.0' } }),
    ]
    stage()
    const { ok, results } = await runClusterCheck()
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
    const { results } = await runClusterCheck()
    expect(byName(results, 'node-fixups')).toMatchObject({ status: 'skip' })
    expect(deps.run.mock.calls.some(([f, a]) => f === 'podman' && a[0] === 'exec')).toBe(false)
  })

  it('warns (without failing) when the nested sentry mount fails', async () => {
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-nested') {
        return { stdout: 'NESTED_MOUNT_FAIL\n', stderr: '' }
      }
      return happyResponses(file, args)
    })
    stage({ run })
    const { ok, results } = await runClusterCheck()
    const nested = byName(results, 'nested-mount')
    expect(nested).toMatchObject({ status: 'warn' })
    expect(nested?.fix).toContain('cluster install')
    expect(ok).toBe(true) // warn-only — only nestedContainers sessions are affected
  })

  it('fails on vap when the ValidatingAdmissionPolicy API is unavailable', async () => {
    // vapAvailable() is stubbed at the kubectl layer, not deps.run.
    mockRetry.mockRejectedValue(new Error("the server doesn't have a resource type"))
    stage()
    const { ok, results } = await runClusterCheck()
    const vap = byName(results, 'vap')
    expect(vap).toMatchObject({ status: 'fail' })
    expect(vap?.detail).toContain('ValidatingAdmissionPolicy API unavailable')
    expect(vap?.fix).toContain('image builds')
    // Fails: without the API the guard refuses to apply, so no workspace
    // image can be built.
    expect(ok).toBe(false)
  })

  it('fails the registry check when an anonymous write is accepted', async () => {
    stage()
    const healthy = byName((await runClusterCheck()).results, 'registry')
    expect(healthy).toMatchObject({ status: 'pass' })
    expect(healthy?.detail).toContain('writes need a grant')
    // Probed with an anonymous upload start.
    expect(gateProbes).toEqual([
      { url: 'http://127.0.0.1:41234/v2/yaac-cluster-probe/blobs/uploads/', method: 'POST' },
    ])

    // An ungated registry answers reads too; only a write shows the gate is
    // missing.
    gateStatus = 202
    const { ok, results } = await runClusterCheck()
    expect(ok).toBe(false)
    expect(byName(results, 'registry')).toMatchObject({ status: 'fail' })
    expect(byName(results, 'registry')?.fix).toContain('yaac cluster install')

    gateStatus = null
    const unverified = byName((await runClusterCheck()).results, 'registry')
    expect(unverified).toMatchObject({ status: 'warn' })
    expect(unverified?.detail).toContain('no answer')
  })

  it('fails the registry check with repair instructions when nothing answers', async () => {
    stage({
      registryReachable: false,
    })
    const { ok, results } = await runClusterCheck()
    expect(ok).toBe(false)
    const registry = byName(results, 'registry')
    expect(registry).toMatchObject({ status: 'fail' })
    // The fix is a repair install and a look at the Deployment.
    expect(registry?.fix).toContain('yaac cluster install')
    expect(registry?.fix).toContain('app=yaac-main-registry')
  })

  it('fails the probe with wiring hints when the pod ends in a non-Succeeded phase', async () => {
    // Only the e2e probe pod fails; the gvisor probe still succeeds.
    mockGetJson.mockImplementation((args: string[]) => Promise.resolve(
      args.includes('yaac-cluster-check')
        ? { status: { phase: 'Failed' } }
        : happyGetJson(args),
    ))
    stage()
    const { ok, results } = await runClusterCheck()
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
    const { ok, results } = await runClusterCheck()
    expect(ok).toBe(false)
    const probe = byName(results, 'probe')
    expect(probe).toMatchObject({ status: 'fail' })
    expect(probe?.detail).toContain('never reached its peer')
    expect(probe?.fix).toContain('uid')
  })

  it('fails the probe, naming the peer, when the pod never sees the peer\'s nonce', async () => {
    const run = happyRun()
    run.mockImplementation((file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check') {
        return Promise.resolve({ stdout: 'PROBE_READ=\n', stderr: '' })
      }
      return happyResponses(file, args)
    })
    podPhases = { 'yaac-cluster-check-peer': 'Failed' }
    stage({ run })
    const { ok, results } = await runClusterCheck()
    expect(ok).toBe(false)
    expect(byName(results, 'probe')?.detail).toMatch(/never saw the nonce.*peer: phase Failed/)
  })

  it('fails the probe when the pod reads stale data', async () => {
    const run = happyRun()
    run.mockImplementation((file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check') {
        return Promise.resolve({ stdout: 'PROBE_READ=some-stale-nonce\n', stderr: '' })
      }
      return happyResponses(file, args)
    })
    stage({ run })
    const { ok, results } = await runClusterCheck()
    expect(ok).toBe(false)
    expect(byName(results, 'probe')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('stale data') as string,
    })
  })
})
