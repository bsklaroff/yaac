import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/** Real `sh -n` syntax check (the kubectl execFileAsync here is a mock). */
const runSh = promisify(execFile)

vi.mock('#platform/k8s/kubectl', () => ({
  isKubectlAbsentError: vi.fn(() => false),
  kubectlErrorSummary: vi.fn((e: unknown) => String(e)),
  k8sNamespace: vi.fn(() => 'test-ns'),
  dataDirHash: vi.fn(() => 'ddh16'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  execFileAsync: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

vi.mock('#platform/container/registry', () => ({
  registryHasTag: vi.fn().mockResolvedValue(false),
  registryRef: vi.fn((tag: string) => `localhost:5001/${tag}`),
  pushImageToRegistry: vi.fn((tag: string) => Promise.resolve(`localhost:5001/${tag}`)),
}))

vi.mock('#platform/container/runtime', () => ({
  imageExists: vi.fn().mockResolvedValue(false),
}))

import {
  ensureProjectRegistry,
  gcOrphanProjectRegistries,
  projectRegistryConfDropIn,
  projectRegistryHost,
  reconcileProjectRegistryGc,
  removeProjectRegistry,
} from '#features/cluster'
// Setup values: label keys, the pinned upstream digest, and the name/path
// derivations the assertions below compare against.
import {
  LABEL_NODE_WRITE,
  LABEL_REGISTRY_DATA_DIR_HASH,
  PROJECT_REGISTRY_PORT,
  PROJECT_REGISTRY_STORAGE_SIZE,
  REGISTRY_APP_LABEL,
  REGISTRY_IMAGE_DIGEST,
  REGISTRY_MIRROR_TAG,
  REGISTRY_UPSTREAM_IMAGE,
  REGISTRY_GC_INTERVAL_MS,
  REGISTRY_GENERATIONS_KEPT,
  _registryGcSettledForTests,
  _resetRegistryGcForTests,
  projectRegistryName,
  projectRegistryPvcName,
} from '#features/cluster/project-registry'
import { resetClusterCidrCache } from '#features/cluster/cluster-cidrs'
import {
  execFileAsync,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from '#platform/k8s/kubectl'
import { pushImageToRegistry, registryHasTag } from '#platform/container/registry'
import { imageExists } from '#platform/container/runtime'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

const mockApply = vi.mocked(kubectlApply)
const mockGetJson = vi.mocked(kubectlGetJson)
const mockRetry = vi.mocked(kubectlWithRetry)
const mockExec = vi.mocked(execFileAsync)
const mockHasTag = vi.mocked(registryHasTag)
const mockPush = vi.mocked(pushImageToRegistry)
const mockImageExists = vi.mocked(imageExists)

const NODE_IP = '10.89.0.7'
// Carries both what project-registry reads (the node name, to pin the writer
// pod) and what the real cluster-cidrs probe reads (the InternalIP the
// ingress policy admits containerd pulls from).
const NODE_LIST = {
  items: [{
    metadata: { name: 'yaac-control-plane' },
    status: {
      addresses: [{ type: 'InternalIP', address: NODE_IP }],
      // Ready, so it is a candidate for the registry's node pin as well as
      // a source of the ingress policy's ipBlocks.
      conditions: [{ type: 'Ready', status: 'True' }],
    },
  }],
}

beforeEach(() => {
  mockApply.mockReset()
  mockApply.mockResolvedValue(undefined)
  mockGetJson.mockReset()
  mockRetry.mockReset()
  mockRetry.mockResolvedValue({ stdout: '', stderr: '' })
  mockExec.mockReset()
  mockExec.mockResolvedValue({ stdout: '', stderr: '' })
  mockHasTag.mockReset()
  mockHasTag.mockResolvedValue(false)
  mockPush.mockReset()
  mockPush.mockImplementation((tag: string) => Promise.resolve(`localhost:5001/${tag}`))
  mockImageExists.mockReset()
  mockImageExists.mockResolvedValue(false)
})

const appliedAllKind = (kind: string): unknown[] =>
  mockApply.mock.calls.map((c) => c[0] as { kind: string }).filter((m) => m.kind === kind)
const appliedKind = (kind: string): unknown => appliedAllKind(kind)[0]

/**
 * A live cluster for an ensure: the Service has its allocator-assigned
 * ClusterIP, one node answers (which is also what the real cluster-cidrs
 * probe reads for the ingress policy), and the writer pod completed.
 */
function stageLiveCluster(): void {
  resetClusterCidrCache()
  mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
    if (args[1] === 'service') return Promise.resolve({ spec: { clusterIP: '10.96.0.50' } })
    if (args[1] === 'pod') return Promise.resolve({ status: { phase: 'Succeeded' } })
    return cidrRead(args) ?? Promise.resolve(null)
  })
}

/**
 * The node read cluster-cidrs resolves the ingress policy's ipBlocks from.
 * Every staged read defers to it so the real probe answers rather than a
 * stubbed sibling.
 */
function cidrRead(args: string[]): Promise<unknown> | null {
  return args[1] === 'nodes' ? Promise.resolve(NODE_LIST) : null
}

describe('projectRegistryHost', () => {
  it('is the registry svc-DNS FQDN with its port, deterministic per slug', () => {
    // FQDN, not the `.svc` shorthand: the proxy forwards only `.cluster.local`.
    expect(projectRegistryHost('demo'))
      .toMatch(/^yaac-reg-demo-[0-9a-f]{8}\.test-ns\.svc\.cluster\.local:5000$/)
    expect(projectRegistryHost('demo')).toBe(projectRegistryHost('demo'))
  })

  it('truncates long slugs but keeps them distinct via the full-slug hash', () => {
    const a = projectRegistryHost('a'.repeat(30) + '-one')
    const b = projectRegistryHost('a'.repeat(30) + '-two')
    expect(a).not.toBe(b)
    // DNS-label cap: prefix(9) + slug(<=21) + dash(1) + hash(8) <= 39.
    expect(a.split('.')[0].length).toBeLessThanOrEqual(39)
  })

  it('sanitizes slugs into DNS-safe names', () => {
    expect(projectRegistryHost('My_Project!')).toMatch(/^yaac-reg-my-project-[0-9a-f]{8}\./)
  })
})

describe('projectRegistryConfDropIn', () => {
  it('renders an insecure drop-in scoped to the exact registry host', () => {
    // Scoped to the one host: a blanket `insecure = true` would apply to
    // every registry the in-pod engine talks to.
    expect(projectRegistryConfDropIn('demo')).toBe([
      '[[registry]]',
      `location = "${projectRegistryHost('demo')}"`,
      'insecure = true',
      '',
    ].join('\n'))
  })
})

describe('ensureProjectRegistry', () => {
  beforeEach(() => {
    mockHasTag.mockResolvedValue(true)
    stageLiveCluster()
  })

  it('applies PVC, Deployment, Service, and all network policies, then waits and runs the hosts-writer pod', async () => {
    await ensureProjectRegistry('demo')

    const kinds = mockApply.mock.calls.map((c) => (c[0] as { kind: string }).kind)
    // The claim first: the Deployment's pod must not spend the rollout wait
    // Pending on a volume that does not exist yet.
    expect(kinds).toEqual([
      'PersistentVolumeClaim', 'Deployment', 'Service',
      'NetworkPolicy', 'NetworkPolicy', 'NetworkPolicy', 'Pod',
    ])
    expect(mockRetry).toHaveBeenCalledWith(
      [
        'rollout', 'status', `deployment/${projectRegistryName('demo')}`,
        '-n', 'test-ns', '--timeout=120s',
      ],
      expect.objectContaining({ maxAttempts: 2 }),
    )
    // hosts.toml written by an in-cluster one-shot pod pinned to the node,
    // NOT podman exec — the server's engine need not host the node.
    const pod = mockApply.mock.calls
      .map((c) => c[0] as { kind: string; spec: { nodeName: string; containers: Array<{ command: string[] }> } })
      .find((m) => m.kind === 'Pod')!
    expect(pod.spec.nodeName).toBe('yaac-control-plane')
    // Tolerates everything: nodeName bypasses the scheduler, but kubelet
    // still admits and the taint manager still evicts, so a NoExecute taint
    // (a dedicated sessions pool's) would deny this write to the very nodes
    // that need it — and a node with no hosts.toml cannot pull.
    expect((pod.spec as unknown as { tolerations: unknown }).tolerations)
      .toEqual([{ operator: 'Exists' }])
    const script = pod.spec.containers[0].command[2]
    expect(script).toContain(`http://10.96.0.50:${PROJECT_REGISTRY_PORT}`)
    expect(mockExec).not.toHaveBeenCalled()
    // Stray node-write pods from crashed runs are swept by label first —
    // scoped by the marker label so the registry Deployment's pod (same
    // registry labels) is out of reach.
    expect(mockRetry).toHaveBeenCalledWith([
      'delete', 'pod',
      '-l', `app=${REGISTRY_APP_LABEL},yaac.project=demo,${LABEL_REGISTRY_DATA_DIR_HASH}=ddh16,${LABEL_NODE_WRITE}`,
      '-n', 'test-ns', '--ignore-not-found',
    ])
    // The writer pod (per-run unique name) is pre-cleaned and deleted
    // after completion.
    const namedPodDeletes = mockRetry.mock.calls
      .map((c) => c[0])
      .filter((a) => a[0] === 'delete' && a[1] === 'pod' && a[2] !== '-l')
    expect(namedPodDeletes).toHaveLength(2)
    for (const args of namedPodDeletes) {
      expect(args[2]).toMatch(
        new RegExp(`^${projectRegistryName('demo')}-hosts-0-[0-9a-f]{8}$`))
    }
    // The ClusterIP is allocator-assigned and never deleted — no migration.
    expect(mockRetry).not.toHaveBeenCalledWith(expect.arrayContaining(['delete', 'service']))
  })

  it('leaves placement to the bound volume rather than pinning the Deployment', async () => {
    // The store belongs to the CLAIM, so the registry follows its blobs
    // wherever it is scheduled: nothing here names a node, and nothing has
    // to. A bound volume carries its own node affinity, which the scheduler
    // enforces — a hand-written pin would only add a way to contradict it,
    // and would trade a self-healing degradation for a single point of
    // failure on exactly the store a node replacement destroys.
    await ensureProjectRegistry('demo')

    const deploy = mockApply.mock.calls
      .map((c) => c[0] as {
        kind: string
        metadata: { annotations?: unknown }
        spec: { template: { spec: {
          affinity?: unknown
          nodeName?: unknown
          nodeSelector?: unknown
          tolerations?: unknown
          volumes: Array<{ persistentVolumeClaim?: { claimName: string } }>
        } } }
      })
      .find((m) => m.kind === 'Deployment')!
    expect(deploy.metadata.annotations).toBeUndefined()
    expect(deploy.spec.template.spec.affinity).toBeUndefined()
    expect(deploy.spec.template.spec.nodeName).toBeUndefined()
    expect(deploy.spec.template.spec.nodeSelector).toBeUndefined()
    expect(deploy.spec.template.spec.volumes[0].persistentVolumeClaim)
      .toEqual({ claimName: projectRegistryPvcName('demo') })

    // Declaring NO tolerations is what keeps a project registry off a
    // tainted sessions pool, and it is now the only thing that does: the
    // node-resolver this replaced used to hand-compute the same exclusion by
    // matching each node's taints against an empty toleration set. The
    // scheduler does that matching natively for an unpinned pod, and the
    // pool's toleration lives on the gvisor RuntimeClass, which this
    // trusted-infra pod deliberately does not name. Under
    // WaitForFirstConsumer the volume then follows that choice, so the
    // exclusion holds for the store's life, not just its first placement.
    expect(deploy.spec.template.spec.tolerations).toBeUndefined()

    const pvc = appliedKind('PersistentVolumeClaim') as {
      metadata: { name: string; namespace: string; labels: Record<string, string> }
      spec: Record<string, unknown>
    }
    expect(pvc.metadata.name).toBe(projectRegistryPvcName('demo'))
    expect(pvc.metadata.namespace).toBe('test-ns')
    // Carries the registry labels, which is what puts it inside
    // removeProjectRegistry's by-selector delete — the PVC IS the storage
    // reclaim now, so a claim outside that selector would leak the blobs.
    expect(pvc.metadata.labels).toMatchObject({
      app: REGISTRY_APP_LABEL, 'yaac.project': 'demo',
    })
    expect(pvc.spec).toEqual({
      // RWO, not RWX: replicas 1 + Recreate gives one mounter at a time by
      // construction, and RWO still admits the collect pod beside the
      // registry on the same node.
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: PROJECT_REGISTRY_STORAGE_SIZE } },
    })
    // Binds through the cluster's DEFAULT class — naming one would break
    // every cluster that does not ship it.
    expect(pvc.spec).not.toHaveProperty('storageClassName')
  })

  it('serializes concurrent ensures for one project', async () => {
    let releaseRollout!: () => void
    const gate = new Promise<void>((r) => { releaseRollout = r })
    let rollouts = 0
    mockRetry.mockImplementation((args: string[]) => {
      if (args[0] === 'rollout' && ++rollouts === 1) {
        return gate.then(() => ({ stdout: '', stderr: '' }))
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    })

    const first = ensureProjectRegistry('demo')
    const second = ensureProjectRegistry('demo')
    await new Promise((r) => setTimeout(r, 10))
    // The second ensure has not started while the first waits on its
    // rollout: only the first's six object applies have happened (its
    // writer pod comes after the rollout).
    expect(mockApply).toHaveBeenCalledTimes(6)

    releaseRollout()
    await Promise.all([first, second])
    expect(mockApply).toHaveBeenCalledTimes(14)
  })

  it('surfaces a failed writer pod with its logs (session create must not proceed)', async () => {
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      const cidr = cidrRead(args)
      if (cidr) return cidr
      if (args[1] === 'service') return Promise.resolve({ spec: { clusterIP: '10.96.0.50' } })
      if (args[1] === 'nodes') return Promise.resolve(NODE_LIST)
      if (args[1] === 'pod') return Promise.resolve({ status: { phase: 'Failed' } })
      return Promise.resolve(null)
    })
    mockRetry.mockImplementation((args: string[]) =>
      Promise.resolve({ stdout: args[0] === 'logs' ? 'read-only file system\n' : '', stderr: '' }))

    await expect(ensureProjectRegistry('demo'))
      .rejects.toThrow(/did not complete \(phase Failed\); logs: read-only file system/)
  })

  it('runs the registry as untrusted-free infra off its own claim', async () => {
    await ensureProjectRegistry('demo')

    const dep = appliedKind('Deployment') as {
      metadata: { name: string; namespace: string; labels: Record<string, string> }
      spec: {
        replicas: number
        strategy: unknown
        selector: { matchLabels: Record<string, string> }
        template: { spec: {
          automountServiceAccountToken: boolean
          enableServiceLinks: boolean
          runtimeClassName?: string
          priorityClassName?: string
          hostUsers?: boolean
          securityContext?: unknown
          volumes: Array<Record<string, unknown>>
          containers: Array<{
            image: string
            ports: Array<Record<string, unknown>>
            readinessProbe: { httpGet: unknown }
            volumeMounts: Array<Record<string, unknown>>
          }>
        } }
      }
    }
    expect(dep.metadata.name).toBe(projectRegistryName('demo'))
    expect(dep.metadata.namespace).toBe('test-ns')
    expect(dep.spec.replicas).toBe(1)
    // Recreate, not RollingUpdate: two replicas would race on one store,
    // and on a backend enforcing RWO across nodes would deadlock outright.
    expect(dep.spec.strategy).toEqual({ type: 'Recreate' })
    expect(dep.spec.selector.matchLabels)
      .toEqual({ app: REGISTRY_APP_LABEL, 'yaac.project': 'demo' })
    const pod = dep.spec.template.spec
    // Trusted yaac infra: no SA token, no service links, runc (no sentry to
    // buy — it runs only the pinned upstream registry image).
    expect(pod.automountServiceAccountToken).toBe(false)
    expect(pod.enableServiceLinks).toBe(false)
    expect(pod.runtimeClassName).toBeUndefined()
    // Infra tier: the project's sessions pull their images from here, so it
    // outranks them when the node runs out of room.
    expect(pod.priorityClassName).toBe('yaac-infra')
    expect(pod.hostUsers).toBeUndefined()
    expect(pod.securityContext).toBeUndefined()
    expect(pod.containers[0].image).toMatch(/^localhost:5001\/yaac-registry2:/)
    expect(pod.containers[0].ports).toEqual([{ containerPort: PROJECT_REGISTRY_PORT }])
    // Storage is the project's own claim, scoped by the same install hash +
    // slug derivation the Deployment name uses.
    expect(pod.volumes).toEqual([{
      name: 'storage',
      persistentVolumeClaim: { claimName: projectRegistryPvcName('demo') },
    }])

    const svc = appliedKind('Service') as {
      spec: { ports: Array<{ port: number; targetPort: number }> }
    }
    expect(svc.spec.ports[0].port).toBe(PROJECT_REGISTRY_PORT)
    expect(svc.spec.ports[0].targetPort).toBe(PROJECT_REGISTRY_PORT)
  })

  it('fences the registry to its own project: sessions in, nothing out', async () => {
    await ensureProjectRegistry('demo')

    const nps = appliedAllKind('NetworkPolicy') as unknown as Array<{
      metadata: { name: string; namespace: string }
      spec: {
        podSelector: { matchLabels: Record<string, string>; matchExpressions?: unknown }
        policyTypes: string[]
        egress?: Array<Record<string, unknown>>
        ingress?: Array<{ from?: unknown; ports?: Array<{ protocol: string; port: number }> }>
      }
    }>
    const name = projectRegistryName('demo')

    // Only this project's sessions may egress to this project's registry.
    const sessions = nps.find((m) => m.metadata.name === `${name}-sessions`)!
    expect(sessions.spec.podSelector.matchLabels).toEqual({ 'yaac.project': 'demo' })
    expect(sessions.spec.policyTypes).toEqual(['Egress'])

    // Ingress admits same-project sessions and the node (containerd pulls),
    // the latter by address through the real cluster-cidrs probe.
    const ingress = nps.find((m) => m.metadata.name === `${name}-ingress`)!
    expect(ingress.spec.policyTypes).toEqual(['Ingress'])
    const node = ingress.spec.ingress!.find((r) => JSON.stringify(r.from).includes(NODE_IP))
    expect(node?.ports).toEqual([{ protocol: 'TCP', port: PROJECT_REGISTRY_PORT }])

    // The registry pod itself has nothing to fetch, so its egress is empty.
    const egress = nps.find((m) => m.metadata.name === `${name}-egress`)!
    expect(egress.spec.policyTypes).toEqual(['Egress'])
    expect(egress.spec.egress).toEqual([])
  })

  it('mirrors the pinned upstream registry image, pulling only when it is absent', async () => {
    // Already in the local registry — no podman at all.
    mockHasTag.mockResolvedValue(true)
    await ensureProjectRegistry('demo')
    expect(mockExec).not.toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()

    // Present in podman but not pushed — push without pulling.
    vi.clearAllMocks()
    stageLiveCluster()
    mockHasTag.mockResolvedValue(false)
    mockImageExists.mockResolvedValue(true)
    await ensureProjectRegistry('demo')
    expect(mockExec).not.toHaveBeenCalled()
    expect(mockPush).toHaveBeenCalledWith(REGISTRY_MIRROR_TAG)

    // Absent everywhere — pull by the multi-arch index digest, tag, push.
    vi.clearAllMocks()
    stageLiveCluster()
    mockHasTag.mockResolvedValue(false)
    mockImageExists.mockResolvedValue(false)
    await ensureProjectRegistry('demo')
    expect(REGISTRY_UPSTREAM_IMAGE).toBe(`docker.io/library/registry@${REGISTRY_IMAGE_DIGEST}`)
    expect(mockExec).toHaveBeenCalledWith(
      'podman', ['pull', REGISTRY_UPSTREAM_IMAGE], expect.objectContaining({ timeout: 300_000 }),
    )
    expect(mockExec).toHaveBeenCalledWith(
      'podman', ['tag', REGISTRY_UPSTREAM_IMAGE, REGISTRY_MIRROR_TAG],
    )
    expect(mockPush).toHaveBeenCalledWith(REGISTRY_MIRROR_TAG)
  })

  it('names the PVC when the rollout times out', async () => {
    // Session create is where a storage misconfiguration surfaces first, and
    // an unbindable claim presents as a Pending pod with no scheduling
    // reason of its own — kubectl's bare timeout text names neither.
    mockRetry.mockImplementation((args: string[]) => (
      args[0] === 'rollout' && args[1] === 'status'
        ? Promise.reject(new Error('timed out waiting for the condition'))
        : Promise.resolve({ stdout: '', stderr: '' })
    ))
    await expect(ensureProjectRegistry('demo'))
      .rejects.toThrow(/get pods,pvc .* no default StorageClass/s)
  })

  it('fails fast instead of pulling when prebuilt images are required', async () => {
    vi.stubEnv('YAAC_REQUIRE_PREBUILT_IMAGES', '1')
    mockHasTag.mockResolvedValue(false)
    mockImageExists.mockResolvedValue(false)
    await expect(ensureProjectRegistry('demo')).rejects.toThrow(/missing/)
    expect(mockExec).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })
})

