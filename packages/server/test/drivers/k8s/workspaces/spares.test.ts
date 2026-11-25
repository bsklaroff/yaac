/**
 * Spare workspace pods (docs/generic-workspace-pods.md "Pool policy"): the
 * cluster, the registry and mountd's HTTP API are the boundaries,
 * so each manifest is built and each take is decided for real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { apiError, fakeCluster } from '@yaac/test-utils/k8s-stub'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { globalPath } from '@yaac/shared/paths'
import { fakeRegistry } from '#test/support/fake-registry'
import { fakeMountd } from '#test/drivers/k8s/fake-mountd'

vi.hoisted(() => { process.env.YAAC_BUILD_ID = 'build-1' })

import { keepReadyTrees, listSpares, reapSpare, reconcileHelpersGc, takeSpare, warmSpare } from '#drivers/k8s/workspaces'
import { PROXY_AUTH_SECRET_NAME, installId, k8sNamespace, nodeMountsNodePath } from '#drivers/k8s/substrate'
import { resetProxyClusterIpCache } from '#drivers/k8s/cluster'
import type { WorkspaceResources } from '#drivers/contract'

const GiB = 1024 ** 3
const IMAGE = 'registry.local/yaac-project:abc'
const SCRATCH = 32 * GiB
const AUTH_SECRET = 'relay-secret'
const RESOURCES: WorkspaceResources = {
  memoryRequestBytes: 2 * GiB, memoryLimitBytes: 8 * GiB,
  cpuRequestMillis: 1000, cpuLimitMillis: 4000,
  ephemeralStorageRequestBytes: 2 * GiB, ephemeralStorageLimitBytes: 16 * GiB,
}

let dataDir: string

beforeEach(async () => {
  dataDir = await createTempDataDir()
  resetProxyClusterIpCache()
  fakeRegistry.install()
  fakeCluster.seed(
    { apiVersion: 'v1', kind: 'Service', metadata: { name: 'yaac-proxy', namespace: k8sNamespace() }, spec: { clusterIP: '10.96.0.5' } },
    {
      apiVersion: 'v1', kind: 'Secret', metadata: { name: PROXY_AUTH_SECRET_NAME, namespace: k8sNamespace() },
      data: { secret: Buffer.from(AUTH_SECRET).toString('base64') },
    },
  )
  await fakeMountd.install(['n1', 'n2'])
  await fakeMountd.settle(['n1', 'n2'])
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  await cleanupTempDir(dataDir)
})

interface SpareOpts {
  /** Null for a pod not scheduled yet. */
  node?: string | null
  image?: string
  scratchBytes?: number
  /** Seconds after a fixed epoch, so "newest" is explicit. */
  created?: number
  ready?: boolean
  phase?: string
  prewarmed?: boolean
  project?: string
  deleting?: boolean
  install?: string
  helpers?: string
}

const at = (seconds: number): string => new Date(Date.UTC(2026, 10, 1) + seconds * 1000).toISOString()

function spareLabels(id: string, o: SpareOpts): Record<string, string> {
  return {
    'yaac.workspace-id': id,
    'yaac.install-id': o.install ?? installId(),
    ...(o.prewarmed !== false ? { 'yaac.prewarmed': 'true' } : {}),
    ...(o.project !== undefined ? { 'yaac.project-id': o.project } : {}),
  }
}

function sparePod(id: string, o: SpareOpts = {}): Parameters<typeof fakeCluster.seed>[0] {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `yaac-${id}-x`,
      namespace: k8sNamespace(),
      labels: { ...spareLabels(id, o), 'batch.kubernetes.io/job-name': `yaac-${id}` },
      annotations: { 'yaac.scratch-bytes': String(o.scratchBytes ?? SCRATCH) },
      creationTimestamp: at(o.created ?? 0),
      ...(o.deleting === true ? { deletionTimestamp: at(1000) } : {}),
    },
    spec: {
      ...(o.node !== null ? { nodeName: o.node ?? 'n1' } : {}),
      containers: [{
        name: 'workspace',
        image: o.image ?? IMAGE,
        volumeMounts: [{ name: 'helpers', mountPath: '/opt/yaac/helpers', subPath: `run/helpers/${o.helpers ?? 'build-1'}` }],
      }],
      volumes: [{ name: 'node-mounts', hostPath: { path: `${nodeMountsNodePath()}/${id}.0a0b0c0d` } }],
    },
    status: {
      phase: o.phase ?? 'Running',
      conditions: [{ type: 'Ready', status: o.ready === false ? 'False' : 'True' }],
    },
  }
}

