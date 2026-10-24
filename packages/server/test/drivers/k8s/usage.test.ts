/**
 * `k8sUsage` against `fakeCluster`, seeded with nodes, the install's pods
 * and claims, and a kubelet Summary per node, as the API server would
 * answer them.
 */
import { describe, it, expect, vi } from 'vitest'
import { apiError, fakeCluster } from '@yaac/test-utils/k8s-stub'
import type * as fsPromises from 'node:fs/promises'

// The server's own mount of the global claim, which it `statfs`es when the
// kubelet reports no usage for it. Nothing else is mounted here.
const GLOBAL_MOUNT = vi.hoisted(() => '/yaac/global')
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof fsPromises>(),
  statfs: (dir: string) => dir === GLOBAL_MOUNT
    ? Promise.resolve({ blocks: 100, bfree: 40, bsize: 2 ** 30 })
    : Promise.reject(Object.assign(new Error(`ENOENT: ${dir}`), { code: 'ENOENT' })),
}))
import { k8sUsage } from '#drivers/k8s/usage'
import { POD_GLOBAL_ROOT, k8sNamespace } from '#drivers/k8s/substrate'

const GIB = 2 ** 30
const MIB = 2 ** 20
const PROJECT = '5e1f0c2a-7b3d-4e8f-9a6c-0d1e2f3a4b5c'
const WORKSPACE = '6f2a1d3b-8c4e-4f9a-8b7d-1e2f3a4b5c6d'
const summaryPath = (node: string) => `/api/v1/nodes/${node}/proxy/stats/summary`

function node(
  name: string,
  labels: Record<string, string>,
  extra: { taints?: object[]; pressure?: boolean; notReady?: boolean } = {},
) {
  return {
    apiVersion: 'v1',
    kind: 'Node',
    metadata: { name, labels },
    spec: { taints: extra.taints ?? [] },
    status: {
      capacity: { cpu: '8', memory: '16Gi' },
      allocatable: { cpu: '7500m', memory: '15Gi' },
      conditions: [
        { type: 'Ready', status: extra.notReady ? 'Unknown' : 'True' },
        { type: 'MemoryPressure', status: extra.pressure ? 'True' : 'False' },
      ],
    },
  }
}

function pod(
  name: string,
  labels: Record<string, string>,
  spec: { claims?: string[]; memoryLimit?: string; requests?: { cpu: string; memory: string }; node?: string } = {},
  namespace = k8sNamespace(),
) {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace, labels },
    spec: {
      nodeName: spec.node ?? 'node-a',
      containers: [{
        resources: {
          ...(spec.requests ? { requests: spec.requests } : {}),
          ...(spec.memoryLimit ? { limits: { memory: spec.memoryLimit } } : {}),
        },
      }],
      volumes: (spec.claims ?? []).map((claimName) => ({ name: claimName, persistentVolumeClaim: { claimName } })),
    },
    status: { phase: 'Running' },
  }
}

function pvc(name: string, storage: string) {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name, namespace: k8sNamespace() },
    status: { capacity: { storage } },
  }
}

/** A pod's Summary entry: its pod cgroup, and one container, using
 *  `cores` and `mib`. */
function podStats(name: string, cores: number, mib: number, extra: object = {}, namespace = k8sNamespace()) {
  const use = { cpu: { usageNanoCores: cores * 1e9 }, memory: { workingSetBytes: mib * MIB } }
  return { podRef: { name, namespace }, ...use, containers: [use], ...extra }
}