describe('removeProjectRegistry', () => {
  function mockClusterWithPodPhase(phase: string, hadRegistry = true): void {
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      const cidr = cidrRead(args)
      if (cidr) return cidr
      if (args[1] === 'deployment,service') {
        return Promise.resolve({ items: hadRegistry ? [{}] : [] })
      }
      if (args[1] === 'nodes') return Promise.resolve(NODE_LIST)
      if (args[1] === 'pod') return Promise.resolve({ status: { phase } })
      return Promise.resolve(null)
    })
  }

  it('deletes by label selector scoped to this install and cleans the node via a pod', async () => {
    mockClusterWithPodPhase('Succeeded')
    await removeProjectRegistry('demo')
    // `persistentvolumeclaim` in the kinds is what reclaims the blobs — the
    // storage is no longer a directory a cleanup pod could rm. `pod` reaps
    // stray writer/cleanup pods from crashed runs.
    expect(mockRetry).toHaveBeenCalledWith([
      'delete', 'deployment,service,networkpolicy,persistentvolumeclaim,pod',
      '-l', `app=${REGISTRY_APP_LABEL},yaac.project=demo,${LABEL_REGISTRY_DATA_DIR_HASH}=ddh16`,
      '-n', 'test-ns', '--ignore-not-found',
    ])
    const pod = mockApply.mock.calls
      .map((c) => c[0] as {
        kind: string
        spec: {
          nodeName: string
          containers: Array<{ command: string[]; volumeMounts: unknown[] }>
        }
      })
      .find((m) => m.kind === 'Pod')!
    expect(pod.spec.nodeName).toBe('yaac-control-plane')
    const script = pod.spec.containers[0].command[2]
    expect(script).toContain(`/host-certs/${projectRegistryHost('demo')}`)
    // The hosts.toml dir is now the ONLY thing this project wrote outside
    // the API server, so the cleanup pod carries no storage mount at all.
    expect(script).not.toContain('/host-storage')
    expect(pod.spec.containers[0].volumeMounts).toHaveLength(1)
    expect(mockExec).not.toHaveBeenCalled()
  })

  it('swallows node-side cleanup failures (cluster recreate)', async () => {
    mockClusterWithPodPhase('Failed')
    await expect(removeProjectRegistry('demo')).resolves.toBeUndefined()
  })

  it('skips the node cleanup pods when the project never had a registry', async () => {
    mockClusterWithPodPhase('Succeeded', false)
    await removeProjectRegistry('demo')
    // The by-selector delete still runs (reaps stray pods from crashes)...
    expect(mockRetry).toHaveBeenCalledWith([
      'delete', 'deployment,service,networkpolicy,persistentvolumeclaim,pod',
      '-l', `app=${REGISTRY_APP_LABEL},yaac.project=demo,${LABEL_REGISTRY_DATA_DIR_HASH}=ddh16`,
      '-n', 'test-ns', '--ignore-not-found',
    ])
    // ...but no cleanup pod is applied and no nodes are listed: a pod that
    // can't start (image never mirrored / nested pod guard) would burn the
    // full runNodeWritePod deadline and stall project remove for 60s.
    expect(mockApply).not.toHaveBeenCalled()
    expect(mockGetJson).not.toHaveBeenCalledWith(['get', 'nodes'])
  })
})