function spareJob(id: string, o: SpareOpts = {}): Parameters<typeof fakeCluster.seed>[0] {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: `yaac-${id}`, namespace: k8sNamespace(), labels: spareLabels(id, o), creationTimestamp: at(o.created ?? 0) },
  }
}

/** A spare's Job and pod. */
function seedSpare(id: string, o: SpareOpts = {}): void {
  fakeCluster.seed(spareJob(id, o), sparePod(id, o))
}

const podLabels = (id: string): Record<string, string> | undefined =>
  fakeCluster.get<{ metadata: { labels: Record<string, string> } }>('Pod', `yaac-${id}-x`)?.metadata.labels

describe('listSpares', () => {
  it('lists this install\'s spares and dead servers\' takes, marking the ones that will never be ready', async () => {
    seedSpare('up', { created: 10 })
    seedSpare('booting', { ready: false, phase: 'Pending', node: null, created: 20 })
    seedSpare('ended', { phase: 'Failed', ready: false })
    seedSpare('going', { deleting: true })
    // A take no launch adopted: neither the spare label nor a project.
    seedSpare('orphan', { prewarmed: false })
    // A spare Job whose pod is gone, for the pool to reap, and one whose pod
    // the Job controller has yet to make.
    fakeCluster.seed(spareJob('podless', { created: 30 }))
    fakeCluster.seed(spareJob('unmade', { created: 100 }))
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse(at(130)))
    // An older server's per-project spare names its project.
    seedSpare('older-server', { project: 'p1', created: 5 })
    // A workspace, and another install's spare, are neither.
    seedSpare('workspace', { prewarmed: false, project: 'p1' })
    seedSpare('foreign', { install: 'other-install' })

    const byId = Object.fromEntries((await listSpares()).map((s) => [s.workspaceId, s]))
    expect(Object.keys(byId).sort()).toEqual(['booting', 'ended', 'going', 'older-server', 'orphan', 'podless', 'unmade', 'up'])
    expect(byId['older-server']).toMatchObject({ projectId: 'p1', ready: false, failed: false, orphaned: false })
    expect(byId.up).not.toHaveProperty('projectId')
    expect(byId.unmade).toMatchObject({ ready: false, failed: false, pending: true })
    expect(byId.podless).not.toHaveProperty('pending')
    expect(byId.up).toEqual({
      workspaceId: 'up', jobName: 'yaac-up', image: IMAGE, scratchBytes: SCRATCH, node: 'n1',
      createdAtMs: Date.parse(at(10)), ready: true, failed: false, orphaned: false,
    })
    expect(byId.booting).toMatchObject({ ready: false, failed: false, orphaned: false })
    expect(byId.booting).not.toHaveProperty('node')
    expect(byId.ended).toMatchObject({ ready: false, failed: true })
    expect(byId.going).toMatchObject({ ready: false, failed: true })
    expect(byId.orphan).toMatchObject({ orphaned: true })
    expect(byId.podless).toEqual({
      workspaceId: 'podless', jobName: 'yaac-podless', image: '', scratchBytes: 0,
      createdAtMs: Date.parse(at(30)), ready: false, failed: true, orphaned: false,
    })
  })
})

