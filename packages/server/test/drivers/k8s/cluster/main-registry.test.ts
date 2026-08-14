import { describe, it, expect, vi, beforeEach } from 'vitest'

// kubectl is the process boundary. Everything inside features/cluster runs
// for real behind it — including `runPodToCompletion`, which is what drives
// the node-write pods the hosts.toml leg schedules.
vi.mock('#drivers/k8s/substrate/kubectl', () => ({
  isKubectlAbsentError: vi.fn(() => false),
  kubectlErrorSummary: vi.fn((e: unknown) => String(e)),
  k8sNamespace: vi.fn(() => 'test-ns'),
  dataDirHash: vi.fn(() => 'ddh16'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

// The node-CIDR probe the ingress lock is rendered from — a live cluster
// read, so it is stubbed like any other boundary.
vi.mock('#drivers/k8s/cluster/cluster-cidrs', () => ({
  nodeIpBlocks: vi.fn().mockResolvedValue(['10.89.0.7/32']),
}))

// The registry CLIENT is the other boundary: its reachability probe is an
// HTTP call over a kubectl port-forward, neither of which a unit run has.
vi.mock('#drivers/k8s/container/registry', () => ({
  REGISTRY_NAMESPACE: 'yaac',
  REGISTRY_SERVICE_NAME: 'yaac-registry',
  REGISTRY_SERVICE_PORT: 5000,
  registryHost: vi.fn(() => 'yaac-registry.yaac.svc.cluster.local:5000'),
  registryReachable: vi.fn().mockResolvedValue(false),
  invalidateRegistryEndpoint: vi.fn(),
}))

import { ensureMainRegistry, mainRegistryExec, restartMainRegistry } from '#drivers/k8s/cluster'
// Setup values and label keys the assertions speak in, not units under test.
import {
  LABEL_MAIN_REGISTRY_NODE_WRITE,
  MAIN_REGISTRY_APP_LABEL,
  MAIN_REGISTRY_STORAGE_SIZE,
  mainRegistryPvcName,
} from '#drivers/k8s/cluster/main-registry'
import { ROLE_BUILDER } from '#drivers/k8s/substrate/proxy-constants'
import { REGISTRY_UPSTREAM_IMAGE } from '#drivers/k8s/cluster/project-registry'
import { kubectlApply, kubectlGetJson, kubectlWithRetry } from '#drivers/k8s/substrate/kubectl'
import { invalidateRegistryEndpoint, registryReachable } from '#drivers/k8s/container/registry'

const mockApply = vi.mocked(kubectlApply)
const mockGetJson = vi.mocked(kubectlGetJson)
const mockRetry = vi.mocked(kubectlWithRetry)
const mockReachable = vi.mocked(registryReachable)
const mockInvalidate = vi.mocked(invalidateRegistryEndpoint)
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
 * Serve the cluster reads an ensure makes: the live Deployment's storage
 * volume (which the cheap path checks has been converted to the claim), the
 * Service's ClusterIP, the node list the writer pods are pinned to, and the
 * writer pod's own status (which `runPodToCompletion` polls to a terminal
 * phase).
 *
 * `storage` selects which shape the live Deployment has: `'pvc'` is a
 * converged install, `'hostPath'` one upgrading from the node-local store,
 * and `'absent'` a cluster with no registry Deployment at all.
 */
function serveCluster(opts: {
  clusterIp?: string | null
  nodes?: string[]
  podPhase?: string
  storage?: 'pvc' | 'hostPath' | 'absent'
} = {}): void {
  const nodes = opts.nodes ?? ['yaac-control-plane']
  mockGetJson.mockImplementation((args: string[]) => {
    if (args[1] === 'deployment') {
      const storage = opts.storage ?? 'pvc'
      if (storage === 'absent') return Promise.resolve(null)
      return Promise.resolve({
        spec: { template: { spec: { volumes: [
          storage === 'pvc'
            ? { name: 'storage', persistentVolumeClaim: { claimName: 'yaac-registry-storage-ddh16' } }
            : { name: 'storage', hostPath: { path: '/var/lib/yaac/main-registry/ddh16' } },
        ] } } },
      })
    }
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
  mockReachable.mockResolvedValue(false)
  serveCluster()
})

describe('ensureMainRegistry', () => {
  it('is a no-op when the registry already answers from its claim', async () => {
    mockReachable.mockResolvedValue(true)
    await ensureMainRegistry()
    // The boot ensure must cost one ping and one read on a healthy install,
    // not a rollout wait and a node-write pod per node.
    expect(mockApply).not.toHaveBeenCalled()
    expect(mockRetry).not.toHaveBeenCalled()
  })

  it('converts an install still serving from the node hostPath', async () => {
    // The upgrade is invisible to a reachability check — the OLD registry
    // answers perfectly well — so the cheap path reads the live Deployment's
    // storage volume too. Without this the install would stay on its
    // hostPath forever, serving a store nothing else would ever convert.
    mockReachable.mockResolvedValue(true)
    serveCluster({ storage: 'hostPath' })
    await ensureMainRegistry()

    const deploy = appliedOfKind('Deployment')
    const volumes = (deploy.spec as {
      template: { spec: { volumes: Array<{ persistentVolumeClaim?: { claimName: string } }> } }
    }).template.spec.volumes
    expect(volumes[0].persistentVolumeClaim).toEqual({ claimName: mainRegistryPvcName() })
  })

  it('stands the registry up when there is no Deployment to read', async () => {
    // The check fails SAFE: an absent or unreadable Deployment answers "not
    // converged", which costs a redundant apply rather than a skipped one.
    mockReachable.mockResolvedValue(true)
    serveCluster({ storage: 'absent' })
    await ensureMainRegistry()
    expect(applied().map((m) => m.kind)).toContain('PersistentVolumeClaim')
  })

  it('applies namespace, PVC, Deployment and Service, then wires every node up', async () => {
    mockReachable.mockResolvedValueOnce(false).mockResolvedValue(true)
    await ensureMainRegistry()

    // The claim precedes the Deployment that mounts it, so the rollout wait
    // never spends its budget on a pod Pending for a volume that does not
    // exist yet.
    expect(applied().map((m) => m.kind)).toEqual([
      'Namespace', 'PersistentVolumeClaim', 'Deployment', 'Service', 'NetworkPolicy', 'Pod',
    ])

    // The namespace carries the privileged Pod Security Standard: it also
    // holds the node-write pods that hostPath-mount a node's certs.d, which
    // an adopted cluster's baseline/restricted default would reject.
    expect(appliedOfKind('Namespace').metadata.labels)
      .toMatchObject({ 'pod-security.kubernetes.io/enforce': 'privileged' })

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
          volumes: Array<{ persistentVolumeClaim?: { claimName: string } }>
          affinity?: unknown
          nodeSelector?: unknown
        }
      }
    }
    // Recreate: a rolling overlap would put two pods on one store, and on a
    // backend enforcing RWO across nodes it would deadlock on the volume.
    expect(spec.strategy.type).toBe('Recreate')
    // The registry cannot be the source of its OWN image, so this one pod
    // names the digest-pinned upstream rather than the local mirror tag.
    expect(spec.template.spec.containers[0].image).toBe(REGISTRY_UPSTREAM_IMAGE)
    expect(spec.template.spec.containers[0].imagePullPolicy).toBe('IfNotPresent')
    // Trusted infra: runs on runc, above sessions.
    expect(spec.template.spec.runtimeClassName).toBeUndefined()
    expect(spec.template.spec.priorityClassName).toBe('yaac-infra')

    // The store belongs to the CLAIM, not to a node — which is what makes
    // the unpinned Deployment safe: a reschedule takes the volume with it,
    // so nothing is stranded and nothing swaps underneath a collect. The
    // absent pin is half the fix, so it is asserted, not assumed.
    expect(spec.template.spec.volumes[0].persistentVolumeClaim)
      .toEqual({ claimName: mainRegistryPvcName() })
    expect(spec.template.spec.affinity).toBeUndefined()
    expect(spec.template.spec.nodeSelector).toBeUndefined()

    const pvc = appliedOfKind('PersistentVolumeClaim')
    expect(pvc.metadata).toMatchObject({ name: mainRegistryPvcName(), namespace: 'yaac' })
    // Install-keyed, exactly as the retired hostPath was: coexisting
    // installs must never end up sharing one blob store.
    expect(pvc.metadata.name).toContain('ddh16')
    expect(pvc.spec).toEqual({
      // RWO, not RWX: one mounter at a time is guaranteed by replicas 1 +
      // Recreate, and RWX needs a file class most backends do not ship.
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: MAIN_REGISTRY_STORAGE_SIZE } },
    })
    // No storageClassName: it must bind through whatever the cluster's
    // default class is (kind's `standard`, a provider's block class, the
    // provider's default block class). Naming one would break
    // every cluster that does not ship it.
    expect(pvc.spec).not.toHaveProperty('storageClassName')

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

  it('annotates a rollout failure with the command that diagnoses it', async () => {
    mockRetry.mockImplementation((args: string[]) => (
      args[0] === 'rollout' && args[1] === 'status'
        ? Promise.reject(new Error('timed out waiting for the condition'))
        : Promise.resolve({ stdout: '', stderr: '' })
    ))
    // Pending vs ImagePullBackOff vs an unbindable claim is the whole
    // diagnosis, and kubectl's timeout text says none of them. The claim
    // matters most on a cluster with no DEFAULT StorageClass, where it
    // presents as a Pending pod with no scheduling reason of its own.
    await expect(ensureMainRegistry()).rejects.toThrow(/kubectl -n yaac get pods,pvc/)
    await expect(ensureMainRegistry()).rejects.toThrow(/no default StorageClass/)
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
