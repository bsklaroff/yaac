import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type * as sharedGitModule from '@yaac/shared/git'

vi.mock('#drivers/k8s/substrate/kubectl', async (importOriginal) => ({
  // The REAL predicate: these suites drive the absent-vs-unevaluable
  // split, which is the whole point of the adoption gate's reads.
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

// The bottom of the identity-drift check: what THIS host is configured with.
// Mocked because a developer machine always has one, which would make both
// the agreeing and the absent case unreachable.
const mockGitUserConfig = vi.hoisted(() => vi.fn())
vi.mock('@yaac/shared/git', async (importOriginal) => ({
  ...(await importOriginal<typeof sharedGitModule>()),
  getGitUserConfig: mockGitUserConfig,
}))

vi.mock('#drivers/k8s/container/registry', () => ({
  REGISTRY_NAMESPACE: 'yaac',
  registryReachable: vi.fn().mockResolvedValue(true),
  registryHost: vi.fn(() => 'yaac-registry.yaac.svc.cluster.local:5000'),
  registryRef: vi.fn((tag: string) => `yaac-registry.yaac.svc.cluster.local:5000/${tag}`),
  registryHasTag: vi.fn().mockResolvedValue(true),
  pushImageToRegistry: vi.fn().mockResolvedValue(
    'yaac-registry.yaac.svc.cluster.local:5000/yaac-cluster-probe:busybox-1.36',
  ),
}))

import { formatCheckResult, runClusterCheck } from '#drivers/k8s/install'
import type { CheckResult } from '@yaac/shared/types'
import { execFileAsync, kubectlApply, kubectlGetJson, kubectlWithRetry } from '#drivers/k8s/substrate/kubectl'
import { pushImageToRegistry, registryReachable } from '#drivers/k8s/container/registry'
import { resetClusterCidrCache } from '#drivers/k8s/cluster/cluster-cidrs'
import { podUid } from '#drivers/k8s/substrate'
import { buildPriorityClassManifests, buildRuntimeClassManifests, GVISOR_NODE_LABEL } from '#drivers/k8s/substrate'
import type { NodeTaint, PodToleration } from '#drivers/k8s/substrate'
import { createTempDataDir, cleanupTempDir, getDataDir } from '@yaac/test-utils/setup'

const mockGetJson = vi.mocked(kubectlGetJson)
const mockRun = vi.mocked(execFileAsync)
const mockApply = vi.mocked(kubectlApply)
const mockPush = vi.mocked(pushImageToRegistry)
const mockReachable = vi.mocked(registryReachable)
// The vap check probes through vapAvailable() (proxy-apply.ts), which runs on
// kubectlWithRetry rather than deps.run.
const mockRetry = vi.mocked(kubectlWithRetry)

type RunMock = ReturnType<typeof vi.fn<
  (file: string, args: string[], opts?: unknown) => Promise<{ stdout: string; stderr: string }>
>>

/**
 * Stand-in for the probe pod's side effect: the pod writes a marker file
 * through the hostPath mount, which the check verifies host-side. Called
 * from the mocked `kubectl logs` branch (the pod has "finished" by then).
 */
async function simulateProbeWrite(): Promise<void> {
  await fs.writeFile(path.join(getDataDir(), '.cluster-check-write'), 'ok\n')
}

interface LivePriorityClass {
  metadata: { name: string }
  value: number
  preemptionPolicy: string
}

/**
 * The installed PriorityClasses as the apiserver hands them back: same
 * objects `yaac cluster install` applies, except that kubernetes materializes
 * the omitted preemptionPolicy into an explicit PreemptLowerPriority — the
 * asymmetry the check has to tolerate.
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
 * The taint a dedicated sessions pool carries, and the toleration the gvisor
 * RuntimeClass declares for it — the pool is tainted so nothing else drifts
 * onto it, and admission merges the toleration into every pod naming the
 * class. Both effects, because a pool taint is normally both: keep others
 * off, and evict what already drifted on.
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
 * A node object shaped like the apiserver's, with the fields the readiness
 * gates read: Ready condition, cordon/taints (what makes a node unable to
 * take a session), and the kubelet's runtime-handler report.
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
    /** Omit the label the installer DaemonSet stamps — i.e. a node the
     *  runtime has not converged on, which the RuntimeClass will not
     *  schedule a sandboxed pod onto. */
    gvisorLabel?: boolean
    labels?: Record<string, string>
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
    },
  }
}