describe('warmSpare', () => {
  it('starts a pod of no project on the ready nodes, reserving a workspace\'s memory but little CPU', async () => {
    const id = await warmSpare({ image: IMAGE, scratchBytes: 8 * GiB, resources: RESOURCES })
    expect(id).toMatch(/^[0-9a-f-]{36}$/)

    const [apply] = fakeCluster.callsOf('apply', 'Job')
    const job = apply.body as {
      metadata: { name: string; labels: Record<string, string> }
      spec: { template: { metadata: { annotations: Record<string, string> }; spec: {
        affinity: unknown
        initContainers: Array<{ name: string; image: string }>
        containers: Array<{ image: string; env: Array<{ name: string; value: string }>; resources: unknown; volumeMounts: Array<{ name: string; subPath?: string }> }>
        volumes: Array<{ name: string; hostPath?: { path: string } }>
      } } }
    }
    expect(job.metadata.name).toBe(`yaac-${id}`)
    // No project label, so no workspace listing sees it.
    expect(job.metadata.labels).toEqual({ 'yaac.workspace-id': id, 'yaac.install-id': installId(), 'yaac.prewarmed': 'true' })
    const pod = job.spec.template.spec
    const [workspace] = pod.containers
    expect(workspace.image).toBe(IMAGE)
    expect(workspace.resources).toMatchObject({
      requests: { cpu: '100m', memory: String(2 * GiB) },
      limits: { cpu: '4000m', memory: String(8 * GiB) },
    })
    expect(job.spec.template.metadata.annotations['yaac.scratch-bytes']).toBe(String(8 * GiB))
    // One term per node: the apiserver takes one value per node-name selector.
    expect(JSON.stringify(pod.affinity)).toContain('"nodeSelectorTerms":[{"matchFields":[{"key":"metadata.name","operator":"In","values":["n1"]}]},'
      + '{"matchFields":[{"key":"metadata.name","operator":"In","values":["n2"]}]}]')
    // Its id is the workspace's, so the stream token is right from creation.
    const env = Object.fromEntries(workspace.env.map((e) => [e.name, e.value]))
    expect(env.YAAC_WORKSPACE_ID).toBe(id)
    expect(env.YAAC_STREAM_TOKEN).toBe(crypto.createHmac('sha256', AUTH_SECRET).update(id).digest('hex'))
    expect(env.GIT_SSH_COMMAND).toContain('ProxyCommand=')
    // This build's helpers, a node-mounts dir of its own, and a tree
    // container on the yaac base image.
    expect(workspace.volumeMounts).toContainEqual(expect.objectContaining({ name: 'helpers', subPath: 'run/helpers/build-1' }))
    expect(pod.volumes.find((v) => v.name === 'node-mounts')?.hostPath?.path)
      .toMatch(new RegExp(`^${nodeMountsNodePath()}/${id}\\.[0-9a-f]{8}$`))
    expect(pod.initContainers.map((c) => c.name)).toEqual(['tree'])
    expect(pod.initContainers[0].image).toMatch(/-base:[0-9a-f]+$/)
  })

  it('refuses while no mountd is ready, since nothing could claim the spare', async () => {
    await fakeMountd.install(['n1'])
    fakeMountd.reports.set('n1', await fakeMountd.goodReport({ arborist: false }))
    await fakeMountd.settle([])
    await expect(warmSpare({ image: IMAGE, scratchBytes: SCRATCH, resources: RESOURCES })).rejects.toThrow(/no mountd is ready/)
    expect(fakeCluster.callsOf('apply')).toEqual([])
  })
})

describe('takeSpare', () => {
  beforeEach(() => {
    seedSpare('older', { created: 10 })
    seedSpare('newer', { created: 20 })
    // Newer still, but none can be taken.
    seedSpare('other-image', { image: 'registry.local/yaac-other:abc', created: 30 })
    seedSpare('other-size', { scratchBytes: 8 * GiB, created: 30 })
    seedSpare('unready-node', { node: 'n3', created: 30 })
    seedSpare('booting', { ready: false, created: 30 })
  })

  // A take this process holds outlives the test; reaping is how a start
  // that never launched gives it back.
  afterEach(async () => {
    await reapSpare('newer')
    await reapSpare('older')
  })

  it('takes the newest ready spare of the image and size on a ready node, by removing its spare label', async () => {
    // None made since a later start: an earlier server's carries its build.
    await expect(takeSpare({ image: IMAGE, scratchBytes: SCRATCH, madeSince: Date.parse(at(1000)) })).resolves.toBeUndefined()
    await expect(takeSpare({ image: IMAGE, scratchBytes: SCRATCH, madeSince: 0 })).resolves.toBe('newer')
    expect(podLabels('newer')).not.toHaveProperty('yaac.prewarmed')
    // A take lists as neither a spare nor a dead server's take.
    expect((await listSpares()).map((s) => s.workspaceId)).not.toContain('newer')

    await expect(takeSpare({ image: IMAGE, scratchBytes: SCRATCH, madeSince: 0 })).resolves.toBe('older')
    await expect(takeSpare({ image: IMAGE, scratchBytes: SCRATCH, madeSince: 0 })).resolves.toBeUndefined()
    expect(podLabels('other-image')).toHaveProperty('yaac.prewarmed', 'true')
  })

  it('moves on to the next spare when a concurrent take wins the conditional removal', async () => {
    let raced = false
    fakeCluster.intercept((c) => {
      if (c.verb === 'patch' && c.name === 'yaac-newer-x' && !raced) {
        raced = true
        // Another server's take lands first.
        fakeCluster.seed(sparePod('newer', { created: 20, prewarmed: false }))
      }
    })
    await expect(takeSpare({ image: IMAGE, scratchBytes: SCRATCH, madeSince: 0 })).resolves.toBe('older')
    expect(raced).toBe(true)
    // The loser listed the winner's take as its own, never.
    expect((await listSpares()).find((s) => s.workspaceId === 'newer')).toMatchObject({ orphaned: true })
  })
})

