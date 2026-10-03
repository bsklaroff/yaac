import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type * as childProcess from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { apiError, fakeCluster } from '@yaac/test-utils/k8s-stub'

/** Runs a real shell, which the child-process fake passes through. */
const runSh = promisify(execFile)

// The cluster (the fake behind client-node) and child processes are the
// boundaries. `sh` runs for real; anything else (kubectl, podman) is
// recorded and answers from `mockChild`.
type ExecResult = { stdout: string; stderr: string }
const mockChild = vi.hoisted(() => vi.fn<(file: string, args: string[]) => Promise<ExecResult>>())
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>()
  return {
    ...actual,
    execFile: (file: string, args: string[], ...rest: unknown[]) => {
      const cb = rest.at(-1) as (err: unknown, res?: ExecResult) => void
      if (file === 'sh') {
        actual.execFile(file, args, (err, stdout, stderr) => { cb(err, { stdout, stderr }) })
        return
      }
      mockChild(file, args).then((res) => { cb(null, res) }, cb)
    },
  }
})

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
// Setup values and test hooks, not units under test.
import {
  LABEL_NODE_WRITE,
  LABEL_REGISTRY_DATA_DIR_HASH,
  PROJECT_REGISTRY_PORT,
  PROJECT_REGISTRY_STORAGE_SIZE,
  REGISTRY_APP_LABEL,
  REGISTRY_IMAGE_DIGEST,
  REGISTRY_UPSTREAM_IMAGE,
  ORPHAN_REGISTRY_MIN_AGE_MS,
  REGISTRY_GC_INTERVAL_MS,
  REGISTRY_GENERATIONS_KEPT,
  _registryGcSettledForTests,
  _resetRegistryGcForTests,
  projectRegistryName,
  projectRegistryPvcName,
} from '#drivers/k8s/cluster/project-registry'
import { resetClusterCidrCache } from '#drivers/k8s/cluster/cluster-cidrs'
import { dataDirHash } from '#drivers/k8s/substrate'
import { pushImageToRegistry, registryHasTag } from '#drivers/k8s/container/registry'
import { imageExists } from '#drivers/k8s/container/runtime'

const mockHasTag = vi.mocked(registryHasTag)
const mockPush = vi.mocked(pushImageToRegistry)
const mockImageExists = vi.mocked(imageExists)

const ID = '3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c'
const PROJECT = { slug: 'demo', id: ID }
const registrySelector = (id: string): string =>
  `app=${REGISTRY_APP_LABEL},${LABEL_REGISTRY_DATA_DIR_HASH}=${dataDirHash()},yaac.project-id=${id}`
/** The labels every registry object of project `id` carries. */
const registryLabels = (id: string, slug = 'demo'): Record<string, string> => ({
  app: REGISTRY_APP_LABEL, [LABEL_REGISTRY_DATA_DIR_HASH]: dataDirHash(), 'yaac.project': slug, 'yaac.project-id': id,
})

const NODE_IP = '10.89.0.7'
// Serves both the writer pod's node name and the InternalIP the real
// cluster-cidrs probe turns into the ingress policy's ipBlock.
const NODE = {
  apiVersion: 'v1',
  kind: 'Node',
  metadata: { name: 'yaac-control-plane' },
  status: {
    addresses: [{ type: 'InternalIP', address: NODE_IP }],
    conditions: [{ type: 'Ready', status: 'True' }],
  },
}

beforeEach(() => {
  vi.stubEnv('YAAC_K8S_NAMESPACE', 'test-ns')
  mockChild.mockReset()
  mockChild.mockResolvedValue({ stdout: '', stderr: '' })
  mockHasTag.mockReset()
  mockHasTag.mockResolvedValue(false)
  mockPush.mockReset()
  mockPush.mockImplementation((tag: string) => Promise.resolve(`localhost:5001/${tag}`))
  mockImageExists.mockReset()
  mockImageExists.mockResolvedValue(false)
})