function seed(): void {
  fakeCluster.seed(
    node('node-a', { 'yaac.gvisor': 'true' }, { pressure: true }),
    node('node-b', { 'yaac.gvisor': 'true' }, { taints: [{ key: 'yaac.workspaces', value: 'true', effect: 'NoSchedule' }] }),
    node('node-c', { 'yaac.workspaces': 'false' }),
    // Gone (powered off, partitioned): its kubelet must not be waited on.
    node('node-d', { 'yaac.gvisor': 'true' }, { notReady: true }),
    pod('server-1', { app: 'yaac-server' }, { claims: ['yaac-global', 'yaac-server-local'], requests: { cpu: '250m', memory: '512Mi' } }),
    pod('registry-1', { app: 'yaac-main-registry' }, { claims: ['yaac-registry-storage'] }),
    pod('reg-proj-1', { app: 'yaac-registry', 'yaac.project-id': PROJECT }, { claims: ['yaac-reg-storage'] }),
    pod('netd-a', { app: 'yaac-netd' }),
    pod('netd-b', { app: 'yaac-netd' }, { node: 'node-b' }),
    pod('builder-1', { 'yaac.role': 'builder' }),
    pod('gc-1', { app: 'yaac-node-image-gc' }),
    // A finished one-shot is not running, so not counted.
    { ...pod('gc-0', { app: 'yaac-node-image-gc' }), status: { phase: 'Succeeded' } },
    pod('ws-1', { 'yaac.workspace-id': WORKSPACE }, {
      claims: ['yaac-global', 'yaac-checkouts'], memoryLimit: '8Gi', requests: { cpu: '1', memory: '2Gi' }, node: 'node-b',
    }),
    pod('spare-1', { 'yaac.workspace-id': 'spare', 'yaac.prewarmed': 'true' }, { node: 'node-b' }),
    pod('coredns', { 'k8s-app': 'kube-dns' }, { requests: { cpu: '100m', memory: '70Mi' } }, 'kube-system'),
    pvc('yaac-global', '1Gi'),
    pvc('yaac-checkouts', '1Gi'),
    pvc('yaac-server-local', '1Gi'),
    pvc('yaac-registry-storage', '100Gi'),
    pvc('yaac-reg-storage', '50Gi'),
  )
  fakeCluster.paths.set(summaryPath('node-a'), {
    node: {
      cpu: { usageNanoCores: 3e9 },
      memory: { time: '2026-10-22T12:00:00Z', workingSetBytes: 6 * GIB },
      swap: { swapUsageBytes: GIB, swapAvailableBytes: 3 * GIB },
      fs: { usedBytes: 50 * GIB, capacityBytes: 100 * GIB, availableBytes: 50 * GIB },
      // The image store on the root filesystem: not a second meter.
      runtime: { imageFs: { usedBytes: 5 * GIB, capacityBytes: 100 * GIB, availableBytes: 50 * GIB } },
    },
    pods: [
      podStats('server-1', 0.5, 400),
      podStats('registry-1', 0.1, 100, {
        volume: [{ name: 'data', pvcRef: { name: 'yaac-registry-storage', namespace: k8sNamespace() }, usedBytes: 30 * GIB, capacityBytes: 100 * GIB }],
      }),
      podStats('reg-proj-1', 0.05, 50),
      podStats('netd-a', 0.1, 200),
      podStats('builder-1', 1, 1000),
      podStats('gc-1', 0, 10),
      podStats('coredns', 0.01, 20, {}, 'kube-system'),
    ],
  })
  fakeCluster.paths.set(summaryPath('node-b'), {
    node: {
      cpu: { usageNanoCores: 2e9 },
      memory: { time: '2026-10-22T12:00:05Z', workingSetBytes: 4 * GIB },
      swap: { swapUsageBytes: 0, swapAvailableBytes: 0 },
      fs: { usedBytes: 10 * GIB, capacityBytes: 100 * GIB, availableBytes: 90 * GIB },
      runtime: { imageFs: { usedBytes: 20 * GIB, capacityBytes: 200 * GIB, availableBytes: 180 * GIB } },
    },
    pods: [
      // Without the stats gate, a pod cAdvisor has not sampled yet reads 0
      // at the pod level, so its containers' sum stands in.
      podStats('netd-b', 0.1, 200, { memory: { workingSetBytes: 0 } }),
      // The container is gVisor's own count of the sandbox; the pod cgroup
      // adds the sentry and gofer and leaves out what is swapped. Its CPU
      // rate is the containers'.
      podStats('ws-1', 1.5, 2560, {
        'ephemeral-storage': { usedBytes: 2 * GIB },
        cpu: { usageNanoCores: 0 },
        containers: [{ cpu: { usageNanoCores: 1.5e9 }, memory: { workingSetBytes: 3072 * MIB } }],
      }),
      podStats('spare-1', 0.01, 300),
    ],
  })
  // The server's ClusterRole predates the nodes/proxy rule.
  fakeCluster.paths.set(summaryPath('node-c'), apiError(403, 'nodes "node-c" is forbidden'))
  fakeCluster.paths.set(summaryPath('node-d'), { node: { memory: { workingSetBytes: GIB } }, pods: [] })
}