describe('reapSpare', () => {
  it('deletes a spare\'s Job, and forgets a take no launch adopted', async () => {
    seedSpare('s1')
    await expect(takeSpare({ image: IMAGE, scratchBytes: SCRATCH, madeSince: 0 })).resolves.toBe('s1')
    await reapSpare('s1')
    expect(fakeCluster.get('Job', 'yaac-s1')).toBeUndefined()
    // Until the pod follows its Job, it is a take nobody holds.
    expect((await listSpares()).find((s) => s.workspaceId === 's1')).toMatchObject({ orphaned: true })
    // One already gone is no error.
    await expect(reapSpare('s1')).resolves.toBeUndefined()
  })

  it('reaps a spare only while it is one, when asked to, so a take that lands first keeps it', async () => {
    seedSpare('s1')
    await reapSpare('s1', { ifSpare: true })
    expect(fakeCluster.get('Job', 'yaac-s1')).toBeUndefined()

    seedSpare('s2')
    await expect(takeSpare({ image: IMAGE, scratchBytes: SCRATCH, madeSince: 0 })).resolves.toBe('s2')
    await reapSpare('s2', { ifSpare: true })
    expect(fakeCluster.get('Job', 'yaac-s2')).toBeDefined()

    // Another server's take lands between the listing and the reap.
    seedSpare('s3')
    fakeCluster.intercept((c) => {
      if (c.verb === 'patch' && c.name === 'yaac-s3-x') fakeCluster.seed(sparePod('s3', { prewarmed: false }))
    })
    await reapSpare('s3', { ifSpare: true })
    expect(fakeCluster.get('Job', 'yaac-s3')).toBeDefined()
    await reapSpare('s2')
  })

  it('propagates a failed delete', async () => {
    seedSpare('s1')
    fakeCluster.intercept((c) => { if (c.verb === 'delete') throw apiError(403, 'forbidden') })
    await expect(reapSpare('s1')).rejects.toThrow(/forbidden/)
  })
})

describe('keepReadyTrees', () => {
  it('sends the trees to each node holding a spare above the warn floor, and none to the others', async () => {
    await fakeMountd.install(['n1', 'n2', 'n3', 'n4'])
    // Above the stop floor, so it takes starts, but under the warn floor.
    fakeMountd.reports.set('n3', await fakeMountd.goodReport({ freeBytes: 8 * GiB }))
    await fakeMountd.settle(['n1', 'n2', 'n3', 'n4'])
    seedSpare('on-n1', { node: 'n1' })
    seedSpare('ended-on-n2', { node: 'n2', phase: 'Failed' })
    seedSpare('on-n3', { node: 'n3' })
    // One node's refusal is only logged.
    fakeMountd.refusals.set('n4 PUT /ready', 'arborist down')

    await keepReadyTrees([{ repoId: 'r1', commit: 'c1' }, { repoId: 'r2', commit: 'c2' }])
    const want = Object.fromEntries(fakeMountd.sent('/ready').map((r) => [r.node, (r.body as { want: unknown }).want]))
    expect(want).toEqual({
      n1: [{ repo: 'r1', commit: 'c1' }, { repo: 'r2', commit: 'c2' }],
      n2: [],
      n3: [],
      n4: [],
    })
  })
})

describe('reconcileHelpersGc', () => {
  const helpersRoot = (): string => globalPath('run', 'helpers')

  beforeEach(async () => {
    for (const build of ['build-1', 'build-0', 'build-old', 'build-2.tmp-abc']) {
      await fs.mkdir(path.join(helpersRoot(), build, 'bin'), { recursive: true })
    }
    // A running workspace made by an older build, and a spare of another
    // install, which reaches no folder of this one.
    seedSpare('w1', { prewarmed: false, project: 'p1', helpers: 'build-0' })
    seedSpare('foreign', { install: 'other-install', helpers: 'build-old' })
  })

  it('removes another build\'s helpers once no pod of this install mounts them, keeping this build\'s and any being staged', async () => {
    await reconcileHelpersGc()
    expect((await fs.readdir(helpersRoot())).sort()).toEqual(['build-0', 'build-1', 'build-2.tmp-abc'])
  })

  it('removes nothing when it cannot tell which pods mount what', async () => {
    fakeCluster.intercept((c) => { if (c.verb === 'list') throw apiError(403, 'forbidden') })
    await expect(reconcileHelpersGc()).rejects.toThrow(/forbidden/)
    expect((await fs.readdir(helpersRoot())).sort()).toEqual(['build-0', 'build-1', 'build-2.tmp-abc', 'build-old'])
  })
})