/** Every object applied, in order. */
const applied = <T = { kind: string }>(): T[] => fakeCluster.callsOf('apply').map((c) => c.body as T)
const appliedAllKind = (kind: string): unknown[] => applied().filter((m) => m.kind === kind)
const appliedKind = (kind: string): unknown => appliedAllKind(kind)[0]
const kubectlArgs = (): string[][] => mockChild.mock.calls.filter((c) => c[0] === 'kubectl').map((c) => c[1])
/** Child processes other than kubectl, e.g. a podman pull. */
const otherChildren = (): string[] => mockChild.mock.calls.filter((c) => c[0] !== 'kubectl').map((c) => c[0])

/**
 * A live cluster: one node is listed, and on read the API server fills in
 * what it owns: a Service's ClusterIP, and each one-shot pod's terminal
 * phase and logs.
 */
function stageLiveCluster(podPhase = 'Succeeded', podLogs = ''): void {
  resetClusterCidrCache()
  fakeCluster.seed(NODE)
  fakeCluster.intercept((call) => {
    if (call.verb !== 'read' || !call.name) return
    const stored = fakeCluster.get<Record<string, unknown>>(call.kind, call.name, call.namespace)
    if (!stored) return
    if (call.kind === 'Service') {
      fakeCluster.seed({ ...stored, spec: { ...stored.spec as object, clusterIP: '10.96.0.50' } } as never)
    }
    if (call.kind === 'Pod') {
      fakeCluster.seed({ ...stored, status: { phase: podPhase } } as never)
      fakeCluster.podLogs.set(call.name, podLogs)
    }
  })
}

describe('projectRegistryHost', () => {
  it('is the svc-DNS FQDN of the registry named by the project id, with its port', () => {
    // Full FQDN because the proxy forwards only `.cluster.local`. Named by
    // id, so a project re-added under an old slug gets its own registry.
    expect(projectRegistryHost(ID)).toBe(`yaac-reg-${ID}.test-ns.svc.cluster.local:5000`)
  })
})