/**
 * The cluster topology the fake `kubectl get nodes` serves. Reset to a
 * single control-plane node before each test; the multi-node cases
 * reassign it.
 */
let clusterNodes: Array<Record<string, unknown>> = []
/** What the installed gvisor RuntimeClass declares in
 *  `scheduling.tolerations` — i.e. what a session pod inherits, and so what
 *  the check matches node taints against. Empty on a local cluster. */
let gvisorTolerations: PodToleration[] = []
/** What the server Deployment states for env, read by the identity check. */
let serverDeployEnv: Array<{ name: string; value?: string }> = []
/** Pod name → terminal phase, for probe pods a test wants to fail. */
let podPhases: Record<string, string> = {}
/** Per-node probe indices whose pod "ran" without its write reaching the host. */
let nodeMarkerFails: Set<string> = new Set()
/** Pod name → the kubelet Warning event the check reads to attribute a
 *  probe pod that never ran, as `<reason>|<message>`. */
let podEvents: Record<string, string> = {}

/**
 * deps.run implementation covering every probe the all-pass path makes.
 * `kubectl logs` echoes back the nonce file runClusterCheck wrote so the
 * end-to-end probe's freshness assertion passes, and drops the probe
 * pod's write marker so the hostPath write-back assertion passes.
 */