describe('gcOrphanProjectRegistries', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('removes registries whose project dir is gone, keeps live ones', async () => {
    await fs.mkdir(path.join(tmpDir, 'projects', 'alive'), { recursive: true })
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      const cidr = cidrRead(args)
      if (cidr) return cidr
      if (args[1] === 'services') {
        return Promise.resolve({
          items: [
            { metadata: { labels: { 'yaac.project': 'alive' } } },
            { metadata: { labels: { 'yaac.project': 'gone' } } },
          ],
        })
      }
      if (args[1] === 'deployment,service') return Promise.resolve({ items: [{}] })
      if (args[1] === 'nodes') return Promise.resolve(NODE_LIST)
      if (args[1] === 'pod') return Promise.resolve({ status: { phase: 'Succeeded' } })
      return Promise.resolve(null)
    })

    await gcOrphanProjectRegistries()

    // Filter to the label-selector object deletes — the cleanup pod's own
    // lifecycle (pre-delete + delete-after) also issues `delete pod` calls.
    const deletes = mockRetry.mock.calls
      .map((c) => c[0])
      .filter((args) => args[0] === 'delete'
        && args[1] === 'deployment,service,networkpolicy,persistentvolumeclaim,pod')
    expect(deletes).toHaveLength(1)
    expect(deletes[0][3]).toContain('yaac.project=gone')
  })

  it('tolerates an unreachable cluster', async () => {
    mockGetJson.mockRejectedValue(new Error('connection refused'))
    await expect(gcOrphanProjectRegistries()).resolves.toBeUndefined()
  })
})

