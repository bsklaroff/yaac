import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/** Real `sh -n` syntax check (the kubectl execFileAsync here is a mock). */
const runSh = promisify(execFile)

vi.mock('#drivers/k8s/substrate/kubectl', () => ({
  isKubectlAbsentError: vi.fn(() => false),
  kubectlErrorSummary: vi.fn((e: unknown) => String(e)),
  k8sNamespace: vi.fn(() => 'test-ns'),
  dataDirHash: vi.fn(() => 'ddh16'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  execFileAsync: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

vi.mock('#drivers/k8s/container/registry', () => ({
  registryHasTag: vi.fn().mockResolvedValue(false),
  registryRef: vi.fn((tag: string) => `localhost:5001/${tag}`),
  pushImageToRegistry: vi.fn((tag: string) => Promise.resolve(`localhost:5001/${tag}`)),
}))

vi.mock('#drivers/k8s/container/runtime', () => ({
  imageExists: vi.fn().mockResolvedValue(false),
}))

import {
  buildRegistryRetentionScript,
  ensureProjectRegistry,
  gcOrphanProjectRegistries,
  projectRegistryConfDropIn,
  projectRegistryHost,
  reconcileProjectRegistryGc,
  removeProjectRegistry,
} from '#drivers/k8s/cluster'
// Setup values: label keys, the pinned upstream digest, and the name/path
// derivations the assertions below compare against.
import {
  LABEL_NODE_WRITE,
  LABEL_REGISTRY_DATA_DIR_HASH,
  PROJECT_REGISTRY_PORT,
  PROJECT_REGISTRY_STORAGE_SIZE,
  REGISTRY_APP_LABEL,
  REGISTRY_IMAGE_DIGEST,
  REGISTRY_UPSTREAM_IMAGE,
  ORPHAN_REGISTRY_GC_INTERVAL_MS,
  ORPHAN_REGISTRY_MIN_AGE_MS,
  REGISTRY_GC_INTERVAL_MS,
  REGISTRY_GENERATIONS_KEPT,
  _registryGcSettledForTests,
  _resetOrphanRegistryGcForTests,
  _resetRegistryGcForTests,
  projectRegistryName,
  projectRegistryPvcName,
} from '#drivers/k8s/cluster/project-registry'
import { resetClusterCidrCache } from '#drivers/k8s/cluster/cluster-cidrs'
import {
  execFileAsync,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from '#drivers/k8s/substrate/kubectl'
import { pushImageToRegistry, registryHasTag } from '#drivers/k8s/container/registry'
import { imageExists } from '#drivers/k8s/container/runtime'

const mockApply = vi.mocked(kubectlApply)
const mockGetJson = vi.mocked(kubectlGetJson)
const mockRetry = vi.mocked(kubectlWithRetry)
const mockExec = vi.mocked(execFileAsync)
const mockHasTag = vi.mocked(registryHasTag)
const mockPush = vi.mocked(pushImageToRegistry)
const mockImageExists = vi.mocked(imageExists)

const ID = '3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c'
const PROJECT = { slug: 'demo', id: ID }
const REGISTRY_SELECTOR = `app=${REGISTRY_APP_LABEL},${LABEL_REGISTRY_DATA_DIR_HASH}=ddh16,yaac.project-id=${ID}`

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
  it('is the svc-DNS FQDN of the registry named by the project id, with its port', () => {
    // FQDN, not the `.svc` shorthand: the proxy forwards only `.cluster.local`.
    // Named by the id alone: a project re-added under a freed slug gets a
    // registry of its own, and no install hash is needed to keep installs
    // sharing a namespace apart.
    expect(projectRegistryHost(ID)).toBe(`yaac-reg-${ID}.test-ns.svc.cluster.local:5000`)
  })
})

describe('projectRegistryConfDropIn', () => {
  it('renders an insecure drop-in scoped to the exact registry host', () => {
    // Scoped to the one host: a blanket `insecure = true` would apply to
    // every registry the in-pod engine talks to.
    expect(projectRegistryConfDropIn(ID)).toBe([
      '[[registry]]',
      `location = "${projectRegistryHost(ID)}"`,
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
    await ensureProjectRegistry(PROJECT)

    const kinds = mockApply.mock.calls.map((c) => (c[0] as { kind: string }).kind)
    // The claim first: the Deployment's pod must not spend the rollout wait
    // Pending on a volume that does not exist yet.
    expect(kinds).toEqual([
      'PersistentVolumeClaim', 'Deployment', 'Service',
      'NetworkPolicy', 'NetworkPolicy', 'NetworkPolicy', 'Pod',
    ])
    expect(mockRetry).toHaveBeenCalledWith(
      [
        'rollout', 'status', `deployment/${projectRegistryName(ID)}`,
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
      '-l', `${REGISTRY_SELECTOR},${LABEL_NODE_WRITE}`,
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
        new RegExp(`^${projectRegistryName(ID)}-hosts-0-[0-9a-f]{8}$`))
    }
    // The ClusterIP is allocator-assigned and never deleted — no migration.
    expect(mockRetry).not.toHaveBeenCalledWith(expect.arrayContaining(['delete', 'service']))
  })

  it('names every object after the project id, within the DNS-label cap', async () => {
    await ensureProjectRegistry(PROJECT)
    const objects = mockApply.mock.calls
      .map((c) => c[0] as { kind: string; metadata: { name: string; labels: Record<string, string> } })
      .filter((m) => m.kind !== 'Pod')
    expect(objects.map((m) => m.kind).sort()).toEqual([
      'Deployment', 'NetworkPolicy', 'NetworkPolicy', 'NetworkPolicy',
      'PersistentVolumeClaim', 'Service',
    ])
    for (const { metadata } of objects) {
      expect(metadata.name.startsWith(`yaac-reg-${ID}`)).toBe(true)
      expect(metadata.name.length).toBeLessThanOrEqual(63)
      // The id is what selectors and the orphan GC key on; the slug stays
      // for a human reading `kubectl get`.
      expect(metadata.labels).toMatchObject({ 'yaac.project-id': ID, 'yaac.project': 'demo' })
    }
  })

  it('leaves placement to the bound volume rather than pinning the Deployment', async () => {
    // The store belongs to the CLAIM, so the registry follows its blobs
    // wherever it is scheduled: nothing here names a node, and nothing has
    // to. A bound volume carries its own node affinity, which the scheduler
    // enforces — a hand-written pin would only add a way to contradict it,
    // and would trade a self-healing degradation for a single point of
    // failure on exactly the store a node replacement destroys.
    await ensureProjectRegistry(PROJECT)

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
      .toEqual({ claimName: projectRegistryPvcName(ID) })

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
    expect(pvc.metadata.name).toBe(projectRegistryPvcName(ID))
    expect(pvc.metadata.namespace).toBe('test-ns')
    // Carries the registry labels, which is what puts it inside
    // removeProjectRegistry's by-selector delete — the PVC IS the storage
    // reclaim now, so a claim outside that selector would leak the blobs.
    expect(pvc.metadata.labels).toMatchObject({
      app: REGISTRY_APP_LABEL, 'yaac.project-id': ID,
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

    const first = ensureProjectRegistry(PROJECT)
    const second = ensureProjectRegistry(PROJECT)
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

    await expect(ensureProjectRegistry(PROJECT))
      .rejects.toThrow(/did not complete \(phase Failed\); logs: read-only file system/)
  })

  it('runs the registry as untrusted-free infra off its own claim', async () => {
    await ensureProjectRegistry(PROJECT)

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
    expect(dep.metadata.name).toBe(projectRegistryName(ID))
    expect(dep.metadata.namespace).toBe('test-ns')
    expect(dep.spec.replicas).toBe(1)
    // Recreate, not RollingUpdate: two replicas would race on one store,
    // and on a backend enforcing RWO across nodes would deadlock outright.
    expect(dep.spec.strategy).toEqual({ type: 'Recreate' })
    expect(dep.spec.selector.matchLabels)
      .toEqual({ app: REGISTRY_APP_LABEL, 'yaac.project-id': ID })
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
      persistentVolumeClaim: { claimName: projectRegistryPvcName(ID) },
    }])

    const svc = appliedKind('Service') as {
      spec: { ports: Array<{ port: number; targetPort: number }> }
    }
    expect(svc.spec.ports[0].port).toBe(PROJECT_REGISTRY_PORT)
    expect(svc.spec.ports[0].targetPort).toBe(PROJECT_REGISTRY_PORT)
  })

  it('fences the registry to its own project: sessions in, nothing out', async () => {
    await ensureProjectRegistry(PROJECT)

    const nps = appliedAllKind('NetworkPolicy') as unknown as Array<{
      metadata: { name: string; namespace: string }
      spec: {
        podSelector: { matchLabels: Record<string, string>; matchExpressions?: unknown }
        policyTypes: string[]
        egress?: Array<Record<string, unknown>>
        ingress?: Array<{ from?: unknown; ports?: Array<{ protocol: string; port: number }> }>
      }
    }>
    const name = projectRegistryName(ID)

    // Only this project's sessions may egress to this project's registry —
    // selected by id, so a later project of the same slug is not admitted
    // to a registry an old one's removal left behind.
    const sessions = nps.find((m) => m.metadata.name === `${name}-sessions`)!
    expect(sessions.spec.podSelector.matchLabels).toEqual({ 'yaac.project-id': ID })
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

  it('takes the registry image from the local registry, never the host engine', async () => {
    // A digest-pinned upstream mirrored by `yaac cluster install`. Standing
    // a project's registry up is a server-side action, so it may only look
    // the mirror tag up — a server has no container engine to pull with.
    mockHasTag.mockResolvedValue(true)
    await ensureProjectRegistry(PROJECT)
    expect(REGISTRY_UPSTREAM_IMAGE).toBe(`docker.io/library/registry@${REGISTRY_IMAGE_DIGEST}`)
    expect(mockExec).not.toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()

    // Missing: refuse, naming the command that mirrors it.
    vi.clearAllMocks()
    stageLiveCluster()
    mockHasTag.mockResolvedValue(false)
    mockImageExists.mockResolvedValue(false)
    await expect(ensureProjectRegistry(PROJECT))
      .rejects.toThrow(/Registry image .* is missing.*yaac cluster install/s)
    expect(mockExec).not.toHaveBeenCalled()
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
    await expect(ensureProjectRegistry(PROJECT))
      .rejects.toThrow(/get pods,pvc .* no default StorageClass/s)
  })

  it('fails fast instead of pulling when prebuilt images are required', async () => {
    vi.stubEnv('YAAC_REQUIRE_PREBUILT_IMAGES', '1')
    mockHasTag.mockResolvedValue(false)
    mockImageExists.mockResolvedValue(false)
    await expect(ensureProjectRegistry(PROJECT)).rejects.toThrow(/missing/)
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
    await removeProjectRegistry(ID)
    // `persistentvolumeclaim` in the kinds is what reclaims the blobs — the
    // storage is no longer a directory a cleanup pod could rm. `pod` reaps
    // stray writer/cleanup pods from crashed runs.
    expect(mockRetry).toHaveBeenCalledWith([
      'delete', 'deployment,service,networkpolicy,persistentvolumeclaim,pod',
      '-l', REGISTRY_SELECTOR,
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
    expect(script).toContain(`/host-certs/${projectRegistryHost(ID)}`)
    // The hosts.toml dir is now the ONLY thing this project wrote outside
    // the API server, so the cleanup pod carries no storage mount at all.
    expect(script).not.toContain('/host-storage')
    expect(pod.spec.containers[0].volumeMounts).toHaveLength(1)
    expect(mockExec).not.toHaveBeenCalled()
  })

  it('swallows node-side cleanup failures (cluster recreate)', async () => {
    mockClusterWithPodPhase('Failed')
    await expect(removeProjectRegistry(ID)).resolves.toBeUndefined()
  })

  it('skips the node cleanup pods when the project never had a registry', async () => {
    mockClusterWithPodPhase('Succeeded', false)
    await removeProjectRegistry(ID)
    // The by-selector delete still runs (reaps stray pods from crashes)...
    expect(mockRetry).toHaveBeenCalledWith([
      'delete', 'deployment,service,networkpolicy,persistentvolumeclaim,pod',
      '-l', REGISTRY_SELECTOR,
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
  const LIVE = '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9'
  const GONE = 'c9d8e7f6-a5b4-4c3d-8e2f-1a0b9c8d7e6f'
  const NOW = Date.parse('2026-09-29T12:00:00Z')
  const OLD = new Date(NOW - ORPHAN_REGISTRY_MIN_AGE_MS - 1).toISOString()

  beforeEach(() => {
    _resetOrphanRegistryGcForTests()
  })

  const objectDeletes = (): string[] => mockRetry.mock.calls
    .map((c) => c[0])
    .filter((args) => args[0] === 'delete'
      && args[1] === 'deployment,service,networkpolicy,persistentvolumeclaim,pod')
    .map((args) => args[3])

  function stageRegistries(items: unknown[]): void {
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      const cidr = cidrRead(args)
      if (cidr) return cidr
      if (args[1] === 'deployment,service,persistentvolumeclaim') return Promise.resolve({ items })
      if (args[1] === 'pod') return Promise.resolve({ status: { phase: 'Succeeded' } })
      return Promise.resolve(null)
    })
  }

  it('removes registries no live project id owns, and those with no id, keeping the rest', async () => {
    const labelled = (id: string, slug: string): Record<string, string> =>
      ({ app: REGISTRY_APP_LABEL, 'yaac.project': slug, 'yaac.project-id': id })
    stageRegistries([
      // A live project's registry, in every kind it is made of.
      { kind: 'Service', metadata: { name: `yaac-reg-${LIVE}`, labels: labelled(LIVE, 'app'), creationTimestamp: OLD } },
      { kind: 'PersistentVolumeClaim', metadata: { name: `yaac-reg-${LIVE}-storage`, labels: labelled(LIVE, 'app'), creationTimestamp: OLD } },
      // A removed project's: the claim listed first must not lose the name
      // its Deployment carries (it names the node-side hosts.toml dir).
      { kind: 'PersistentVolumeClaim', metadata: { name: `yaac-reg-${GONE}-storage`, labels: labelled(GONE, 'app'), creationTimestamp: OLD } },
      { kind: 'Deployment', metadata: { name: `yaac-reg-${GONE}`, labels: labelled(GONE, 'app'), creationTimestamp: OLD } },
      // One named before projects had ids, for the SAME slug as the live
      // project: grouped by slug, but never with an id-labelled object.
      { kind: 'Service', metadata: { name: 'yaac-reg-app-1a2b3c4d', labels: { app: REGISTRY_APP_LABEL, 'yaac.project': 'app' }, creationTimestamp: OLD } },
      // Too young to judge: a project added after this pass read the
      // live set may be standing it up right now.
      { kind: 'Service', metadata: { name: 'yaac-reg-new', labels: labelled('5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9', 'new'), creationTimestamp: new Date(NOW - 1000).toISOString() } },
      // An age that cannot be read is never old enough: a deletion fails
      // closed.
      { kind: 'Service', metadata: { name: 'yaac-reg-ageless', labels: labelled('6f7a8b9c-0d1e-4f2a-b3c4-d5e6f7a8b9c0', 'ageless') } },
    ])

    await gcOrphanProjectRegistries(new Set([LIVE]), NOW)

    expect(objectDeletes().sort()).toEqual([
      `app=${REGISTRY_APP_LABEL},${LABEL_REGISTRY_DATA_DIR_HASH}=ddh16,yaac.project-id=${GONE}`,
      `app=${REGISTRY_APP_LABEL},${LABEL_REGISTRY_DATA_DIR_HASH}=ddh16,yaac.project=app,!yaac.project-id`,
    ].sort())
    // Both had a Deployment/Service, so each gets its node-side cleanup,
    // addressed by the name the registry actually had.
    // An id's cleanup pods carry the id, so a stray one stranded by a crash
    // is inside that id's removal selector; a pre-id registry's cannot.
    const cleanups = mockApply.mock.calls
      .map((c) => c[0] as {
        kind: string
        metadata: { name: string; labels: Record<string, string> }
        spec: { containers: Array<{ command: string[] }> }
      })
      .filter((m) => m.kind === 'Pod' && m.metadata.name.includes('-cleanup-'))
      .map((m) => [m.spec.containers[0].command[2], m.metadata.labels['yaac.project-id']])
    expect(cleanups).toEqual(expect.arrayContaining([
      [expect.stringContaining(`/host-certs/yaac-reg-${GONE}.test-ns.svc.cluster.local:5000`), GONE],
      [expect.stringContaining('/host-certs/yaac-reg-app-1a2b3c4d.test-ns.svc.cluster.local:5000'), undefined],
    ]))
    // Listed across this install's registries only.
    expect(mockGetJson).toHaveBeenCalledWith([
      'get', 'deployment,service,persistentvolumeclaim', '-n', 'test-ns',
      '-l', `app=${REGISTRY_APP_LABEL},${LABEL_REGISTRY_DATA_DIR_HASH}=ddh16`,
    ])
  })

  it('runs at most once per interval', async () => {
    stageRegistries([])
    await gcOrphanProjectRegistries(new Set(), NOW)
    await gcOrphanProjectRegistries(new Set(), NOW + ORPHAN_REGISTRY_GC_INTERVAL_MS - 1)
    expect(mockGetJson).toHaveBeenCalledTimes(1)
    await gcOrphanProjectRegistries(new Set(), NOW + ORPHAN_REGISTRY_GC_INTERVAL_MS)
    expect(mockGetJson).toHaveBeenCalledTimes(2)
  })

  it('tolerates an unreachable cluster', async () => {
    mockGetJson.mockRejectedValue(new Error('connection refused'))
    await expect(gcOrphanProjectRegistries(new Set(), NOW)).resolves.toBeUndefined()
    expect(objectDeletes()).toEqual([])
  })
})

describe('reconcileProjectRegistryGc', () => {
  /**
   * A registry created at the epoch — old enough that DUE is past its
   * first interval — plus the poll a collect pod needs.
   */
  function oneRegistry(createdMs = 0): void {
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      const cidr = cidrRead(args)
      if (cidr) return cidr
      if (args[1] === 'services') {
        return Promise.resolve({ items: [{ metadata: {
          labels: { 'yaac.project': 'demo', 'yaac.project-id': ID },
          creationTimestamp: new Date(createdMs).toISOString(),
        } }] })
      }
      if (args[1] === 'pod') return Promise.resolve({ status: { phase: 'Succeeded' } })
      return Promise.resolve(null)
    })
  }
  /** A `now` at which the epoch-created registry above is collectable. */
  const DUE = REGISTRY_GC_INTERVAL_MS + 1_000
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
  const LIVE = new Set([ID])
  const gcPass = async (now: number): Promise<void> => {
    await reconcileProjectRegistryGc(LIVE, now)
    await _registryGcSettledForTests()
  }

  // A dead id's registry is the orphan sweep's: a collect racing that
  // removal would re-apply the Deployment with no PVC behind it.
  it('never collects a registry whose project id is not live', async () => {
    oneRegistry()
    await reconcileProjectRegistryGc(new Set(), DUE)
    await _registryGcSettledForTests()
    expect(mockApply).not.toHaveBeenCalled()
  })

  it('collects behind a read-only window, then restores serving mode', async () => {
    oneRegistry()
    await gcPass(DUE)

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
      .toEqual({ claimName: projectRegistryPvcName(ID) })
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
            // Exactly the registry pod's own labels, id and install scope
            // included.
            matchLabels: {
              app: REGISTRY_APP_LABEL,
              'yaac.project': 'demo',
              'yaac.project-id': ID,
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

  it('sends valid POSIX shell into the collect pod', async () => {
    oneRegistry()
    await gcPass(DUE)
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
    await gcPass(DUE)
    expect(rollouts()).toEqual([true, false])
  })

  it('throttles to one collect per project per interval', async () => {
    oneRegistry()
    await gcPass(DUE)
    mockApply.mockClear()
    await gcPass(DUE + REGISTRY_GC_INTERVAL_MS - 1)
    expect(rollouts()).toEqual([])
    await gcPass(DUE + REGISTRY_GC_INTERVAL_MS)
    expect(rollouts()).toEqual([true, false])
  })

  it('measures the throttle from the registry, not from this process', async () => {
    // A registry a worktree create JUST stood up has nothing to reclaim —
    // garbage here is the previous generation of a REBUILT tag — while the
    // window it would pay is two `Recreate` rollouts, landing exactly when
    // the new worktree is pushing and pulling through it hardest. So the
    // clock the throttle reads is the Service's age, not this process's
    // uptime, which is also why a server restart cannot re-arm it.
    oneRegistry(DUE - 1)
    await gcPass(DUE)
    expect(rollouts()).toEqual([])

    // The same unseen slug, one interval older: due, and collected.
    await gcPass(DUE + REGISTRY_GC_INTERVAL_MS - 1)
    expect(rollouts()).toEqual([true, false])
  })

  it('restores serving mode when the collect fails', async () => {
    oneRegistry()
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      const cidr = cidrRead(args)
      if (cidr) return cidr
      if (args[1] === 'services') {
        return Promise.resolve({ items: [{ metadata: { labels: { 'yaac.project': 'demo', 'yaac.project-id': ID } } }] })
      }
      // The collect pod never reaches Succeeded.
      if (args[1] === 'pod') return Promise.resolve({ status: { phase: 'Failed' } })
      return Promise.resolve(null)
    })
    await gcPass(DUE)
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

    await reconcileProjectRegistryGc(LIVE, DUE)
    expect(rollouts()).not.toContain(false)

    release()
    await _registryGcSettledForTests()
  })

  it('tolerates an unreachable cluster', async () => {
    mockGetJson.mockRejectedValue(new Error('connection refused'))
    await expect(reconcileProjectRegistryGc(LIVE, DUE)).resolves.toBeUndefined()
  })
})

describe('buildRegistryRetentionScript', () => {
  let storage: string
  const reposDir = (): string => path.join(storage, 'docker/registry/v2/repositories')
  const DAY_MS = 24 * 60 * 60_000

  /** A tag first written `ageDays` ago — the tag dir's own mtime is its
   *  creation time, which is what the retention orders by. */
  async function pushTag(repoTag: string, ageDays: number): Promise<void> {
    const [repo, tag] = repoTag.split(':')
    const tagDir = path.join(reposDir(), repo, '_manifests/tags', tag)
    await fs.mkdir(path.join(tagDir, 'current'), { recursive: true })
    const when = new Date(Date.now() - ageDays * DAY_MS)
    await fs.utimes(tagDir, when, when)
  }

  /** Run the script as the collect pod would, against the temp store. */
  async function retain(script: string): Promise<{ stdout: string; left: string[] }> {
    const { stdout } = await runSh('sh', ['-c', script.replaceAll('/var/lib/registry', storage)])
    const left: string[] = []
    for (const repo of ['yaac-tools', 'yaac-user-demo', 'myapp', 'yaac-test-base']) {
      const tags = await fs.readdir(path.join(reposDir(), repo, '_manifests/tags')).catch(() => [])
      left.push(...tags.map((t) => `${repo}:${t}`))
    }
    return { stdout, left: left.sort() }
  }

  const gen = (i: number): string => i.toString(16).padStart(16, '0')

  beforeEach(async () => {
    storage = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-registry-'))
  })
  afterEach(async () => {
    await fs.rm(storage, { recursive: true, force: true })
  })

  it('keeps the newest generations of each yaac repo and never a name someone could pull', async () => {
    for (let i = 1; i <= REGISTRY_GENERATIONS_KEPT + 2; i++) await pushTag(`yaac-tools:${gen(i)}`, 100 - i)
    // A mutable tag, a cache slot, and a repo yaac did not build.
    await pushTag('yaac-tools:latest', 200)
    await pushTag('yaac-tools:yaac-cache-v1-0', 200)
    await pushTag(`myapp:${gen(1)}`, 200)

    const { stdout, left } = await retain(buildRegistryRetentionScript())

    expect(left).toEqual([
      `myapp:${gen(1)}`,
      ...Array.from({ length: REGISTRY_GENERATIONS_KEPT }, (_, i) => `yaac-tools:${gen(i + 3)}`),
      'yaac-tools:latest', 'yaac-tools:yaac-cache-v1-0',
    ].sort())
    // Oldest last, and the count the collect pod's log line reports.
    expect(stdout.trim().split('\n')).toEqual([
      `RETIRED yaac-tools:${gen(2)}`, `RETIRED yaac-tools:${gen(1)}`, 'retired-generations 2',
    ])
  })

  it('spares protected tags and skipped repos', async () => {
    for (let i = 1; i <= 3; i++) {
      await pushTag(`yaac-user-demo:${gen(i)}`, 100 - i)
      await pushTag(`yaac-test-base:${gen(i)}`, 100 - i)
    }

    const { left } = await retain(buildRegistryRetentionScript({
      keep: 1,
      protect: [`yaac-user-demo:${gen(1)}`],
      skip: ['yaac-test-*'],
    }))

    expect(left).toEqual([
      ...[1, 2, 3].map((i) => `yaac-test-base:${gen(i)}`),
      `yaac-user-demo:${gen(1)}`, `yaac-user-demo:${gen(3)}`,
    ].sort())
  })
})