describe('k8sUsage', () => {
  it('splits the cluster into nodes, yaac components and workspaces, each claim listed once', async () => {
    expect(POD_GLOBAL_ROOT).toBe(GLOBAL_MOUNT)
    seed()
    const usage = await k8sUsage({ full: true })

    expect(usage.nodes.map((n) => [n.name, n.role, n.conditions])).toEqual([
      ['node-a', 'both', ['MemoryPressure']],
      ['node-b', 'workspaces', []],
      ['node-c', 'infrastructure', []],
      ['node-d', 'both', ['NotReady']],
    ])
    expect(usage.nodes[0]).toMatchObject({
      cpuCores: 3, memoryBytes: 6 * GIB, swapBytes: GIB, cpuCapacityCores: 8, memoryCapacityBytes: 16 * GIB,
      swapCapacityBytes: 4 * GIB,
      sampledAt: Date.parse('2026-10-22T12:00:00Z'),
    })
    expect(usage.nodes[2].error).toMatch(/yaac cluster install/)
    expect(usage.nodes[3].error).toBe('NotReady; stats not read')
    expect(fakeCluster.pathGets.some((p) => p.startsWith(summaryPath('node-d')))).toBe(false)

    // Totals and capacity over the nodes that answered, so a missing node
    // never reads as an idle one; scheduling is from the objects alone.
    expect(usage.totals).toMatchObject({
      cpuCores: 5,
      memoryBytes: 10 * GIB,
      swapBytes: GIB,
      cpuCapacityCores: 16,
      memoryCapacityBytes: 32 * GIB,
      swapCapacityBytes: 4 * GIB,
      scheduled: {
        // Every running pod bound to a node, kube-system's included.
        cpuRequestCores: 1.35,
        cpuAllocatableCores: 30,
        memoryRequestBytes: 2 * GIB + 582 * MIB,
        memoryAllocatableBytes: 60 * GIB,
      },
    })
    expect(usage.totals.disks).toEqual([
      { name: 'node-a root', usedBytes: 50 * GIB, capacityBytes: 100 * GIB },
      { name: 'node-b root', usedBytes: 10 * GIB, capacityBytes: 100 * GIB },
      { name: 'node-b images', usedBytes: 20 * GIB, capacityBytes: 200 * GIB },
      // The checkouts claim is the global volume mounted again. Local-path
      // volumes report no usage: the server's own mount of the global one
      // is measured with statfs, and the rest show their capacity only.
      { name: 'yaac-global', usedBytes: 60 * GIB, capacityBytes: 100 * GIB },
      { name: 'yaac-server-local', usedBytes: null, capacityBytes: GIB },
      { name: 'yaac-registry-storage', usedBytes: 30 * GIB, capacityBytes: 100 * GIB },
      { name: 'yaac-reg-storage', usedBytes: null, capacityBytes: 50 * GIB },
    ])

    const byKey = Object.fromEntries(usage.components.map((c) => [c.key, c]))
    expect(Object.keys(byKey)).toEqual([
      'server', 'main-registry', 'project-registries', 'netd', 'builders', 'spares', 'maintenance', 'system',
    ])
    expect(byKey.server).toMatchObject({ cpuCores: 0.5, memoryBytes: 400 * MIB })
    // The workspace mounts the global claim too; the server lists it.
    expect(byKey.server.volumes.map((v) => v.name)).toEqual(['yaac-global', 'yaac-server-local'])
    expect(byKey['main-registry'].volumes).toEqual([
      { name: 'yaac-registry-storage', usedBytes: 30 * GIB, capacityBytes: 100 * GIB },
    ])
    expect(byKey['project-registries']).toMatchObject({ count: 1, memoryBytes: 50 * MIB, volumes: [] })
    expect(byKey['project-registries'].children).toEqual([{
      key: `project-registry:${PROJECT}`, label: PROJECT, projectId: PROJECT,
      cpuCores: 0.05, memoryBytes: 50 * MIB,
      volumes: [{ name: 'yaac-reg-storage', usedBytes: null, capacityBytes: 50 * GIB }],
    }])
    expect(byKey.netd).toMatchObject({ count: 2, memoryBytes: 400 * MIB })
    expect(byKey.builders).toMatchObject({ count: 1, cpuCores: 1 })
    expect(byKey.spares).toMatchObject({ count: 1, memoryBytes: 300 * MIB })
    expect(byKey.maintenance).toMatchObject({ count: 1, memoryBytes: 10 * MIB })
    // What the nodes use beyond yaac's pods, kube-system's among it.
    const yaacMib = 400 + 100 + 50 + 200 + 1000 + 10 + 200 + 2560 + 300
    expect(byKey.system.memoryBytes).toBe(10 * GIB - yaacMib * MIB)

    expect(usage.workspaces).toEqual({
      [WORKSPACE]: {
        cpuCores: 1.5,
        memoryBytes: 2560 * MIB,
        memoryLimitBytes: 8 * GIB,
        ephemeralStorageBytes: 2 * GIB,
        node: 'node-b',
      },
    })
  })

  it('takes the cheap read for the sampler: CPU and memory only, no claims or scheduling', async () => {
    seed()
    const usage = await k8sUsage({ full: false })
    expect(fakeCluster.pathGets).toContain(`${summaryPath('node-a')}?only_cpu_and_memory=true`)
    expect(fakeCluster.callsOf('list', 'PersistentVolumeClaim')).toEqual([])
    // One pod list, of the install namespace only.
    expect(fakeCluster.callsOf('list', 'Pod').map((c) => c.namespace)).toEqual([k8sNamespace()])
    expect(usage.totals.scheduled).toBeUndefined()
    expect(usage.totals.disks).toEqual([])
    expect(usage.workspaces[WORKSPACE].ephemeralStorageBytes).toBeNull()
  })
})