async function happyResponses(
  file: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'nodes'
    && args.includes('jsonpath={.items[*].metadata.name}')) {
    // Honors `-l` so the gvisor gate's "does any node carry the installer
    // label" read means something on a partly-converged fixture.
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
  // The server Deployment's env, read for the git-identity drift check.
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'deployment') {
    return { stdout: JSON.stringify(serverDeployEnv), stderr: '' }
  }
  // The check reads the gvisor RuntimeClass object for its handler name and
  // both halves of its scheduling — the nodeSelector the sweep honors and
  // the tolerations session eligibility is matched against — served from the
  // same builder the installer applies, so the check cannot drift from it.
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
  // Events for a probe pod that never ran — what the sweep attributes the
  // failure from (a Pending pod has no container statuses to read).
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
    const index = args[1].slice('yaac-cluster-check-node-'.length)
    const nonce = await fs.readFile(
      path.join(getDataDir(), '.cluster-check-nodes-nonce'), 'utf8',
    )
    if (!nodeMarkerFails.has(index)) {
      await fs.writeFile(path.join(getDataDir(), `.cluster-check-node-${index}`), 'ok\n')
    }
    return { stdout: `GVISOR_SANDBOXED\n${nonce}\n`, stderr: '' }
  }
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'priorityclass') {
    return { stdout: JSON.stringify({ items: livePriorityClasses() }), stderr: '' }
  }
  if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-gvisor') {
    return { stdout: 'GVISOR_SANDBOXED\n', stderr: '' }
  }
  if (file === 'kubectl' && args[0] === 'get' && args[1] === 'pods'
    && args.includes('app=yaac-netd')) {
    // The veth-source gate reads every netd pod, then execs each one for
    // its own node's routing table.
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
    // runtime-stamp sweep (-A): every untrusted (session-labeled / synced)
    // pod is gvisor-sandboxed; unstamped infra (the proxy) is fine, and
    // kube-system pods are out of scope by namespace.
    return {
      stdout: JSON.stringify({
        items: [
          {
            metadata: {
              name: 'yaac-session-abc', namespace: 'test-ns',
              labels: { 'yaac.worktree-id': 'abc' },
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
    return {
      stdout: 'tasksmax=ok\nminfree=262144\n'
        + 'inotifyinst=1024\ninotifywatch=524288\nhk=ok\n',
      stderr: '',
    }
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
  if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-nested') {
    return { stdout: 'NESTED_MOUNT_OK\n', stderr: '' }
  }
  if (file === 'kubectl' && args[0] === 'logs') {
    const nonce = await fs.readFile(path.join(getDataDir(), '.cluster-check-nonce'), 'utf8')
    await simulateProbeWrite()
    return { stdout: `${nonce}\n`, stderr: '' }
  }
  return { stdout: '', stderr: '' }
}

function happyRun(): RunMock {
  return vi.fn(happyResponses)
}

/** Pod-phase responses: every probe pod completes successfully unless a
 *  test staged a different phase for it in `podPhases`. */
function happyGetJson(args: string[]): unknown {
  // The node/apiserver reads the real cluster-cidrs probe makes for the
  // policies the egress check exercises.
  if (args[1] === 'nodes') {
    return { items: [{ status: { addresses: [{ type: 'InternalIP', address: '10.89.0.7' }] } }] }
  }
  if (args[1] === 'endpoints') return { subsets: [{ addresses: [{ ip: '10.89.0.7' }] }] }
  if (args[1] === 'pod') return { status: { phase: podPhases[args[2]] ?? 'Succeeded' } }
  return { status: { phase: 'Succeeded' } }
}

interface Staged {
  run: RunMock
  apply: typeof mockApply
  pushImage: typeof mockPush
}

/**
 * Install the process-boundary fakes one check run needs — the subprocess
 * runner, the registry ping and push, and kubectl apply — and hand back the
 * call records the assertions read. `ensureNamespace` is a sibling and runs
 * for real, so its Namespace apply shows up in `apply`.
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
    // Default: the pod states exactly what this host is configured with.
    serverDeployEnv = [
      { name: 'YAAC_SERVER_GIT_NAME', value: 'A B' },
      { name: 'YAAC_SERVER_GIT_EMAIL', value: 'a@b.co' },
    ]
    mockGitUserConfig.mockResolvedValue({ name: 'A B', email: 'a@b.co' })
    podPhases = {}
    nodeMarkerFails = new Set()
    podEvents = {}
    // Probe pods complete successfully unless a test overrides.
    mockGetJson.mockImplementation((args: string[]) => Promise.resolve(happyGetJson(args)))
    // vapAvailable()'s kubectl probe answers unless a test overrides.
    mockRetry.mockReset()
    mockRetry.mockResolvedValue({ stdout: '', stderr: '' })
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('passes every check on a healthy single-node cluster', async () => {
    const deps = stage()
    const { ok, results } = await runClusterCheck()

    expect(results.map((r) => [r.name, r.status])).toEqual([
      ['kubectl', 'pass'],
      ['cluster', 'pass'],
      ['nodes', 'pass'],
      ['podman', 'pass'],
      ['registry', 'pass'],
      ['namespace', 'pass'],
      ['priority-classes', 'pass'],
      ['node-fixups', 'pass'],
      ['gvisor', 'pass'],
      ['probe', 'pass'],
      ['egress', 'pass'],
      ['datapath', 'pass'],
      // Re-verified on every run, not only at --adopt-cni time: netd's
      // readiness is Envoy's config ack, which is green with zero pod →
      // veth mappings, so nothing else here would notice a prefix that
      // resolves nothing.
      ['veth-source', 'pass'],
      // Per-node readiness is a multi-node question: on one node the
      // gvisor/probe/egress gates above already covered it.
      ['runsc-nodes', 'skip'],
      ['registry-nodes', 'skip'],
      ['volume-nodes', 'skip'],
      ['nested-mount', 'pass'],
      ['vap', 'pass'],
      ['runtime-stamp', 'pass'],
    ])
    expect(ok).toBe(true)
    expect(byName(results, 'datapath')?.detail).toContain('calico-node and yaac-netd ready')

    // Probe ran through the deps: image pushed, pod applied, pod deleted.
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
        securityContext: { seccompProfile: { type: string } }
        containers: Array<{
          securityContext?: { runAsUser?: number }
          volumeMounts: Array<{ readOnly?: boolean }>
        }>
        volumes: Array<{ hostPath: { path: string } }>
      }
    }
    expect(podManifest.kind).toBe('Pod')
    expect(podManifest.spec.volumes[0].hostPath.path).toBe(getDataDir())
    // The probe mirrors the session-pod containment: the default gvisor
    // tier with no user namespace (the sentry replaces it).
    expect(podManifest.spec.runtimeClassName).toBe('gvisor')
    expect(podManifest.spec.hostUsers).toBeUndefined()
    expect(podManifest.spec.securityContext).toEqual({
      seccompProfile: { type: 'RuntimeDefault' },
    })
    // The probe writes through the mount at the session-image uid, so it
    // must run at that uid with a read-write mount.
    expect(podManifest.spec.containers[0].securityContext).toEqual({
      runAsUser: podUid(),
    })
    expect(podManifest.spec.containers[0].volumeMounts[0].readOnly).toBeUndefined()
    // The nonce and write-marker files are cleaned up afterwards.
    await expect(
      fs.access(path.join(getDataDir(), '.cluster-check-nonce')),
    ).rejects.toThrow()
    await expect(
      fs.access(path.join(getDataDir(), '.cluster-check-write')),
    ).rejects.toThrow()
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
    // Node count is advisory (hostPath assumes one), so an unreadable list
    // must not fail the run.
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
    // The topology `--nodes 3` actually produces: kind keeps the
    // control-plane's NoSchedule taint once a cluster has workers, and
    // session pods tolerate nothing — so sessions run on the workers.
    clusterNodes = [
      nodeItem('yaac-control-plane', { tainted: true }),
      nodeItem('yaac-worker'),
      nodeItem('yaac-worker2'),
    ]
    const deps = stage()
    const { ok, results } = await runClusterCheck()

    expect(ok).toBe(true)
    // Multi-node is a supported topology, not a warning — and the two
    // counts are reported separately, because they differ here.
    expect(byName(results, 'nodes')).toMatchObject({ status: 'pass' })
    // The node left out is NAMED, with the taint that left it out: "2 of 3"
    // alone reads the same whether the third node is a control plane or a
    // worker that just went under memory pressure.
    expect(byName(results, 'nodes')?.detail).toBe(
      '3 nodes, 2 able to schedule sessions; skipping yaac-control-plane '
      + '(untolerated taint node-role.kubernetes.io/control-plane:NoSchedule)',
    )
    expect(byName(results, 'runsc-nodes')).toMatchObject({ status: 'pass' })
    expect(byName(results, 'runsc-nodes')?.detail).toContain('all 2 session-capable nodes')
    // ...and the same in the sweep's own gates, which otherwise report full
    // coverage of a population they quietly narrowed.
    for (const gate of ['runsc-nodes', 'registry-nodes', 'volume-nodes']) {
      expect(byName(results, gate)?.detail, gate).toContain(
        'not swept: yaac-control-plane '
        + '(untolerated taint node-role.kubernetes.io/control-plane:NoSchedule)',
      )
    }
    // The sentry fingerprint is a bonus the probe prints when it can read
    // dmesg at the session uid.
    expect(byName(results, 'runsc-nodes')?.detail).toContain('2 sentry-verified')
    expect(byName(results, 'registry-nodes')).toMatchObject({ status: 'pass' })
    expect(byName(results, 'volume-nodes')).toMatchObject({ status: 'pass' })

    // One pod per eligible node, pinned by nodeName (the scheduler would
    // answer a different question), on the session tier, pulling for real.
    // The tainted control plane is not probed: no session can land there.
    const nodePods = vi.mocked(deps.apply).mock.calls
      .map((c) => c[0] as {
        kind: string
        metadata?: { name?: string }
        spec?: {
          nodeName?: string
          runtimeClassName?: string
          containers: Array<{
            imagePullPolicy?: string
            securityContext?: { runAsUser?: number }
          }>
          volumes: Array<{ hostPath?: { path?: string } }>
        }
      })
      .filter((m) => m.metadata?.name?.startsWith('yaac-cluster-check-node-'))
    expect(nodePods.map((p) => p.spec?.nodeName).sort())
      .toEqual(['yaac-worker', 'yaac-worker2'])
    for (const pod of nodePods) {
      expect(pod.spec?.runtimeClassName).toBe('gvisor')
      // Always, so a layer already on the node cannot mask an unreachable
      // registry.
      expect(pod.spec?.containers[0].imagePullPolicy).toBe('Always')
      expect(pod.spec?.containers[0].securityContext?.runAsUser).toBe(podUid())
      expect(pod.spec?.volumes[0].hostPath?.path).toBe(getDataDir())
    }

    // Nonce and per-node markers are cleaned up.
    await expect(
      fs.access(path.join(getDataDir(), '.cluster-check-nodes-nonce')),
    ).rejects.toThrow()
    await expect(
      fs.access(path.join(getDataDir(), '.cluster-check-node-0')),
    ).rejects.toThrow()
  })

  it('attributes a probe pod that never ran to the gate that can fix it', async () => {
    // Three different broken nodes, all of which present as "the pod did
    // not run" from the phase alone:
    //   worker  — containerd never registered the runsc handler (and its
    //             kubelet publishes the handler list, which says so).
    //   worker2 — no $HOME extraMount, so the hostPath volume cannot mount.
    //             kubelet sets volumes up BEFORE it pulls, so this node
    //             never touched the registry.
    //   worker3 — the pod ran, but its write at the session uid never
    //             reached the host.
    clusterNodes = [
      nodeItem('yaac-control-plane', { tainted: true }),
      nodeItem('yaac-worker', { handlers: ['runc'] }),
      nodeItem('yaac-worker2'),
      nodeItem('yaac-worker3'),
    ]
    // The phase itself carries no diagnosis (a real mount failure sits in
    // Pending to the timeout) — the kubelet event below is what the sweep
    // attributes from, which is the point of these two cases.
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

    // Every readiness gate is advisory: a single-node-sized install still
    // works, so these never fail the run.
    expect(ok).toBe(true)

    const runsc = byName(results, 'runsc-nodes')
    expect(runsc).toMatchObject({ status: 'warn' })
    expect(runsc?.detail).toContain('yaac-worker')
    expect(runsc?.fix).toContain('yaac cluster install')

    // The mount failure is NOT reported as a registry problem — that would
    // hand the user a hosts.toml repair that cannot add an extraMount.
    const registry = byName(results, 'registry-nodes')
    expect(registry).toMatchObject({ status: 'warn' })
    expect(registry?.detail).not.toContain('could not pull')
    expect(registry?.detail).toContain('unverified on yaac-worker, yaac-worker2')
    expect(registry?.fix).toBeUndefined()

    // ...it lands here, with the extraMount fix, alongside the node whose
    // write did not reach the host. Crucially this does not PASS just
    // because the two nodes that did run were fine.
    const volume = byName(results, 'volume-nodes')
    expect(volume).toMatchObject({ status: 'warn' })
    expect(volume?.detail).toContain('yaac-worker2 (FailedMount')
    expect(volume?.detail).toContain('yaac-worker3')
    expect(volume?.detail).toContain('unverified on yaac-worker')
    expect(volume?.fix).toContain('extraMount')
  })

  it('claims no gate for a probe failure it cannot attribute', async () => {
    // A CNI-broken node fails with FailedCreatePodSandBox too, so blaming
    // the runsc gate on the reason alone would send the user to reinstall a
    // runtime that is fine. Unrecognized stays unverified everywhere.
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
      // No gate claims it, so no gate offers its repair for it.
      expect(gate?.fix, name).toBeUndefined()
    }
  })

  it('reports a node the gVisor installer has not reached instead of dropping it', async () => {
    // The RuntimeClasses schedule on the label the installer DaemonSet
    // stamps, so an unlabelled node cannot be probed at all. It must not
    // fall out of the sweep for that reason — "the runtime has not landed
    // here" is the finding, not a reason to stop looking.
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
    // The installer DaemonSet is the repair, not `--repair`'s podman work.
    expect(runsc?.fix).toContain('yaac-gvisor-install')

    // Unprobeable, so the other two gates say so rather than passing on a
    // node they never reached.
    expect(byName(results, 'registry-nodes')?.detail).toContain('unverified on yaac-worker2')
    expect(byName(results, 'volume-nodes')?.detail).toContain('unverified on yaac-worker2')

    // Only the labelled worker was probed.
    const probed = vi.mocked(deps.apply).mock.calls
      .map((c) => c[0] as { metadata?: { name?: string }; spec?: { nodeName?: string } })
      .filter((m) => m.metadata?.name?.startsWith('yaac-cluster-check-node-'))
      .map((m) => m.spec?.nodeName)
    expect(probed).toEqual(['yaac-worker'])
  })

  it('judges runsc per node when only some kubelets publish their runtime handlers', async () => {
    // Mixed kubelet versions: worker publishes its handler list and lacks
    // runsc; worker2 publishes nothing, so its own probe pod — which
    // succeeded — is the authority. Judging worker2 by the field the
    // cluster's other node happens to publish would flag it as broken.
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
    // A node that runs nothing is what the inventory flags — not the count.
    expect(byName(results, 'nodes')).toMatchObject({ status: 'warn' })
    expect(byName(results, 'nodes')?.detail).toContain('NotReady: yaac-worker')
    // Only the node a session could actually land on is probed, and the
    // gates pass on it.
    const probed = vi.mocked(deps.apply).mock.calls
      .map((c) => c[0] as { metadata?: { name?: string }; spec?: { nodeName?: string } })
      .filter((m) => m.metadata?.name?.startsWith('yaac-cluster-check-node-'))
      .map((m) => m.spec?.nodeName)
    expect(probed).toEqual(['yaac-control-plane'])
    expect(byName(results, 'runsc-nodes')).toMatchObject({ status: 'pass' })
    expect(byName(results, 'volume-nodes')?.detail).toContain('all 1 session-eligible nodes')
    // NotReady is a distinct reason from cordoned, and both are named.
    expect(byName(results, 'volume-nodes')?.detail)
      .toContain('not swept: yaac-worker (NotReady), yaac-worker2 (cordoned)')
  })

  it('treats a tainted sessions pool as usable when the RuntimeClass tolerates it', async () => {
    // The pool is tainted so nothing else drifts onto it, and the toleration
    // is declared once on the gvisor RuntimeClass — which admission merges
    // into every pod naming the class, the probe pods included. Under the
    // old "carries no taint at all" rule this cluster read as ZERO nodes a
    // session could use.
    clusterNodes = [
      nodeItem('yaac-control-plane', { tainted: true }),
      nodeItem('yaac-pool-1', { taints: POOL_TAINTS }),
      // A pool node kubelet has just taken out of service. Tolerating the
      // pool taint says nothing about this one, so the node genuinely cannot
      // take a session — and that must stay visible rather than being folded
      // into a pass over "the pool".
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

    // Only the healthy pool node is probed: the pinned probes bypass the
    // scheduler, but kubelet still admits them, so a NoExecute pool taint
    // they did not inherit a toleration for would evict them mid-sweep.
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
    // A sessions pool whose toleration was never declared: every node is
    // tainted and nothing tolerates it. The finding is right — no session can
    // land — but the repair must not be "remove the taint", which dismantles
    // the isolation the pool exists for.
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
    // Both blocking effects named, so the reader can see what to tolerate.
    expect(nodes?.detail).toContain(
      'yaac-pool-1 (untolerated taint yaac.dev/sessions=true:NoSchedule, '
      + 'yaac.dev/sessions=true:NoExecute)',
    )
    expect(nodes?.fix).toContain('scheduling.tolerations')
    expect(nodes?.fix).toContain('rather than removing the taint')

    // The sweep says the same, naming the nodes instead of reporting a
    // vacuous pass over an empty population.
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
    expect(byName(results, 'probe')).toMatchObject({ status: 'skip' })
    expect(byName(results, 'egress')).toMatchObject({ status: 'skip' })
    expect(byName(results, 'datapath')).toMatchObject({ status: 'skip' })
    expect(byName(results, 'nested-mount')).toMatchObject({ status: 'skip' })
    expect(deps.pushImage).not.toHaveBeenCalled()
    // No probe object reached the cluster (the namespace ensure is a
    // sibling and may still have run).
    const appliedKinds = deps.apply.mock.calls.map((c) => (c[0] as { kind: string }).kind)
    expect(appliedKinds).not.toContain('Pod')
  })

  it('warns on node-fixups (pointing at install) when a fixup went missing', async () => {
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'podman' && args[0] === 'exec') {
        // Node restarted: the TasksMax conf is gone and the sysctl is back
        // at its tiny default; a pre-fixup node also lacks the kubelet
        // housekeeping flag.
        // The inotify ceilings are the stock kernel defaults, which is
        // what a multi-node cluster starves netd's Envoy against.
        return {
          stdout: 'tasksmax=missing\nminfree=67584\n'
            + 'inotifyinst=128\ninotifywatch=8192\nhk=missing\n',
          stderr: '',
        }
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
    expect(fixups?.detail).toContain('DefaultTasksMax')
    expect(fixups?.detail).toContain('vm.min_free_kbytes')
    expect(fixups?.detail).toContain('kubelet housekeeping-interval')
    expect(fixups?.detail).toContain('pids-limit')
    expect(fixups?.detail).toContain('fs.inotify.max_user_instances')
    expect(fixups?.detail).toContain('fs.inotify.max_user_watches')
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
    const { results } = await runClusterCheck()
    const fixups = byName(results, 'node-fixups')
    expect(fixups).toMatchObject({ status: 'skip' })
    expect(fixups?.detail).toContain('not a podman container')
  })

  it('fails priority-classes (and skips the probes) when a class is missing', async () => {
    // The failure this names: the apiserver rejects a pod that references a
    // class it does not have, so a session Job applies and then hangs with
    // no pod — with nothing else in the check pointing at the cause.
    const run = happyRun()
    run.mockImplementation((file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'get' && args[1] === 'priorityclass') {
        const items = livePriorityClasses().filter((c) => c.metadata.name !== 'yaac-worktree')
        return Promise.resolve({ stdout: JSON.stringify({ items }), stderr: '' })
      }
      return happyResponses(file, args)
    })
    stage({ run })
    const { ok, results } = await runClusterCheck()
    expect(ok).toBe(false)
    const pcs = byName(results, 'priority-classes')
    expect(pcs).toMatchObject({ status: 'fail' })
    expect(pcs?.detail).toContain('yaac-worktree')
    expect(pcs?.fix).toContain('yaac cluster install')
    expect(byName(results, 'probe')).toMatchObject({ status: 'skip' })
  })

  it('warns (without failing) when an installed PriorityClass has drifted', async () => {
    // A class an older yaac installed with different numbers still lets
    // every pod schedule — it just ranks them wrong, so this is not fatal.
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
    // Warn-only: the rest of the suite still runs.
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
    // A gvisor pod would sit Pending to its timeout — the probes skip.
    expect(byName(results, 'probe')).toMatchObject({ status: 'skip' })
    expect(byName(results, 'egress')).toMatchObject({ status: 'skip' })
  })

  it('fails gvisor when a pod on the gvisor class is not sentry-sandboxed', async () => {
    const run = happyRun()
    run.mockImplementation((file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check-gvisor') {
        // The handler silently ran the pod on runc: the node kernel's
        // ring buffer has no sentry boot messages.
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
              // Unstamped infra is deliberate (runc) — never flagged.
              { metadata: { name: 'yaac-proxy-abc', namespace: 'test-ns' }, spec: {} },
              // A session pod without the gvisor tier is the violation.
              {
                metadata: {
                  name: 'yaac-old-session', namespace: 'test-ns',
                  labels: { 'yaac.worktree-id': 'old' },
                },
                spec: {},
              },
              // Other namespaces are not yaac's to police.
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
        // Policy not enforced: the probe reached the apiserver.
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
        // Blocked from the apiserver, but reached a transparent port directly.
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

  it('passes datapath when calico-node and netd are both rolled out', async () => {
    stage()
    const { results } = await runClusterCheck()
    expect(byName(results, 'datapath')).toMatchObject({
      status: 'pass',
      detail: expect.stringContaining('policy enforced, egress redirected') as string,
    })
  })

  it('fails veth-source when the redirect resolves no workload veth, though netd is Ready', async () => {
    // The gap the datapath gate structurally cannot see: netd's readiness is
    // Envoy's config ack, which goes green with ZERO pod → veth mappings. So
    // a wrong prefix (or a CNI writing no per-workload route) leaves netd
    // Ready with a chain that has no per-pod rules in it, and every session
    // quietly without egress. Re-checked here on every run, not just at
    // --adopt-cni time, because a node pool added later can differ from the
    // one adoption sampled.
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
    // datapath still passes — which is exactly why this is its own gate.
    expect(byName(results, 'datapath')).toMatchObject({ status: 'pass' })
    const veth = byName(results, 'veth-source')
    expect(veth).toMatchObject({ status: 'fail' })
    expect(veth?.detail).toContain('cali*')
    expect(veth?.detail).toMatch(/YAAC_CNI_VETH_PREFIX=eni\b/)
  })

  it('leaves veth-source unverified, not failed, when a netd pod cannot be exec\'d', async () => {
    // "I could not read the routing table" is a different claim from "this
    // node has no workload routes", and only the second is a broken cluster.
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
    // netd's readiness IS Envoy's config ack, so a broken sidecar and a
    // broken netd are indistinguishable from the DaemonSet counters alone.
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

    // One name per fault, however many pods carry it: a 50-node DaemonSet
    // must not print the same crashing sidecar fifty times. Ready and
    // nameless containers are not faults at all.
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

    // A container down with no state at all still gets named.
    expect(await withPods(JSON.stringify({
      items: [{ status: { containerStatuses: [{ name: 'netd', ready: false }] } }],
    }))).toContain('netd: not ready')

    // Unreadable output must not mask the real failure with a crash.
    for (const junk of ['', 'not json', '{}']) {
      const d = await withPods(junk)
      expect(d).toContain('session egress has no redirect')
      expect(d).not.toContain('(')
    }
  })

  it('fails datapath when netd is absent (session egress has no redirect)', async () => {
    // Fail-CLOSED, unlike a missing Calico: sessions lose egress rather
    // than gaining unrestricted egress. The two are reported distinctly
    // because the operator response differs.
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
    // The probe mirrors the nested tier: gvisor-nested, no userns (the sentry
    // is the containment), in-sandbox root with the engine's caps.
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
    // The core sentry prerequisite: in-sandbox root can mount a tmpfs.
    expect(probePod?.spec.containers[0].command.join(' ')).toContain('mount -t tmpfs')
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
    // The check gates on vapAvailable() — the exact probe the builder-pod
    // guard applies — so it is stubbed at the kubectl layer, not deps.run.
    mockRetry.mockRejectedValue(new Error("the server doesn't have a resource type"))
    stage()
    const { ok, results } = await runClusterCheck()
    const vap = byName(results, 'vap')
    expect(vap).toMatchObject({ status: 'fail' })
    expect(vap?.detail).toContain('ValidatingAdmissionPolicy API unavailable')
    expect(vap?.fix).toContain('image builds')
    // Fail, not warn: the guard refuses to apply without the API, so no
    // worktree image can be built at all.
    expect(ok).toBe(false)
  })

  it('fails the registry check with repair instructions when nothing answers', async () => {
    stage({
      registryReachable: false,
    })
    const { ok, results } = await runClusterCheck()
    expect(ok).toBe(false)
    const registry = byName(results, 'registry')
    expect(registry).toMatchObject({ status: 'fail' })
    // The registry is an in-cluster Deployment, so the fix is a repair pass
    // and a look at the workload — never a host container to start by hand.
    expect(registry?.fix).toContain('yaac cluster install')
    expect(registry?.fix).toContain('app=yaac-main-registry')
  })

  it('fails the probe with wiring hints when the pod ends in a non-Succeeded phase', async () => {
    // Only the e2e probe pod fails — the gvisor probe (a different pod
    // name) keeps succeeding so the probe is reached at all.
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

  it('fails the probe when the pod write never reaches the host', async () => {
    const run = happyRun()
    run.mockImplementation(async (file: string, args: string[]) => {
      // Probe logs return the right nonce, but the pod's write marker
      // never appears host-side (uid mismatch / read-only wiring).
      if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check') {
        const nonce = await fs.readFile(path.join(getDataDir(), '.cluster-check-nonce'), 'utf8')
        return { stdout: `${nonce}\n`, stderr: '' }
      }
      return happyResponses(file, args)
    })
    stage({ run })
    const { ok, results } = await runClusterCheck()
    expect(ok).toBe(false)
    const probe = byName(results, 'probe')
    expect(probe).toMatchObject({ status: 'fail' })
    expect(probe?.detail).toContain('did not reach the host')
    expect(probe?.fix).toContain('uid')
  })

  it('fails the probe when the pod reads stale hostPath data', async () => {
    const run = happyRun()
    run.mockImplementation((file: string, args: string[]) => {
      if (file === 'kubectl' && args[0] === 'logs' && args[1] === 'yaac-cluster-check') {
        return Promise.resolve({ stdout: 'some-stale-nonce\n', stderr: '' })
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

describe('formatCheckResult', () => {
  it('renders pass/fail/warn/skip icons with name and detail', () => {
    expect(formatCheckResult({ name: 'kubectl', status: 'pass', detail: 'installed' }))
      .toBe('✓ kubectl: installed')
    expect(formatCheckResult({ name: 'registry', status: 'fail', detail: 'down' }))
      .toBe('✗ registry: down')
    expect(formatCheckResult({ name: 'nodes', status: 'warn', detail: '2 nodes' }))
      .toBe('! nodes: 2 nodes')
    expect(formatCheckResult({ name: 'probe', status: 'skip', detail: 'skipped' }))
      .toBe('- probe: skipped')
  })

  it('appends indented fix lines for failures', () => {
    const rendered = formatCheckResult({
      name: 'registry',
      status: 'fail',
      detail: 'nothing answering',
      fix: 'line one\nline two',
    })
    expect(rendered).toBe(
      '✗ registry: nothing answering\n    fix: line one\n         line two',
    )
  })

  it('renders the fix for warnings too, but never for pass/skip', () => {
    expect(formatCheckResult({ name: 'nodes', status: 'warn', detail: 'x', fix: 'use one node' }))
      .toContain('fix: use one node')
    expect(formatCheckResult({ name: 'ok', status: 'pass', detail: 'x', fix: 'irrelevant' }))
      .toBe('✓ ok: x')
    expect(formatCheckResult({ name: 'probe', status: 'skip', detail: 'x', fix: 'irrelevant' }))
      .toBe('- probe: x')
  })
})