describe('projectRegistryConfDropIn', () => {
  it('renders an insecure drop-in scoped to the exact registry host', () => {
    // Scoped to one host; a blanket `insecure = true` would cover every
    // registry the in-pod engine talks to.
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

    const kinds = applied().map((m) => m.kind)
    // The claim first, so the rollout wait never sees a pod Pending on a
    // missing volume.
    expect(kinds).toEqual([
      'PersistentVolumeClaim', 'Deployment', 'Service',
      'NetworkPolicy', 'NetworkPolicy', 'NetworkPolicy', 'Pod',
    ])
    expect(kubectlArgs()).toContainEqual([
      'rollout', 'status', `deployment/${projectRegistryName(ID)}`, '-n', 'test-ns', '--timeout=120s',
    ])
    // hosts.toml is written by a one-shot pod pinned to the node, not by
    // podman exec, since the server's engine need not host the node.
    const pod = applied<{ kind: string; spec: { nodeName: string; containers: Array<{ command: string[] }> } }>()
      .find((m) => m.kind === 'Pod')!
    expect(pod.spec.nodeName).toBe('yaac-control-plane')
    // nodeName skips the scheduler, but a NoExecute taint still evicts, so
    // without this a tainted node would get no hosts.toml and could not pull.
    expect((pod.spec as unknown as { tolerations: unknown }).tolerations)
      .toEqual([{ operator: 'Exists' }])
    const script = pod.spec.containers[0].command[2]
    expect(script).toContain(`http://10.96.0.50:${PROJECT_REGISTRY_PORT}`)
    expect(otherChildren()).toEqual([])
    // Leftover writer pods are swept by label first. The node-write label
    // keeps the sweep off the registry's own pod.
    expect(fakeCluster.callsOf('list', 'Pod')[0].labelSelector).toContain(`${LABEL_NODE_WRITE}=hosts`)
    // The uniquely named writer pod is deleted before and after it runs.
    const podDeletes = fakeCluster.callsOf('delete', 'Pod')
    expect(podDeletes).toHaveLength(2)
    for (const { name } of podDeletes) {
      expect(name).toMatch(new RegExp(`^${projectRegistryName(ID)}-hosts-0-[0-9a-f]{8}$`))
    }
    expect(fakeCluster.objects('Pod')).toEqual([])
    // The Service (and so its ClusterIP) is never deleted.
    expect(fakeCluster.callsOf('delete', 'Service')).toEqual([])
  })

  it('names every object after the project id, within the DNS-label cap', async () => {
    await ensureProjectRegistry(PROJECT)
    const objects = applied<{ kind: string; metadata: { name: string; labels: Record<string, string> } }>()
      .filter((m) => m.kind !== 'Pod')
    expect(objects.map((m) => m.kind).sort()).toEqual([
      'Deployment', 'NetworkPolicy', 'NetworkPolicy', 'NetworkPolicy',
      'PersistentVolumeClaim', 'Service',
    ])
    for (const { metadata } of objects) {
      expect(metadata.name.startsWith(`yaac-reg-${ID}`)).toBe(true)
      expect(metadata.name.length).toBeLessThanOrEqual(63)
      // Selectors and the orphan GC use the id; the slug is for humans.
      expect(metadata.labels).toMatchObject({ 'yaac.project-id': ID, 'yaac.project': 'demo' })
    }
  })

  it('leaves placement to the bound volume rather than pinning the Deployment', async () => {
    // The store lives on the claim. A bound volume carries its own node
    // affinity, which the scheduler enforces, so a hand-written pin could
    // only contradict it.
    await ensureProjectRegistry(PROJECT)

    const deploy = applied<{
        kind: string
        metadata: { annotations?: unknown }
        spec: { template: { spec: {
          affinity?: unknown
          nodeName?: unknown
          nodeSelector?: unknown
          tolerations?: unknown
          volumes: Array<{ persistentVolumeClaim?: { claimName: string } }>
        } } }
      }>()
      .find((m) => m.kind === 'Deployment')!
    expect(deploy.metadata.annotations).toBeUndefined()
    expect(deploy.spec.template.spec.affinity).toBeUndefined()
    expect(deploy.spec.template.spec.nodeName).toBeUndefined()
    expect(deploy.spec.template.spec.nodeSelector).toBeUndefined()
    expect(deploy.spec.template.spec.volumes[0].persistentVolumeClaim)
      .toEqual({ claimName: projectRegistryPvcName(ID) })

    // No tolerations keeps the registry off a tainted sessions pool (whose
    // toleration comes from the gvisor RuntimeClass, which this runc pod
    // does not use). With WaitForFirstConsumer the volume follows, so the
    // store stays off that pool for its whole life.
    expect(deploy.spec.template.spec.tolerations).toBeUndefined()

    const pvc = appliedKind('PersistentVolumeClaim') as {
      metadata: { name: string; namespace: string; labels: Record<string, string> }
      spec: Record<string, unknown>
    }
    expect(pvc.metadata.name).toBe(projectRegistryPvcName(ID))
    expect(pvc.metadata.namespace).toBe('test-ns')
    // The registry labels put the claim inside removeProjectRegistry's
    // selector delete; otherwise the blobs would leak.
    expect(pvc.metadata.labels).toMatchObject({
      app: REGISTRY_APP_LABEL, 'yaac.project-id': ID,
    })
    expect(pvc.spec).toEqual({
      // One replica + Recreate means one mounter, and RWO still lets the
      // GC pod mount it on the same node.
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: PROJECT_REGISTRY_STORAGE_SIZE } },
    })
    // Binds through the cluster's default class; naming one would break
    // clusters that lack it.
    expect(pvc.spec).not.toHaveProperty('storageClassName')
  })

  it('serializes concurrent ensures for one project', async () => {
    let releaseRollout!: () => void
    const gate = new Promise<void>((r) => { releaseRollout = r })
    let rollouts = 0
    mockChild.mockImplementation((_file, args) => {
      if (args[0] === 'rollout' && ++rollouts === 1) {
        return gate.then(() => ({ stdout: '', stderr: '' }))
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    })

    const first = ensureProjectRegistry(PROJECT)
    const second = ensureProjectRegistry(PROJECT)
    await new Promise((r) => setTimeout(r, 10))
    // While the first ensure waits on its rollout, only its six object
    // applies have happened; the second has not started.
    expect(applied()).toHaveLength(6)

    releaseRollout()
    await Promise.all([first, second])
    expect(applied()).toHaveLength(14)
  })

  it('surfaces a failed writer pod with its logs (session create must not proceed)', async () => {
    fakeCluster.reset()
    stageLiveCluster('Failed', 'read-only file system\n')

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
    // A rolling update would race two pods on one store, and could
    // deadlock on an RWO volume across nodes.
    expect(dep.spec.strategy).toEqual({ type: 'Recreate' })
    expect(dep.spec.selector.matchLabels)
      .toEqual({ app: REGISTRY_APP_LABEL, 'yaac.project-id': ID })
    const pod = dep.spec.template.spec
    // Trusted infra running only the pinned registry image: no SA token,
    // no service links, runc rather than gVisor.
    expect(pod.automountServiceAccountToken).toBe(false)
    expect(pod.enableServiceLinks).toBe(false)
    expect(pod.runtimeClassName).toBeUndefined()
    // Workspaces pull from here, so it outranks them under node pressure.
    expect(pod.priorityClassName).toBe('yaac-infra')
    expect(pod.hostUsers).toBeUndefined()
    expect(pod.securityContext).toBeUndefined()
    expect(pod.containers[0].image).toMatch(/^localhost:5001\/yaac-registry2:/)
    expect(pod.containers[0].ports).toEqual([{ containerPort: PROJECT_REGISTRY_PORT }])
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

    // Only this project's workspaces may reach its registry. Selected by
    // id, so a later project with the same slug is not admitted.
    const sessions = nps.find((m) => m.metadata.name === `${name}-sessions`)!
    expect(sessions.spec.podSelector.matchLabels).toEqual({ 'yaac.project-id': ID })
    expect(sessions.spec.policyTypes).toEqual(['Egress'])

    // Ingress admits same-project workspaces and the node (containerd
    // pulls), the node by address.
    const ingress = nps.find((m) => m.metadata.name === `${name}-ingress`)!
    expect(ingress.spec.policyTypes).toEqual(['Ingress'])
    const node = ingress.spec.ingress!.find((r) => JSON.stringify(r.from).includes(NODE_IP))
    expect(node?.ports).toEqual([{ protocol: 'TCP', port: PROJECT_REGISTRY_PORT }])

    const egress = nps.find((m) => m.metadata.name === `${name}-egress`)!
    expect(egress.spec.policyTypes).toEqual(['Egress'])
    expect(egress.spec.egress).toEqual([])
  })

  it('takes the registry image from the local registry, never the host engine', async () => {
    // `yaac cluster install` mirrors the image. The server has no container
    // engine, so it only looks the mirror tag up.
    mockHasTag.mockResolvedValue(true)
    await ensureProjectRegistry(PROJECT)
    expect(REGISTRY_UPSTREAM_IMAGE).toBe(`docker.io/library/registry@${REGISTRY_IMAGE_DIGEST}`)
    expect(otherChildren()).toEqual([])
    expect(mockPush).not.toHaveBeenCalled()

    vi.clearAllMocks()
    fakeCluster.reset()
    stageLiveCluster()
    mockHasTag.mockResolvedValue(false)
    mockImageExists.mockResolvedValue(false)
    await expect(ensureProjectRegistry(PROJECT))
      .rejects.toThrow(/Registry image .* is missing.*yaac cluster install/s)
    expect(otherChildren()).toEqual([])
  })

  it('names the PVC when the rollout times out', async () => {
    // Workspace create is where a storage misconfiguration shows up first,
    // and kubectl's timeout text does not mention the unbindable claim.
    mockChild.mockImplementation((_file, args) => (
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
    expect(otherChildren()).toEqual([])
    vi.unstubAllEnvs()
  })
})

describe('removeProjectRegistry', () => {
  it('deletes every object of the project\'s registry in this install, and nothing else', async () => {
    const OTHER = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d'
    const objects = (id: string) => ([
      ['apps/v1', 'Deployment'], ['v1', 'Service'], ['networking.k8s.io/v1', 'NetworkPolicy'],
      ['v1', 'PersistentVolumeClaim'], ['v1', 'Pod'],
    ] as const).map(([apiVersion, kind]) => ({
      apiVersion, kind, metadata: { name: `yaac-reg-${id}`, namespace: 'test-ns', labels: registryLabels(id) },
    }))
    fakeCluster.seed(...objects(ID), ...objects(OTHER))
    await removeProjectRegistry(ID)
    // Deleting the claim reclaims the blobs; `Pod` sweeps leftover writer
    // and collect pods.
    expect(fakeCluster.objects().map((o) => o.metadata.labels?.['yaac.project-id'])).toEqual(Array(5).fill(OTHER))
    expect(fakeCluster.callsOf('list').every((c) => c.labelSelector === registrySelector(ID))).toBe(true)
    expect(applied()).toEqual([])
  })
})

describe('gcOrphanProjectRegistries', () => {
  const LIVE = '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9'
  const GONE = 'c9d8e7f6-a5b4-4c3d-8e2f-1a0b9c8d7e6f'
  const NOW = Date.parse('2026-09-29T12:00:00Z')
  const OLD = new Date(NOW - ORPHAN_REGISTRY_MIN_AGE_MS - 1).toISOString()

  /** The project ids whose registry objects remain. */
  const remaining = (): string[] =>
    [...new Set(fakeCluster.objects().map((o) => o.metadata.labels?.['yaac.project-id'] ?? ''))].sort()

  const API_VERSION: Record<string, string> = { Deployment: 'apps/v1', Service: 'v1', PersistentVolumeClaim: 'v1' }
  function stageRegistries(items: Array<{ kind: string; metadata: Record<string, unknown> }>): void {
    fakeCluster.seed(...items.map((item) => ({
      apiVersion: API_VERSION[item.kind], ...item, metadata: { namespace: 'test-ns', ...item.metadata },
    })) as never[])
  }

  it('removes registries no live project id owns, keeping the rest', async () => {
    const labelled = (id: string, slug: string): Record<string, string> => registryLabels(id, slug)
    stageRegistries([
      // A live project's registry, in every kind it is made of.
      { kind: 'Service', metadata: { name: `yaac-reg-${LIVE}`, labels: labelled(LIVE, 'app'), creationTimestamp: OLD } },
      { kind: 'PersistentVolumeClaim', metadata: { name: `yaac-reg-${LIVE}-storage`, labels: labelled(LIVE, 'app'), creationTimestamp: OLD } },
      // A removed project's.
      { kind: 'PersistentVolumeClaim', metadata: { name: `yaac-reg-${GONE}-storage`, labels: labelled(GONE, 'app'), creationTimestamp: OLD } },
      { kind: 'Deployment', metadata: { name: `yaac-reg-${GONE}`, labels: labelled(GONE, 'app'), creationTimestamp: OLD } },
      // Too young: a project added after the live set was read may be
      // creating it right now.
      { kind: 'Service', metadata: { name: 'yaac-reg-new', labels: labelled('5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9', 'new'), creationTimestamp: new Date(NOW - 1000).toISOString() } },
      // An unreadable age is never old enough to delete.
      { kind: 'Service', metadata: { name: 'yaac-reg-ageless', labels: labelled('6f7a8b9c-0d1e-4f2a-b3c4-d5e6f7a8b9c0', 'ageless'), creationTimestamp: '' } },
    ])

    await gcOrphanProjectRegistries(new Set([LIVE]), NOW)

    expect(remaining()).toEqual([LIVE, '5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9', '6f7a8b9c-0d1e-4f2a-b3c4-d5e6f7a8b9c0'].sort())
    // Only this install's registries are listed.
    const installSelector = `app=${REGISTRY_APP_LABEL},${LABEL_REGISTRY_DATA_DIR_HASH}=${dataDirHash()}`
    expect(fakeCluster.callsOf('list').filter((c) => c.kind !== 'Pod' && c.labelSelector === installSelector)
      .map((c) => c.kind).sort()).toEqual(['Deployment', 'PersistentVolumeClaim', 'Service'])
  })

  it('tolerates an unreachable cluster', async () => {
    fakeCluster.intercept(() => { throw new Error('connection refused') })
    await expect(gcOrphanProjectRegistries(new Set(), NOW)).resolves.toBeUndefined()
    expect(fakeCluster.callsOf('delete')).toEqual([])
  })
})

describe('reconcileProjectRegistryGc', () => {
  /** One registry Service created at `createdMs`, and a GC pod ending in `podPhase`. */
  function oneRegistry(createdMs: number | null = 0, podPhase = 'Succeeded'): void {
    stageLiveCluster(podPhase)
    fakeCluster.seed({
      apiVersion: 'v1', kind: 'Service',
      metadata: {
        name: projectRegistryName(ID), namespace: 'test-ns', labels: registryLabels(ID),
        creationTimestamp: createdMs === null ? '' : new Date(createdMs).toISOString(),
      },
    })
  }
  /** A `now` at which the epoch-created registry above is collectable. */
  const DUE = REGISTRY_GC_INTERVAL_MS + 1_000
  /** Whether each applied registry Deployment was the read-only one. */
  const rollouts = (): boolean[] => applied<{ kind: string; spec?: { template?: { spec?: { containers?: Array<
      { env?: Array<{ name: string }> }> } } } }>()
    .filter((m) => m.kind === 'Deployment')
    .map((m) => (m.spec?.template?.spec?.containers?.[0]?.env ?? [])
      .some((e) => e.name === 'REGISTRY_STORAGE_MAINTENANCE_READONLY'))

  beforeEach(() => {
    _resetRegistryGcForTests()
  })

  /** The step does not wait for its GC, so tests await it explicitly. */
  const LIVE = new Set([ID])
  const gcPass = async (now: number): Promise<void> => {
    await reconcileProjectRegistryGc(LIVE, now)
    await _registryGcSettledForTests()
  }

  // A dead project's registry belongs to the orphan sweep; a GC racing it
  // would re-apply the Deployment with no PVC behind it.
  it('never collects a registry whose project id is not live', async () => {
    oneRegistry()
    await reconcileProjectRegistryGc(new Set(), DUE)
    await _registryGcSettledForTests()
    expect(applied()).toEqual([])
  })

  it('collects behind a read-only window, then restores serving mode', async () => {
    oneRegistry()
    await gcPass(DUE)

    // Read-only mode rather than scaling to zero, so pulls keep working.
    expect(rollouts()).toEqual([true, false])
    expect(kubectlArgs().filter((a) => a[0] === 'scale')).toEqual([])
    // A collect pod a crashed server left would hold the claim; it goes
    // before the read-only roll.
    const sweep = fakeCluster.calls.findIndex((c) =>
      c.verb === 'list' && c.labelSelector === `${registrySelector(ID)},${LABEL_NODE_WRITE}=gc`)
    expect(sweep).toBeGreaterThanOrEqual(0)
    expect(sweep).toBeLessThan(fakeCluster.calls.findIndex((c) => c.verb === 'apply' && c.kind === 'Deployment'))
    const pod = applied<{
      kind: string
      metadata: { name: string; labels: Record<string, string> }
      spec: {
        nodeName?: string
        affinity?: Record<string, unknown>
        containers: Array<{ image: string; command: string[] }>
        volumes: Array<{ persistentVolumeClaim?: { claimName: string } }>
      }
    }>().find((m) => m.kind === 'Pod' && m.metadata.name.includes('-gc-'))!
    expect(pod.spec.volumes[0].persistentVolumeClaim)
      .toEqual({ claimName: projectRegistryPvcName(ID) })
    // RWO is per node, so the GC pod must share the registry pod's node.
    // A network-attached PV carries no node affinity, so this is a required
    // podAffinity; otherwise a Multi-Attach error would surface only at
    // attach time.
    expect(pod.spec.nodeName).toBeUndefined()
    expect(pod.spec.affinity).toEqual({
      podAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: [{
          labelSelector: {
            matchLabels: {
              app: REGISTRY_APP_LABEL,
              'yaac.project': 'demo',
              'yaac.project-id': ID,
              [LABEL_REGISTRY_DATA_DIR_HASH]: dataDirHash(),
            },
            // Excludes one-shot pods, whose node says nothing about the volume.
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

    // Retention runs first, untagging old content-hash generations so the
    // GC can reclaim them.
    expect(script.indexOf('retired-generations'))
      .toBeLessThan(script.indexOf('garbage-collect'))
  })

  it('sends valid POSIX shell into the collect pod', async () => {
    oneRegistry()
    await gcPass(DUE)
    const script = (applied<{
      kind: string; metadata: { name: string }
      spec: { containers: Array<{ command: string[] }> }
    }>().find((m) => m.kind === 'Pod' && m.metadata.name.includes('-gc-'))!)
      .spec.containers[0].command[2]
    await expect(runSh('sh', ['-n', '-c', script])).resolves.toBeTruthy()
  })

  it('collects a project whose sessions are live — idleness is not required', async () => {
    oneRegistry()
    // Read-only mode makes a concurrent push safe; a push that gets a 405
    // is retried.
    await gcPass(DUE)
    expect(rollouts()).toEqual([true, false])
  })

  it('throttles to one collect per project per interval', async () => {
    oneRegistry()
    await gcPass(DUE)
    fakeCluster.calls = []
    await gcPass(DUE + REGISTRY_GC_INTERVAL_MS - 1)
    expect(rollouts()).toEqual([])
    await gcPass(DUE + REGISTRY_GC_INTERVAL_MS)
    expect(rollouts()).toEqual([true, false])
  })

  it('measures the throttle from the registry, not from this process', async () => {
    // A new registry has nothing to reclaim, and a GC would cost two
    // rollouts just as the new workspace uses it hardest. The throttle reads
    // the Service's age, so a server restart does not reset it.
    oneRegistry(DUE - 1)
    await gcPass(DUE)
    expect(rollouts()).toEqual([])

    // One interval later it is due.
    await gcPass(DUE + REGISTRY_GC_INTERVAL_MS - 1)
    expect(rollouts()).toEqual([true, false])
  })

  it('restores serving mode when the collect fails', async () => {
    oneRegistry(null, 'Failed')
    await gcPass(DUE)
    // A failed GC must not leave the registry read-only.
    expect(rollouts()).toEqual([true, false])
  })

  it('returns without waiting on the collect it starts', async () => {
    oneRegistry()
    // Reconcile steps run in sequence, so awaiting the GC would stall every
    // later step. Hold the first rollout open and check the step returned.
    let release = (): void => {}
    const held = new Promise<{ stdout: string; stderr: string }>((r) => {
      release = () => r({ stdout: '', stderr: '' })
    })
    mockChild.mockImplementation((_file, args) =>
      args[0] === 'rollout' ? held : Promise.resolve({ stdout: '', stderr: '' }))

    await reconcileProjectRegistryGc(LIVE, DUE)
    expect(rollouts()).not.toContain(false)

    release()
    await _registryGcSettledForTests()
  })

  it('tolerates an unreachable cluster', async () => {
    fakeCluster.intercept(() => { throw apiError(503) })
    await expect(reconcileProjectRegistryGc(LIVE, DUE)).resolves.toBeUndefined()
  })
})

describe('buildRegistryRetentionScript', () => {
  let storage: string
  const reposDir = (): string => path.join(storage, 'docker/registry/v2/repositories')
  const DAY_MS = 24 * 60 * 60_000

  /** A tag written `ageDays` ago. Retention orders by the tag dir's mtime. */
  async function pushTag(repoTag: string, ageDays: number): Promise<void> {
    const [repo, tag] = repoTag.split(':')
    const tagDir = path.join(reposDir(), repo, '_manifests/tags', tag)
    await fs.mkdir(path.join(tagDir, 'current'), { recursive: true })
    const when = new Date(Date.now() - ageDays * DAY_MS)
    await fs.utimes(tagDir, when, when)
  }

  /** Run the script as the GC pod would, against the temp store. */
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
    // Oldest last, then the count the GC pod logs.
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