describe('reconcileProjectRegistryGc', () => {
  /** One registry to collect, plus the poll a collect pod needs. */
  function oneRegistry(): void {
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      const cidr = cidrRead(args)
      if (cidr) return cidr
      if (args[1] === 'services') {
        return Promise.resolve({ items: [{ metadata: { labels: { 'yaac.project': 'demo' } } }] })
      }
      if (args[1] === 'pod') return Promise.resolve({ status: { phase: 'Succeeded' } })
      return Promise.resolve(null)
    })
  }
  const kubectlArgs = (): string[][] => mockRetry.mock.calls.map((c) => c[0])
  /** Whether each applied registry Deployment was the read-only one. */
  const rollouts = (): boolean[] => mockApply.mock.calls
    .map((c) => c[0] as { kind: string; spec?: { template?: { spec?: { containers?: Array<
      { env?: Array<{ name: string }> }> } } } })
    .filter((m) => m.kind === 'Deployment')
    .map((m) => (m.spec?.template?.spec?.containers?.[0]?.env ?? [])
      .some((e) => e.name === 'REGISTRY_STORAGE_MAINTENANCE_READONLY'))

  beforeEach(() => {
    _resetRegistryGcForTests()
  })

  /** The step detaches its collect, so tests await the work it started. */
  const gcPass = async (now: number): Promise<void> => {
    await reconcileProjectRegistryGc(now)
    await _registryGcSettledForTests()
  }

  it('collects behind a read-only window, then restores serving mode', async () => {
    oneRegistry()
    await gcPass(1_000)

    // Read-only in, serving out. Not scale-to-zero: an active project's
    // session count never reaches zero, and pulls have to keep working.
    expect(rollouts()).toEqual([true, false])
    expect(kubectlArgs().filter((a) => a[0] === 'scale')).toEqual([])
    const pod = mockApply.mock.calls.map((c) => c[0] as {
      kind: string
      metadata: { name: string; labels: Record<string, string> }
      spec: {
        nodeName?: string
        affinity?: Record<string, unknown>
        containers: Array<{ image: string; command: string[] }>
        volumes: Array<{ persistentVolumeClaim?: { claimName: string } }>
      }
    }).find((m) => m.kind === 'Pod' && m.metadata.name.includes('-gc-'))!
    // It collects the SAME claim the registry is serving from, not a copy.
    expect(pod.spec.volumes[0].persistentVolumeClaim)
      .toEqual({ claimName: projectRegistryPvcName('demo') })
    // RWO is node-scoped, so co-location with the registry pod is a
    // correctness requirement — stated as a REQUIRED podAffinity rather than
    // left to the bound volume to imply. On a network-attached CSI backend
    // the PV carries no node affinity and the scheduler does not enforce RWO
    // co-location, so the conflict would only surface at attach as a
    // Multi-Attach error, burning the collect's full deadline. `nodeName`
    // cannot express it either — it bypasses the scheduler entirely.
    expect(pod.spec.nodeName).toBeUndefined()
    expect(pod.spec.affinity).toEqual({
      podAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: [{
          labelSelector: {
            // Install-scoped, not just app+project: two installs sharing a
            // namespace can hold the same slug, and matching without the
            // data-dir hash would let one install's collect become affine to
            // the other's registry pod — a node its own volume is not on.
            matchLabels: {
              app: REGISTRY_APP_LABEL,
              'yaac.project': 'demo',
              [LABEL_REGISTRY_DATA_DIR_HASH]: 'ddh16',
            },
            // Without this the term would also be satisfied by a sibling
            // one-shot pod, which implies nothing about where the volume is.
            matchExpressions: [{ key: LABEL_NODE_WRITE, operator: 'DoesNotExist' }],
          },
          topologyKey: 'kubernetes.io/hostname',
        }],
      },
    })
    const script = pod.spec.containers[0].command[2]
    expect(script).toContain(
      '/bin/registry garbage-collect --delete-untagged=true /etc/docker/registry/config.yml')
    expect(pod.metadata.labels['yaac.node-write']).toBe('gc')

    // Retention runs FIRST: it is what turns a stale content-hash
    // generation into the untagged manifest the collect can then reclaim.
    expect(script.indexOf('retired-generations'))
      .toBeLessThan(script.indexOf('garbage-collect'))
  })

  it('retires only yaac content-hash generations, never a name someone could pull', async () => {
    oneRegistry()
    await gcPass(1_000)
    const script = (mockApply.mock.calls.map((c) => c[0] as {
      kind: string; metadata: { name: string }
      spec: { containers: Array<{ command: string[] }> }
    }).find((m) => m.kind === 'Pod' && m.metadata.name.includes('-gc-'))!)
      .spec.containers[0].command[2]
    // Repo guard keeps a worktree's own `myapp` repo out of scope...
    expect(script).toContain('yaac-*) ;;')
    // ...and the tag guard is the content-hash shape, so `v1`, `latest`
    // and the cache's `yaac-cache-…` slots can never match.
    expect(script).toContain("grep -Ex '[0-9a-f]{16}'")
    // Newest-first, keeping current + one rollback (the host-side policy).
    expect(script).toContain('ls -1t')
    expect(script).toContain(`tail -n +${REGISTRY_GENERATIONS_KEPT + 1}`)
  })

  it('sends valid POSIX shell into the collect pod', async () => {
    oneRegistry()
    await gcPass(1_000)
    const script = (mockApply.mock.calls.map((c) => c[0] as {
      kind: string; metadata: { name: string }
      spec: { containers: Array<{ command: string[] }> }
    }).find((m) => m.kind === 'Pod' && m.metadata.name.includes('-gc-'))!)
      .spec.containers[0].command[2]
    await expect(runSh('sh', ['-n', '-c', script])).resolves.toBeTruthy()
  })

  it('collects a project whose sessions are live — idleness is not required', async () => {
    oneRegistry()
    // Nothing about the pass consults session pods: read-only is what
    // makes a concurrent push safe, and a push that 405s is retried.
    await gcPass(1_000)
    expect(rollouts()).toEqual([true, false])
  })

  it('throttles to one collect per project per interval', async () => {
    oneRegistry()
    await gcPass(1_000)
    mockApply.mockClear()
    await gcPass(1_000 + REGISTRY_GC_INTERVAL_MS - 1)
    expect(rollouts()).toEqual([])
    await gcPass(1_000 + REGISTRY_GC_INTERVAL_MS)
    expect(rollouts()).toEqual([true, false])
  })

  it('restores serving mode when the collect fails', async () => {
    oneRegistry()
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      const cidr = cidrRead(args)
      if (cidr) return cidr
      if (args[1] === 'services') {
        return Promise.resolve({ items: [{ metadata: { labels: { 'yaac.project': 'demo' } } }] })
      }
      // The collect pod never reaches Succeeded.
      if (args[1] === 'pod') return Promise.resolve({ status: { phase: 'Failed' } })
      return Promise.resolve(null)
    })
    await gcPass(1_000)
    // A failed collect must never strand the registry in maintenance mode.
    expect(rollouts()).toEqual([true, false])
  })

  it('returns without waiting on the collect it starts', async () => {
    oneRegistry()
    // Reconcile steps run sequentially, so a step that awaited a collect
    // (two rollouts + a pod run) would stall every later step and every
    // later tick behind it. Hold the first rollout open and check the step
    // has already returned with the registry still in maintenance mode.
    let release = (): void => {}
    const held = new Promise<{ stdout: string; stderr: string }>((r) => {
      release = () => r({ stdout: '', stderr: '' })
    })
    mockRetry.mockImplementation((args: string[]) =>
      args[0] === 'rollout' ? held : Promise.resolve({ stdout: '', stderr: '' }))

    await reconcileProjectRegistryGc(1_000)
    expect(rollouts()).not.toContain(false)

    release()
    await _registryGcSettledForTests()
  })

  it('tolerates an unreachable cluster', async () => {
    mockGetJson.mockRejectedValue(new Error('connection refused'))
    await expect(reconcileProjectRegistryGc(1_000)).resolves.toBeUndefined()
  })
})
