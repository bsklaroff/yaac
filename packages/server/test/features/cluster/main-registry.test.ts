import { describe, it, expect, vi, beforeEach } from 'vitest'

// kubectl is the process boundary. Everything inside features/cluster runs
// for real behind it — including `runPodToCompletion`, which is what drives
// the node-write pods the hosts.toml leg schedules.
vi.mock('#platform/k8s/kubectl', () => ({
  k8sNamespace: vi.fn(() => 'test-ns'),
  dataDirHash: vi.fn(() => 'ddh16'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  execFileAsync: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

// The node-CIDR probe the ingress lock is rendered from — a live cluster
// read, so it is stubbed like any other boundary.
vi.mock('#features/cluster/cluster-cidrs', () => ({
  nodeIpBlocks: vi.fn().mockResolvedValue(['10.89.0.7/32']),
}))

// The registry CLIENT is the other boundary: its reachability probe is an
// HTTP call over a kubectl port-forward, neither of which a unit run has.
vi.mock('#platform/container/registry', () => ({
  REGISTRY_NAMESPACE: 'yaac',
  REGISTRY_SERVICE_NAME: 'yaac-registry',
  REGISTRY_SERVICE_PORT: 5000,
  registryHost: vi.fn(() => 'yaac-registry.yaac.svc.cluster.local:5000'),
  registryReachable: vi.fn().mockResolvedValue(false),
  invalidateRegistryEndpoint: vi.fn(),
}))

import { ensureMainRegistry, mainRegistryExec, restartMainRegistry } from '#features/cluster'
// Setup values and label keys the assertions speak in, not units under test.
import {
  LABEL_MAIN_REGISTRY_NODE_WRITE,
  MAIN_REGISTRY_APP_LABEL,
  mainRegistryStorageHostPath,
} from '#features/cluster/main-registry'
import { ROLE_BUILDER } from '#platform/k8s/proxy-constants'
import { REGISTRY_UPSTREAM_IMAGE } from '#features/cluster/project-registry'
import { execFileAsync, kubectlApply, kubectlGetJson, kubectlWithRetry } from '#platform/k8s/kubectl'
import { invalidateRegistryEndpoint, registryReachable } from '#platform/container/registry'

const mockApply = vi.mocked(kubectlApply)
const mockGetJson = vi.mocked(kubectlGetJson)
const mockRetry = vi.mocked(kubectlWithRetry)
const mockReachable = vi.mocked(registryReachable)
const mockInvalidate = vi.mocked(invalidateRegistryEndpoint)
const mockExec = vi.mocked(execFileAsync)

/** The one host-command boundary an ensure crosses: the legacy-container rm. */
function podmanArgs(): string[][] {
  return mockExec.mock.calls.filter((c) => c[0] === 'podman').map((c) => c[1] as string[])
}

const CLUSTER_IP = '10.96.12.34'

interface Manifest {
  kind: string
  metadata: { name: string; namespace: string; labels?: Record<string, string> }
  spec: Record<string, unknown>
}

function applied(): Manifest[] {
  return mockApply.mock.calls.map((c) => c[0] as unknown as Manifest)
}

function appliedOfKind(kind: string): Manifest {
  const found = applied().find((m) => m.kind === kind)
  if (!found) throw new Error(`no ${kind} applied (got ${applied().map((m) => m.kind).join(', ')})`)
  return found
}

function retryArgs(): string[][] {
  return mockRetry.mock.calls.map((c) => c[0])
}

/**
 * Serve the cluster reads an ensure makes: the Service's ClusterIP, the
 * node list the writer pods are pinned to, and the writer pod's own status
 * (which `runPodToCompletion` polls to a terminal phase).
 */
function serveCluster(opts: { clusterIp?: string | null; nodes?: string[]; podPhase?: string } = {}): void {
  const nodes = opts.nodes ?? ['yaac-control-plane']
  mockGetJson.mockImplementation((args: string[]) => {
    if (args[1] === 'service') {
      const ip = opts.clusterIp === undefined ? CLUSTER_IP : opts.clusterIp
      return Promise.resolve(ip === null ? { spec: {} } : { spec: { clusterIP: ip } })
    }
    if (args[1] === 'nodes') {
      return Promise.resolve({ items: nodes.map((name) => ({ metadata: { name } })) })
    }
    // pod status poll
    return Promise.resolve({ status: { phase: opts.podPhase ?? 'Succeeded' } })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRetry.mockResolvedValue({ stdout: '', stderr: '' })
  mockExec.mockResolvedValue({ stdout: '', stderr: '' })
  mockReachable.mockResolvedValue(false)
  serveCluster()
})

describe('ensureMainRegistry', () => {
  it('is a no-op when the registry already answers', async () => {
    mockReachable.mockResolvedValue(true)
    await ensureMainRegistry()
    // The boot ensure must cost one ping on a healthy install, not a
    // rollout wait and a node-write pod per node.
    expect(mockApply).not.toHaveBeenCalled()
    expect(mockRetry).not.toHaveBeenCalled()
  })

  it('applies namespace, Deployment and Service, then wires every node up', async () => {
    mockReachable.mockResolvedValueOnce(false).mockResolvedValue(true)
    await ensureMainRegistry()

    expect(applied().map((m) => m.kind)).toEqual([
      'Namespace', 'Deployment', 'Service', 'NetworkPolicy', 'Pod',
    ])

    // Everything lands in the DEFAULT namespace, not k8sNamespace() (mocked
    // to test-ns here): per-run e2e namespaces share one image store.
    const deploy = appliedOfKind('Deployment')
    expect(deploy.metadata).toMatchObject({ name: 'yaac-registry', namespace: 'yaac' })
    expect(deploy.metadata.labels?.app).toBe(MAIN_REGISTRY_APP_LABEL)
    const spec = deploy.spec as {
      strategy: { type: string }
      template: {
        spec: {
          runtimeClassName?: string
          priorityClassName: string
          containers: Array<{ image: string; imagePullPolicy: string; readinessProbe: unknown }>
          volumes: Array<{ hostPath: { path: string } }>
        }
      }
    }
    // Recreate: two pods would race over the node-local storage hostPath.
    expect(spec.strategy.type).toBe('Recreate')
    // The registry cannot be the source of its OWN image, so this one pod
    // names the digest-pinned upstream rather than the local mirror tag.
    expect(spec.template.spec.containers[0].image).toBe(REGISTRY_UPSTREAM_IMAGE)
    expect(spec.template.spec.containers[0].imagePullPolicy).toBe('IfNotPresent')
    // Trusted infra: runs on runc, above sessions.
    expect(spec.template.spec.runtimeClassName).toBeUndefined()
    expect(spec.template.spec.priorityClassName).toBe('yaac-infra')
    expect(spec.template.spec.volumes[0].hostPath.path).toBe(mainRegistryStorageHostPath())

    // A NORMAL selector-backed Service — no hand-written EndpointSlice, no
    // host-side address discovery.
    const svc = appliedOfKind('Service')
    expect(svc.metadata).toMatchObject({ name: 'yaac-registry', namespace: 'yaac' })
    expect(svc.spec).toMatchObject({
      type: 'ClusterIP',
      selector: { app: MAIN_REGISTRY_APP_LABEL },
      ports: [{ name: 'registry', port: 5000, targetPort: 5000, protocol: 'TCP' }],
    })

    // Rolled out before the node write, which is also what guarantees the
    // writer pod's image is already on the node.
    const rollout = retryArgs().find((a) => a[0] === 'rollout')
    expect(rollout).toEqual(expect.arrayContaining([
      'rollout', 'status', 'deployment/yaac-registry', '-n', 'yaac',
    ]))

    // The node is not a cluster-DNS client, so its containerd hosts.toml
    // maps the svc FQDN to the live ClusterIP.
    const writer = appliedOfKind('Pod')
    const podSpec = writer.spec as {
      nodeName: string
      tolerations: Array<{ operator: string }>
      containers: Array<{ image: string; command: string[] }>
      volumes: Array<{ hostPath: { path: string } }>
    }
    expect(writer.metadata.labels?.[LABEL_MAIN_REGISTRY_NODE_WRITE]).toBe('hosts')
    expect(podSpec.nodeName).toBe('yaac-control-plane')
    // Tolerates everything: nodeName bypasses the scheduler, but kubelet
    // still admits and the taint manager still evicts, so a NoExecute taint
    // (a dedicated sessions pool's) would deny this write to the very nodes
    // that need it — leaving them unable to pull.
    expect(podSpec.tolerations).toEqual([{ operator: 'Exists' }])
    expect(podSpec.containers[0].image).toBe(REGISTRY_UPSTREAM_IMAGE)
    expect(podSpec.containers[0].command[2])
      .toContain(`[host."http://${CLUSTER_IP}:5000"]`)
    expect(podSpec.volumes[0].hostPath.path)
      .toBe('/etc/containerd/certs.d/yaac-registry.yaac.svc.cluster.local:5000')

    // The port-forward this process holds may predate the pod that just
    // rolled out, so it is dropped before the reachability wait.
    expect(mockInvalidate).toHaveBeenCalled()
  })

  it('locks registry ingress to the node and to builder pods in any namespace', async () => {
    mockReachable.mockResolvedValueOnce(false).mockResolvedValue(true)
    await ensureMainRegistry()

    const np = appliedOfKind('NetworkPolicy')
    expect(np.metadata).toMatchObject({ name: 'yaac-registry-ingress', namespace: 'yaac' })
    expect(np.spec).toMatchObject({
      podSelector: { matchLabels: { app: MAIN_REGISTRY_APP_LABEL } },
      policyTypes: ['Ingress'],
    })
    const rules = (np.spec as { ingress: Array<{ from: unknown[]; ports: unknown[] }> }).ingress
    // The node half is an ipBlock because containerd pulls, the kubelet
    // probe and the server's port-forward all arrive from the host netns,
    // which plain NetworkPolicy cannot name any other way.
    expect(rules[0].from).toEqual([{ ipBlock: { cidr: '10.89.0.7/32' } }])
    // Builder pods live in per-run namespaces during e2e, so a bare
    // podSelector (this namespace only) would lock them out.
    expect(rules[1].from).toEqual([{
      namespaceSelector: {},
      podSelector: { matchLabels: { 'yaac.role': ROLE_BUILDER } },
    }])
    for (const r of rules) expect(r.ports).toEqual([{ protocol: 'TCP', port: 5000 }])
  })

  it('drops the pre-in-cluster EndpointSlice before applying the Service', async () => {
    mockReachable.mockResolvedValueOnce(false).mockResolvedValue(true)
    await ensureMainRegistry()

    // The old selectorless Service's hand-written slice carries this
    // Service's service-name label and no managed-by, so it survives the
    // apply — and kube-proxy unions every slice, which would load-balance
    // the ClusterIP onto the dead podman container's address.
    const del = retryArgs().find((a) => a[0] === 'delete' && a[1] === 'endpointslice')
    expect(del).toEqual([
      'delete', 'endpointslice', 'yaac-registry-1', '-n', 'yaac', '--ignore-not-found',
    ])
  })

  it('retires the legacy host podman registry container', async () => {
    mockReachable.mockResolvedValueOnce(false).mockResolvedValue(true)
    await ensureMainRegistry()

    // The container the in-cluster registry replaces. Nothing names it any
    // more and `cluster delete` no longer removes it, so the ensure that
    // stands up its replacement is the one chance to retire it — and
    // `--ignore` is what makes that a no-op on a fresh install.
    expect(podmanArgs()).toEqual([['rm', '-f', '--ignore', 'yaac-registry']])
  })

  it('still comes up when the legacy container cannot be removed', async () => {
    mockReachable.mockResolvedValueOnce(false).mockResolvedValue(true)
    // The rm is the only host command an ensure runs, so a blanket
    // rejection is exactly "podman failed" and nothing else.
    mockExec.mockRejectedValue(new Error('podman: command not found'))
    // A leftover container is cosmetic; the registry it shadows is already
    // rolled out and reachable by this point, so failing here would break a
    // working install over garbage collection.
    await expect(ensureMainRegistry()).resolves.toBeUndefined()
  })

  it('annotates a rollout failure with the command that diagnoses it', async () => {
    mockRetry.mockImplementation((args: string[]) => (
      args[0] === 'rollout' && args[1] === 'status'
        ? Promise.reject(new Error('timed out waiting for the condition'))
        : Promise.resolve({ stdout: '', stderr: '' })
    ))
    // Pending vs ImagePullBackOff is the whole diagnosis, and kubectl's
    // timeout text says neither.
    await expect(ensureMainRegistry()).rejects.toThrow(/kubectl -n yaac get pods/)
  })

  it('writes one hosts.toml pod per node, reaping strays first', async () => {
    mockReachable.mockResolvedValueOnce(false).mockResolvedValue(true)
    serveCluster({ nodes: ['node-a', 'node-b'] })
    await ensureMainRegistry()

    const writers = applied().filter((m) => m.kind === 'Pod')
    expect(writers.map((p) => (p.spec as { nodeName: string }).nodeName)).toEqual(['node-a', 'node-b'])
    // Per-run name suffixes mean no later namesake delete collects a pod a
    // crashed run left behind — hence the label sweep, which the node-write
    // marker keeps off the registry Deployment's own pod.
    const sweep = retryArgs().find((a) => a[0] === 'delete' && a[1] === 'pod')
    expect(sweep?.join(' ')).toContain(
      `app=${MAIN_REGISTRY_APP_LABEL},${LABEL_MAIN_REGISTRY_NODE_WRITE}`,
    )
  })

  it('applies everything again under `force`, even when the registry answers', async () => {
    mockReachable.mockResolvedValue(true)
    await ensureMainRegistry({ force: true })
    // `yaac cluster setup --repair` exists to re-write wiring a node
    // restart may have dropped, so it must not short-circuit.
    expect(applied().map((m) => m.kind)).toContain('Deployment')
    expect(applied().map((m) => m.kind)).toContain('Pod')
  })

  it('refuses to create anything when the registry is externally managed', async () => {
    // The guard is YAAC_K8S_REGISTRY, not YAAC_NESTED: installing here
    // would write a node hosts.toml under the EXTERNAL host's certs.d dir
    // and hijack node-side resolution of someone else's registry.
    vi.stubEnv('YAAC_K8S_REGISTRY', 'someone-elses-registry:5000')
    try {
      await expect(ensureMainRegistry()).rejects.toThrow(/externally managed/)
      expect(mockApply).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('names nesting in the message when that is why the registry is external', async () => {
    vi.stubEnv('YAAC_K8S_REGISTRY', 'yaac-reg-proj.yaac.svc.cluster.local:5000')
    vi.stubEnv('YAAC_NESTED', '1')
    try {
      await expect(ensureMainRegistry()).rejects.toThrow(/outer per-project registry/)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('fails when the Service has no ClusterIP to point the node at', async () => {
    serveCluster({ clusterIp: null })
    await expect(ensureMainRegistry()).rejects.toThrow(/no ClusterIP/)
  })

  it('fails when a hosts.toml pod does not complete', async () => {
    serveCluster({ podPhase: 'Failed' })
    await expect(ensureMainRegistry()).rejects.toThrow(/did not complete \(phase Failed\)/)
  })

  it('fails when the registry never becomes reachable from the server', async () => {
    mockReachable.mockResolvedValue(false)
    await expect(ensureMainRegistry()).rejects.toThrow(/did not become reachable/)
  }, 30_000)
})

describe('mainRegistryExec', () => {
  it('execs into the registry Deployment and returns stdout', async () => {
    mockRetry.mockResolvedValue({ stdout: 'BUSY\n', stderr: '' })
    await expect(mainRegistryExec(['sh', '-c', 'find /x'], 5_000)).resolves.toBe('BUSY\n')
    // `deploy/<name>` lets kubectl resolve the pod, so nothing tracks pod
    // names; no retries, because the collect must not run twice.
    expect(mockRetry).toHaveBeenCalledWith(
      ['exec', '-n', 'yaac', 'deploy/yaac-registry', '--', 'sh', '-c', 'find /x'],
      { timeout: 5_000, maxAttempts: 1 },
    )
  })
})

describe('restartMainRegistry', () => {
  it('rolls the Deployment, waits for it, and drops the stale port-forward', async () => {
    await restartMainRegistry()
    expect(retryArgs()[0]).toEqual([
      'rollout', 'restart', 'deployment/yaac-registry', '-n', 'yaac',
    ])
    expect(retryArgs()[1]).toEqual(expect.arrayContaining(['rollout', 'status']))
    // The forward was bound to the pod that just went away.
    expect(mockInvalidate).toHaveBeenCalledOnce()
  })
})
