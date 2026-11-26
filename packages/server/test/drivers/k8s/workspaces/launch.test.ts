/**
 * How the k8s driver starts a workspace (docs/generic-workspace-pods.md "A
 * claim"). The cluster, the registry, mountd's HTTP API and
 * streamd's claim call are the boundaries, so every manifest, patch and
 * request is built for real and asserted on as the outside world gets it.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { PROJECT_CONFIG_DEFAULTS } from '@yaac/test-utils/project-fixture'
import { apiError, fakeCluster } from '@yaac/test-utils/k8s-stub'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { fakeRegistry } from '#test/support/fake-registry'
import { fakeMountd } from '#test/drivers/k8s/fake-mountd'

vi.hoisted(() => { process.env.YAAC_BUILD_ID = 'build-1' })

// streamd is the process boundary of a claim: its request is what the
// workspace is told.
const mockPodClaim = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/substrate/stream-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof streamRelayModule>()),
  podClaim: mockPodClaim,
}))
// The pod's readiness is a watch of it.
vi.mock('#drivers/k8s/substrate/pod-wait', () => ({ waitForJobPodReady: vi.fn().mockResolvedValue(undefined) }))

import type * as streamRelayModule from '#drivers/k8s/substrate/stream-relay'
import { awaitWorkspaceReady, launchWorkspace, listSpares, prepareWorkspaceSubstrate, reapSpare, takeSpare } from '#drivers/k8s/workspaces'
import { PROXY_AUTH_SECRET_NAME, installId, k8sNamespace, nodeMountsNodePath } from '#drivers/k8s/substrate'
import { resolveMountdImageTag } from '#drivers/k8s/cluster'
import { UTILITY_MIRROR_TAG } from '#drivers/k8s/cluster/utility-image'
import { proxyClient } from '#drivers/k8s/egress'
import type { RuntimeHandle, SubstrateIntent, WorkspaceSpec, WorkspaceSubstrate, WorkspaceTree } from '#drivers/contract'
import { globalRoot, nodeLocalRoot } from '@yaac/shared/paths'
import { LIVES_DIR, START_FILE, type StartInstruction } from '@yaac/shared/tree-records'
import {
  claudeDir,
  opencodeDataDir,
  repoDir,
  secretKeyPath,
  workspaceCheckpointsDir,
  workspaceDir,
  workspaceTreeDir,
} from '@yaac/shared/project-paths'

const PROJECT_ID = '3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c'
const AUTH_SECRET = 'relay-secret'
const GiB = 1024 ** 3
const INTENT = {
  projectId: PROJECT_ID,
  workspaceId: 's1',
  owner: 'o',
  tool: 'claude' as const,
  config: PROJECT_CONFIG_DEFAULTS,
  allowlist: { hosts: [], defaults: true },
  proxySecretRules: {},
}

function specOf(substrate: WorkspaceSubstrate, overrides: Partial<WorkspaceSpec> = {}): WorkspaceSpec {
  return {
    projectId: PROJECT_ID,
    workspaceId: 's1',
    image: 'localhost:5000/img:tag',
    env: ['CALLER_SAID=yes'],
    secretEnvKeys: [],
    mounts: [],
    scratchDirs: [],
    scratchBytes: 8 * GiB,
    resources: {
      memoryRequestBytes: 1, memoryLimitBytes: 2,
      cpuRequestMillis: 3, cpuLimitMillis: 4,
      ephemeralStorageRequestBytes: 5, ephemeralStorageLimitBytes: 6,
    },
    cwd: '',
    gitCredentials: [],
    substrate,
    ...overrides,
  }
}

/** A life's tree for workspace `s1`, with a checkout at its root and one in `web`. */
function treeOf(over: Partial<WorkspaceTree> = {}): WorkspaceTree {
  return {
    life: 'L1',
    lifeDir: workspaceTreeDir(PROJECT_ID, 's1', 'L1'),
    checkpointsDir: workspaceCheckpointsDir(PROJECT_ID, 's1'),
    checkouts: [
      { id: 'r1', path: '', gitDir: path.join(workspaceDir(PROJECT_ID, 's1'), '.git') },
      { id: 'r2', path: 'web', gitDir: path.join(workspaceDir(PROJECT_ID, 's1'), 'git', 'r2') },
    ],
    mainClones: [repoDir('r1')],
    program: '/unused',
    restoring: false,
    ...over,
  }
}

/** The domain's start instruction for life `L1`, on the shared tier. */
async function writeStart(over: Partial<StartInstruction> | string = {}): Promise<void> {
  const file = path.join(workspaceCheckpointsDir(PROJECT_ID, 's1'), LIVES_DIR, 'L1', START_FILE)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, typeof over === 'string' ? over : JSON.stringify({
    version: 1, life: 'L1', uid: 1000, gid: 1000,
    // Listed innermost first: the bind builds the root's tree first.
    checkouts: [
      { id: 'r2', path: 'web', gitDir: '/git/r2', commit: 'c2', kept: [] },
      { id: 'r1', path: '', gitDir: '/git/r1', commit: 'c1', kept: [] },
    ],
    excluded: ['node_modules'],
    ...over,
  }))
}

/** A running workspace pod for `workspaceId` on `node`, as the Job made it. */
function seedPod(workspaceId: string, node: string | null = 'n2'): void {
  fakeCluster.seed({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `yaac-${workspaceId}-x`,
      namespace: k8sNamespace(),
      labels: {
        'batch.kubernetes.io/job-name': `yaac-${workspaceId}`,
        'yaac.workspace-id': workspaceId,
        'yaac.project-id': PROJECT_ID,
        'yaac.install-id': installId(),
      },
    },
    spec: node === null ? {} : { nodeName: node },
    status: { phase: 'Running' },
  })
}

interface JobManifest {
  metadata: { name: string; labels: Record<string, string> }
  spec: { template: { metadata: { labels: Record<string, string> }; spec: {
    priorityClassName: string
    affinity: unknown
    initContainers?: Array<{ name: string; image: string; command: string[] }>
    containers: Array<{ env: Array<{ name: string; value?: string; valueFrom?: unknown }>; resources: { requests: Record<string, string> }; volumeMounts: Array<{ name: string; mountPath: string }> }>
    volumes: Array<{ name: string; hostPath?: { path: string }; persistentVolumeClaim?: { claimName: string } }>
  } } }
}

const appliedJobs = (): JobManifest[] => fakeCluster.callsOf('apply', 'Job').map((c) => c.body as unknown as JobManifest)

function appliedJob(): JobManifest {
  const [job] = appliedJobs()
  expect(job).toBeDefined()
  return job
}

const containerEnv = (job = appliedJob()): Record<string, string | undefined> =>
  Object.fromEntries(job.spec.template.spec.containers[0].env.map((e) => [e.name, e.value]))

const nodesOf = (job: JobManifest): string[] =>
  (job.spec.template.spec.affinity as { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: {
    nodeSelectorTerms: Array<{ matchFields: Array<{ values: string[] }> }>
  } } }).nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms.flatMap((t) => t.matchFields[0].values)

interface ClaimRequest {
  env: Record<string, string>
  git: { name: string; email: string; safeDirectories: string[] }
  npmRegistry?: string
  cwd: string
  statusRight: string
  startedMarker?: string
  waitMs?: number
}

/** What the pod is told when its launch is awaited (its pod on `n2`). */
async function claimOf(handle: RuntimeHandle): Promise<ClaimRequest> {
  seedPod(handle.workspaceId)
  mockPodClaim.mockClear()
  await awaitWorkspaceReady(handle)
  expect(mockPodClaim).toHaveBeenCalledTimes(1)
  return mockPodClaim.mock.calls[0][1] as ClaimRequest
}

/** A shared-tier and a node-local path, as mountd names them. */
const shared = (p: string): string => path.relative(globalRoot(), p)
const nodeLocal = (p: string): string => path.relative(nodeLocalRoot(), p)

let dataDir: string
/** The proxy's rollout, which deploys it: only that it was asked for. */
let ensureRunning: MockInstance

beforeEach(async () => {
  dataDir = await createTempDataDir()
  mockPodClaim.mockReset().mockResolvedValue(undefined)
  ensureRunning = vi.spyOn(proxyClient, 'ensureRunning').mockResolvedValue(undefined)
  fakeRegistry.install()
  fakeRegistry.mirror(UTILITY_MIRROR_TAG)
  // netshim's image, which every workspace pod runs.
  fakeRegistry.tags.add(await resolveMountdImageTag())
  fakeCluster.seed(
    {
      apiVersion: 'v1', kind: 'Secret', metadata: { name: PROXY_AUTH_SECRET_NAME, namespace: k8sNamespace() },
      data: { secret: Buffer.from(AUTH_SECRET).toString('base64') },
    },
  )
  await fakeMountd.install(['n1', 'n2'])
  await fakeMountd.settle(['n1', 'n2'])
})

afterEach(async () => {
  vi.useRealTimers()
  // A take this process holds outlives its test; the start gives back one
  // its launch never adopted.
  await reapSpare('s1')
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await cleanupTempDir(dataDir)
})

/** The registration ConfigMap a launch applied, decoded. */
function appliedRegistration(): { name: string; labels: Record<string, string>; payload: Record<string, unknown> } | undefined {
  const [call] = fakeCluster.callsOf('apply', 'ConfigMap')
  const cm = call?.body as { metadata: { name: string; labels: Record<string, string> }; data: Record<string, string> } | undefined
  return cm && {
    name: cm.metadata.name,
    labels: cm.metadata.labels,
    payload: JSON.parse(cm.data['registration.json']) as Record<string, unknown>,
  }
}

describe('prepareWorkspaceSubstrate', () => {
  it('rolls the proxy and assembles the registration the launch writes before its pod', async () => {
    // Prepare writes nothing: it overlaps the image build, and a
    // registration without a Job for that long would be swept as orphaned.
    const substrate = await prepareWorkspaceSubstrate({
      ...INTENT,
      proxySecretRules: { TOKEN: { hosts: ['api.example.com'], header: 'Authorization' } },
    })
    expect(ensureRunning).toHaveBeenCalled()
    expect(fakeCluster.callsOf('apply')).toEqual([])

    await launchWorkspace(specOf(substrate))
    expect(fakeCluster.callsOf('apply').map((c) => c.kind)).toEqual(['ConfigMap', 'Job'])
    const reg = appliedRegistration()
    expect(reg?.name).toBe('yaac-proxy-reg-s1')
    expect(reg?.labels).toMatchObject({
      app: 'yaac-proxy', 'yaac.proxy-input': 'registration', 'yaac.workspace-id': 's1', 'yaac.project-id': PROJECT_ID,
    })
    expect(reg?.payload).toMatchObject({ projectId: PROJECT_ID, owner: 'o' })
    expect(reg?.payload).not.toHaveProperty('release')
    // Which repos the workspace may authenticate to comes from its owner's
    // credential grants, never the registration.
    expect(reg?.payload).not.toHaveProperty('repoUrl')
    // Only a reference to the secret, never its value.
    expect(reg?.payload.rules).toEqual([{
      hostPattern: 'api.example.com',
      pathPattern: '/*',
      injections: [{ action: 'set_header', name: 'Authorization', secretRef: `${PROJECT_ID}/TOKEN` }],
    }])
  })

  // Passed to the claim, which writes it below the project's own .npmrc;
  // an env var would override a project's own registry.
  it('admits a workspace to the npm cache per its project, and points it there only while it serves', async () => {
    const launchAndClaim = async (intent: SubstrateIntent = INTENT): Promise<ClaimRequest> => {
      fakeCluster.calls = []
      return claimOf(await launchWorkspace(specOf(await prepareWorkspaceSubstrate(intent))))
    }
    // Not serving yet: no registry, and nothing for the proxy to dial.
    expect(await launchAndClaim()).not.toHaveProperty('npmRegistry')
    expect(appliedRegistration()?.payload).not.toHaveProperty('clusterServices')

    fakeCluster.seed({
      apiVersion: 'discovery.k8s.io/v1', kind: 'EndpointSlice',
      metadata: { name: 'yaac-npm-cache-x', namespace: k8sNamespace(), labels: { 'kubernetes.io/service-name': 'yaac-npm-cache' } },
      endpoints: [{ conditions: { ready: true } }],
    })
    const claim = await launchAndClaim()
    expect(claim.npmRegistry).toBe(`http://yaac-npm-cache.${k8sNamespace()}.svc.cluster.local:4873/`)
    for (const key of ['pnpm_config_registry', 'npm_config_registry']) expect(claim.env).not.toHaveProperty(key)
    // The proxy reaches the cache for it by that name, past its allowlist;
    // the pod carries no label, since it has no address to be admitted by.
    expect(appliedRegistration()?.payload.clusterServices).toEqual([`yaac-npm-cache.${k8sNamespace()}.svc.cluster.local:4873`])
    expect(appliedJob().spec.template.metadata.labels).not.toHaveProperty('yaac.npm-cache')

    // Each keeps the workspace off the cache (no registry, no cluster service):
    //  - the project turned it off;
    //  - the allowlist excludes npmjs (the cache bypasses the proxy);
    //  - a proxied npmjs secret (the cache fetches anonymously).
    for (const intent of [
      { ...INTENT, config: { ...PROJECT_CONFIG_DEFAULTS, npmCache: false } },
      { ...INTENT, allowlist: { hosts: ['github.com', 'api.anthropic.com'], defaults: false } },
      { ...INTENT, proxySecretRules: { NPM_TOKEN: { hosts: ['registry.npmjs.org'], header: 'Authorization' } } },
    ]) {
      expect(await launchAndClaim(intent)).not.toHaveProperty('npmRegistry')
      expect(appliedRegistration()?.payload).not.toHaveProperty('clusterServices')
    }
  })
})

describe('launchWorkspace', () => {
  it('makes a generic pod on demand on the ready nodes, labelled as its project\'s workspace, holding only what any pod of its id holds', async () => {
    const substrate = await prepareWorkspaceSubstrate(INTENT)
    const handle = await launchWorkspace(specOf(substrate, {
      env: ['CALLER_SAID=yes', 'YAAC_GIT_NAME=Ada'],
      tree: treeOf(),
    }))

    const job = appliedJob()
    expect(job.metadata.name).toBe('yaac-s1')
    expect(job.metadata.labels).toEqual({
      'yaac.project-id': PROJECT_ID,
      'yaac.workspace-id': 's1',
      'yaac.install-id': installId(),
    })
    expect(nodesOf(job)).toEqual(['n1', 'n2'])
    // The caller's variables go to the claim, never the cluster.
    const env = containerEnv(job)
    expect(env).not.toHaveProperty('CALLER_SAID')
    expect(env).not.toHaveProperty('YAAC_GIT_NAME')
    expect(env.YAAC_WORKSPACE_ID).toBe('s1')
    expect(env.YAAC_STREAM_TOKEN).toBe(crypto.createHmac('sha256', AUTH_SECRET).update('s1').digest('hex'))
    expect(env.SSL_CERT_FILE).toBe('/etc/yaac/certs/proxy-ca.pem')
    // ssh reaches the proxy, which ends the session and checks host keys:
    // no key, agent or host key file of the workspace's own.
    expect(env.GIT_SSH_COMMAND).toContain('UserKnownHostsFile=/etc/yaac/certs/ssh_known_hosts')
    expect(env.GIT_SSH_COMMAND).toContain('HostKeyAlias=yaac-proxy')
    expect(env).not.toHaveProperty('SSH_AUTH_SOCK')
    const pod = job.spec.template.spec
    expect(pod.containers[0].resources.requests.cpu).toBe('3m')
    expect(pod.priorityClassName).toBe('yaac-workspace')
    expect(pod.volumes.find((v) => v.name === 'node-mounts')?.hostPath?.path).toMatch(new RegExp(`^${nodeMountsNodePath()}/s1\\.[0-9a-f]{8}$`))
    // netshim from mountd's image, then the tree container from the base.
    expect(pod.initContainers?.map((c) => c.name)).toEqual(['netshim', 'tree'])
    expect(pod.initContainers?.[0].image).toMatch(/\/yaac-mountd:[0-9a-f]+$/)
    expect(pod.initContainers?.[1].image).toMatch(/-base:[0-9a-f]+$/)
    // Its socket directory has its node-mounts directory's name.
    const dir = pod.volumes.find((v) => v.name === 'node-mounts')?.hostPath?.path.split('/').pop()
    expect(pod.volumes.find((v) => v.name === 'sockets')?.hostPath?.path.split('/').pop()).toBe(dir)

    expect(handle).toMatchObject({
      workspaceId: 's1', projectId: PROJECT_ID, jobName: 'yaac-s1', running: false, state: 'pending', terminating: false,
    })
    expect(handle).not.toHaveProperty('prewarmed')

    // A site release keeps its files on the shared tier: no tree container.
    fakeCluster.calls = []
    await launchWorkspace(specOf(substrate))
    expect(appliedJob().spec.template.spec.initContainers?.map((c) => c.name)).toEqual(['netshim'])
  })

  it('builds the same pod environment twice from one spec, because a retry relaunches it', async () => {
    const spec = specOf(await prepareWorkspaceSubstrate(INTENT))
    await launchWorkspace(spec)
    await launchWorkspace(spec)
    const [first, second] = appliedJobs()
    expect(second.spec.template.spec.containers[0].env).toEqual(first.spec.template.spec.containers[0].env)
    expect(second.spec.template.spec.containers[0].env.filter((e) => e.name === 'YAAC_STREAM_TOKEN')).toHaveLength(1)
  })

  it('adopts the spare its start took: labels it its project\'s, raises its CPU request in place, and binds its own node-mounts dir', async () => {
    fakeCluster.seed(
      {
        apiVersion: 'batch/v1', kind: 'Job',
        metadata: { name: 'yaac-s1', namespace: k8sNamespace(), labels: { 'yaac.workspace-id': 's1', 'yaac.install-id': installId(), 'yaac.prewarmed': 'true' } },
      },
      {
        apiVersion: 'v1', kind: 'Pod',
        metadata: {
          name: 'yaac-s1-x', namespace: k8sNamespace(),
          labels: { 'batch.kubernetes.io/job-name': 'yaac-s1', 'yaac.workspace-id': 's1', 'yaac.install-id': installId(), 'yaac.prewarmed': 'true' },
          annotations: { 'yaac.scratch-bytes': String(8 * GiB) },
        },
        spec: {
          nodeName: 'n1',
          containers: [{ name: 'workspace', image: 'localhost:5000/img:tag', resources: { requests: { cpu: '100m', memory: '1' } } }],
          volumes: [{ name: 'node-mounts', hostPath: { path: `${nodeMountsNodePath()}/s1.0a0b0c0d` } }],
        },
        status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
      },
    )
    await expect(takeSpare({ image: 'localhost:5000/img:tag', scratchBytes: 8 * GiB, madeSince: 0 })).resolves.toBe('s1')
    const substrate = await prepareWorkspaceSubstrate(INTENT)
    fakeCluster.calls = []

    // Its labels land late. Until they do, the pod has neither a spare's
    // label nor a project's, and the pool must not take it for an orphan.
    const labelsLand = fakeCluster.hold((req) => req.method === 'PATCH' && req.path.endsWith('"name":"yaac-s1-x"}'))
    const handle = await launchWorkspace(specOf(substrate))
    expect(handle).toMatchObject({ workspaceId: 's1', projectId: PROJECT_ID, jobName: 'yaac-s1' })
    expect((await listSpares()).map((s) => s.workspaceId)).toEqual([])
    labelsLand()
    // Bound on its own node, at the node-mounts dir it was created with,
    // while its writes land; the claim call waits for them.
    await awaitWorkspaceReady(handle)

    // The registration beside the adoption (nothing in a spare reaches out
    // before its claim call), and no Job of its own.
    const writes = fakeCluster.calls.filter((c) => c.verb !== 'list' && c.verb !== 'read')
    expect(writes.map((c) => `${c.verb} ${c.kind}${c.subresource !== undefined ? `/${c.subresource}` : ''}`).sort())
      .toEqual(['apply ConfigMap', 'patch Job', 'patch Pod', 'patch Pod/resize'])
    expect(appliedJobs()).toEqual([])
    const labels = { 'yaac.project-id': PROJECT_ID, 'yaac.workspace-id': 's1', 'yaac.install-id': installId() }
    expect(fakeCluster.get<{ metadata: { labels: Record<string, string> } }>('Pod', 'yaac-s1-x')?.metadata.labels)
      .toEqual({ 'batch.kubernetes.io/job-name': 'yaac-s1', ...labels })
    // The Job loses its spare label, so nothing counts it as one again.
    expect(fakeCluster.get<{ metadata: { labels: Record<string, string> } }>('Job', 'yaac-s1')?.metadata.labels).toEqual(labels)
    const resized = fakeCluster.get<{ spec: { containers: Array<{ resources: { requests: Record<string, string> } }> } }>('Pod', 'yaac-s1-x')
    expect(resized?.spec.containers[0].resources.requests).toEqual({ cpu: '3m', memory: '1' })
    expect(fakeMountd.sent('/bind')).toEqual([expect.objectContaining({
      node: 'n1', body: expect.objectContaining({ pod: 'yaac-s1-x', dir: 's1.0a0b0c0d' }) as unknown,
    })])
  })

  it('adopts a spare on its own CPU request when the resize fails, and fails on one that is gone', async () => {
    const seedSpare = (): void => fakeCluster.seed({
      apiVersion: 'v1', kind: 'Pod',
      metadata: {
        name: 'yaac-s1-x', namespace: k8sNamespace(),
        labels: { 'yaac.workspace-id': 's1', 'yaac.install-id': installId(), 'yaac.prewarmed': 'true' },
        annotations: { 'yaac.scratch-bytes': String(8 * GiB) },
      },
      spec: {
        nodeName: 'n1',
        containers: [{ name: 'workspace', image: 'localhost:5000/img:tag' }],
        volumes: [{ name: 'node-mounts', hostPath: { path: `${nodeMountsNodePath()}/s1.0a0b0c0d` } }],
      },
      status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
    }, {
      apiVersion: 'batch/v1', kind: 'Job',
      metadata: { name: 'yaac-s1', namespace: k8sNamespace(), labels: { 'yaac.workspace-id': 's1', 'yaac.install-id': installId(), 'yaac.prewarmed': 'true' } },
    })
    const substrate = await prepareWorkspaceSubstrate(INTENT)

    seedSpare()
    await takeSpare({ image: 'localhost:5000/img:tag', scratchBytes: 8 * GiB, madeSince: 0 })
    fakeCluster.intercept((c) => { if (c.subresource === 'resize') throw apiError(422, 'resize is not supported') })
    const handle = await launchWorkspace(specOf(substrate))
    expect(handle).toMatchObject({ jobName: 'yaac-s1' })
    await awaitWorkspaceReady(handle)
    expect(fakeCluster.get<{ metadata: { labels: Record<string, string> } }>('Pod', 'yaac-s1-x')?.metadata.labels)
      .toHaveProperty('yaac.project-id', PROJECT_ID)

    // A spare gone since the take fails the wait at once, not at its timeout.
    fakeCluster.reset()
    seedSpare()
    await takeSpare({ image: 'localhost:5000/img:tag', scratchBytes: 8 * GiB, madeSince: 0 })
    fakeCluster.remove('Pod', 'yaac-s1-x', k8sNamespace())
    await expect(awaitWorkspaceReady(await launchWorkspace(specOf(substrate))))
      .rejects.toThrow(/404[\s\S]*yaac-s1-x/)
  })

  it('makes a pod on demand, deleting the spare it took, for an image built since the take', async () => {
    fakeCluster.seed({
      apiVersion: 'v1', kind: 'Pod',
      metadata: {
        name: 'yaac-s1-x', namespace: k8sNamespace(),
        labels: { 'yaac.workspace-id': 's1', 'yaac.install-id': installId(), 'yaac.prewarmed': 'true' },
        annotations: { 'yaac.scratch-bytes': String(8 * GiB) },
      },
      spec: {
        nodeName: 'n1',
        containers: [{ name: 'workspace', image: 'localhost:5000/img:tag' }],
        volumes: [{ name: 'node-mounts', hostPath: { path: `${nodeMountsNodePath()}/s1.0a0b0c0d` } }],
      },
      status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
    }, {
      apiVersion: 'batch/v1', kind: 'Job',
      metadata: { name: 'yaac-s1', namespace: k8sNamespace(), labels: { 'yaac.workspace-id': 's1', 'yaac.install-id': installId(), 'yaac.prewarmed': 'true' } },
    })
    await expect(takeSpare({ image: 'localhost:5000/img:tag', scratchBytes: 8 * GiB, madeSince: 0 })).resolves.toBe('s1')
    const substrate = await prepareWorkspaceSubstrate(INTENT)
    fakeCluster.calls = []
    await launchWorkspace(specOf(substrate, { image: 'localhost:5000/img:newer' }))
    expect(fakeCluster.callsOf('delete').map((c) => `${c.kind} ${c.name}`).sort()).toEqual(['Job yaac-s1', 'Pod yaac-s1-x'])
    expect((appliedJob().spec.template.spec.containers[0] as { image?: string }).image).toBe('localhost:5000/img:newer')
  })

  it('refuses a spec it cannot launch: one with no image, or a receipt this driver did not prepare', async () => {
    const substrate = await prepareWorkspaceSubstrate(INTENT)
    await expect(launchWorkspace(specOf(substrate, { image: undefined }))).rejects.toThrow('launch yaac-s1: no image on the spec')
    await expect(launchWorkspace(specOf({ kind: 'workspace-substrate' }))).rejects.toThrow(/receipt the k8s runtime did not prepare/)
    expect(fakeCluster.callsOf('apply')).toEqual([])
  })

  it('waits a while for a node whose mountd is ready, then refuses with why the one it needs is not', async () => {
    const substrate = await prepareWorkspaceSubstrate(INTENT)
    await fakeMountd.install(['n1', 'n2'])
    fakeMountd.reports.set('n1', await fakeMountd.goodReport({ build: 'build-0' }))
    fakeMountd.reports.set('n2', await fakeMountd.goodReport({ build: 'build-0' }))
    await fakeMountd.settle([])
    vi.useFakeTimers()

    const anyNode = expect(launchWorkspace(specOf(substrate))).rejects.toThrow(/no node can take a new workspace \(any node: no mountd is ready\)/)
    await vi.advanceTimersByTimeAsync(121_000)
    await anyNode

    // Beside a byo volume's holder, only its node will do.
    vi.stubEnv('YAAC_VOLUME_STORAGE_CLASS', 'hcloud-volumes')
    fakeCluster.seed({
      apiVersion: 'v1', kind: 'Pod',
      metadata: { name: 'yaac-old-x', namespace: k8sNamespace(), labels: { 'yaac.workspace-id': 'old' } },
      spec: { nodeName: 'n2' },
    })
    const holder = expect(launchWorkspace(specOf(substrate, {
      siteId: 'site-1', colocateWith: 'old', mounts: [{ source: { kind: 'volume', volumeId: 'v1' }, mountPath: '/home/yaac/volume' }],
    }))).rejects.toThrow('(n2: its mountd runs build build-0, not the server\'s)')
    await vi.advanceTimersByTimeAsync(121_000)
    await holder
    expect(appliedJobs()).toEqual([])
  })

  it('reads run secrets by key from the project\'s run-secrets Secret, in a pod of its own even when its start took a spare, refusing one the claim\'s variables would hide before anything is written', async () => {
    fakeCluster.seed({
      apiVersion: 'v1', kind: 'Pod',
      metadata: {
        name: 'yaac-s1-x', namespace: k8sNamespace(),
        labels: { 'yaac.workspace-id': 's1', 'yaac.install-id': installId(), 'yaac.prewarmed': 'true' },
        annotations: { 'yaac.scratch-bytes': String(8 * GiB) },
      },
      spec: {
        nodeName: 'n1',
        containers: [{ name: 'workspace', image: 'localhost:5000/img:tag' }],
        volumes: [{ name: 'node-mounts', hostPath: { path: `${nodeMountsNodePath()}/s1.0a0b0c0d` } }],
      },
      status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
    }, {
      apiVersion: 'batch/v1', kind: 'Job',
      metadata: { name: 'yaac-s1', namespace: k8sNamespace(), labels: { 'yaac.workspace-id': 's1', 'yaac.install-id': installId(), 'yaac.prewarmed': 'true' } },
    })
    await expect(takeSpare({ image: 'localhost:5000/img:tag', scratchBytes: 8 * GiB, madeSince: 0 })).resolves.toBe('s1')
    const substrate = await prepareWorkspaceSubstrate(INTENT)
    fakeCluster.calls = []
    await launchWorkspace(specOf(substrate, { runSecrets: ['P8_KEY'] }))
    expect(fakeCluster.callsOf('delete').map((c) => `${c.kind} ${c.name}`).sort()).toEqual(['Job yaac-s1', 'Pod yaac-s1-x'])
    expect(fakeCluster.callsOf('patch')).toEqual([])
    expect(appliedJob().metadata.labels).toHaveProperty('yaac.project-id', PROJECT_ID)
    expect(appliedJob().spec.template.spec.containers[0].env).toContainEqual({
      name: 'P8_KEY',
      valueFrom: { secretKeyRef: { name: `yaac-run-secrets-${PROJECT_ID}`, key: 'P8_KEY' } },
    })

    fakeCluster.calls = []
    await expect(launchWorkspace(specOf(substrate, { runSecrets: ['CALLER_SAID'] }))).rejects.toThrow(/run secret CALLER_SAID shares its name/)
    expect(fakeCluster.callsOf('apply')).toEqual([])
  })

  // docs/public-sites.md: the router may reach it, the proxy refuses its
  // calls to the server, and node pressure evicts dev workspaces first.
  it('labels a site release, ranks it above workspaces, and pins it beside the holder of a byo volume\'s claim', async () => {
    const substrate = await prepareWorkspaceSubstrate(INTENT)
    await launchWorkspace(specOf(substrate, { siteId: 'site-1', colocateWith: 'old' }))
    let job = appliedJob()
    expect(job.spec.template.metadata.labels).toMatchObject({ 'yaac.site-id': 'site-1' })
    expect(appliedRegistration()?.payload).toMatchObject({ release: true })
    expect(job.spec.template.spec.priorityClassName).toBe('yaac-release')
    // On kind every volume is in one claim mountd mounts, so the
    // pod may go to any ready node.
    expect(nodesOf(job)).toEqual(['n1', 'n2'])

    vi.stubEnv('YAAC_VOLUME_STORAGE_CLASS', 'hcloud-volumes')
    const volume = { source: { kind: 'volume' as const, volumeId: 'v1' }, mountPath: '/home/yaac/volume' }
    fakeCluster.seed({
      apiVersion: 'v1', kind: 'Pod',
      metadata: { name: 'yaac-old-x', namespace: k8sNamespace(), labels: { 'yaac.workspace-id': 'old' } },
      spec: { nodeName: 'n2' },
    })
    fakeCluster.calls = []
    await launchWorkspace(specOf(substrate, { siteId: 'site-1', colocateWith: 'old', mounts: [volume] }))
    job = appliedJob()
    expect(nodesOf(job)).toEqual(['n2'])
    // The claim kubelet attaches, its root handed over by the utility image.
    expect(job.spec.template.spec.volumes).toContainEqual({ name: 'pv-0', persistentVolumeClaim: { claimName: 'yaac-volume-v1' } })
    expect(job.spec.template.spec.containers[0].volumeMounts).toContainEqual({ name: 'pv-0', mountPath: '/home/yaac/volume' })
    expect(job.spec.template.spec.initContainers?.find((c) => c.name === 'volume-root')).toMatchObject({ image: expect.stringContaining('@sha256:') as unknown })

    // A holder not on a node yet could land anywhere, so nothing launches.
    fakeCluster.seed({
      apiVersion: 'v1', kind: 'Pod',
      metadata: { name: 'yaac-old-x', namespace: k8sNamespace(), labels: { 'yaac.workspace-id': 'old' } },
      spec: {},
    })
    fakeCluster.calls = []
    await expect(launchWorkspace(specOf(substrate, { siteId: 'site-1', colocateWith: 'old', mounts: [volume] })))
      .rejects.toThrow('not on a node yet')
    expect(appliedJobs()).toEqual([])
  })
})

describe('awaitWorkspaceReady', () => {
  it('binds what the workspace owns once its start instruction names each commit, then claims the pod', async () => {
    const tree = treeOf()
    const opencode = opencodeDataDir(PROJECT_ID, 's1')
    const handle = await launchWorkspace(specOf(await prepareWorkspaceSubstrate(INTENT), {
      tree,
      mounts: [
        { source: { kind: 'hostPath', path: path.join(claudeDir(PROJECT_ID), 'settings.json'), type: 'File' }, mountPath: '/home/yaac/.claude/settings.json', readOnly: true },
        { source: { kind: 'hostPath', path: opencode }, mountPath: '/home/yaac/.local/share/opencode' },
        // A source the tree container mounts too is mounted once, at both.
        { source: { kind: 'hostPath', path: tree.checkpointsDir }, mountPath: '/home/yaac/.yaac/checkpoints' },
        { source: { kind: 'emptyDir' }, mountPath: '/home/yaac/.codex/tmp' },
        // The pod's own tmux volume, never a folder of the claim's.
        { source: { kind: 'emptyDir' }, mountPath: '/tmp/yaac-tmux' },
      ],
      scratchDirs: ['/workspace/node_modules', '/workspace/web/node_modules'],
    }))
    const dir = (fakeCluster.callsOf('apply', 'Job')[0].body as unknown as JobManifest).spec.template.spec.volumes
      .find((v) => v.name === 'node-mounts')?.hostPath?.path.split('/').at(-1)
    seedPod('s1')
    await writeStart()
    mockPodClaim.mockImplementation(() => {
      // The tree container binds from what mountd mounted.
      expect(fakeMountd.sent('/bind')).toHaveLength(1)
      return Promise.resolve()
    })

    await awaitWorkspaceReady(handle)

    const treeDir = path.join(tree.lifeDir, 'tree')
    const scratch = path.join(tree.lifeDir, 'scratch')
    const [bind] = fakeMountd.sent('/bind')
    expect(bind.node).toBe('n2')
    expect(bind.body).toEqual({
      token: `yaac-s1:${String(dir)}`,
      pod: 'yaac-s1-x',
      workspaceId: 's1',
      dir,
      life: 'L1',
      // Outermost first, each at the commit the instruction names.
      trees: [
        { repo: 'r1', commit: 'c1', dest: nodeLocal(treeDir), index: nodeLocal(path.join(scratch, 'arborist', 'r1.index')) },
        { repo: 'r2', commit: 'c2', dest: nodeLocal(path.join(treeDir, 'web')), index: nodeLocal(path.join(scratch, 'arborist', 'r2.index')) },
      ],
      // Node-local folders mountd makes before it mounts: the life's,
      // each mount point inside the tree, and the workspace's own.
      dirs: [
        nodeLocal(treeDir),
        nodeLocal(scratch),
        nodeLocal(path.join(treeDir, '.git')),
        nodeLocal(path.join(treeDir, 'web', '.git')),
        nodeLocal(path.join(treeDir, 'node_modules')),
        nodeLocal(opencode),
      ],
      mounts: [
        { tier: 'node', path: nodeLocal(treeDir), workspace: '/workspace', tree: '/tree' },
        { tier: 'node', path: nodeLocal(scratch), tree: '/scratch' },
        { tier: 'shared', path: shared(tree.checkpointsDir), tree: '/ckpt', workspace: '/home/yaac/.yaac/checkpoints' },
        { tier: 'shared', path: shared(tree.checkouts[0].gitDir), workspace: '/workspace/.git', tree: '/git/r1' },
        { tier: 'shared', path: shared(tree.checkouts[1].gitDir), workspace: '/workspace/web/.git', tree: '/git/r2' },
        // A main clone at the server's own path, since alternates name it.
        { tier: 'shared', path: shared(repoDir('r1')), workspace: repoDir('r1'), tree: repoDir('r1'), readOnly: true },
        { tier: 'shared', path: shared(path.join(claudeDir(PROJECT_ID), 'settings.json')), workspace: '/home/yaac/.claude/settings.json', readOnly: true },
        { tier: 'node', path: nodeLocal(opencode), workspace: '/home/yaac/.local/share/opencode' },
      ],
      folders: [
        { from: 'local', target: '/home/yaac/.codex/tmp' },
        { from: 'scratch', target: '/workspace/node_modules' },
        { from: 'scratch', target: '/workspace/web/node_modules' },
      ],
      roots: { scratch: '/yaac-scratch', local: '/yaac-local' },
    })
    expect(bind.authorization).toMatch(/^Bearer [0-9a-f]{64}$/)

    // The claim waits for the tree container's marker of this life.
    expect(mockPodClaim).toHaveBeenCalledTimes(1)
    const [jobName, claim, opts] = mockPodClaim.mock.calls[0] as [string, ClaimRequest, { timeoutMs: number }]
    expect(jobName).toBe('yaac-s1')
    expect(claim).toMatchObject({ startedMarker: '/yaac-trigger/started.L1', waitMs: 10 * 60_000 })
    expect(opts.timeoutMs).toBeGreaterThan(10 * 60_000)

    // A restore of a large checkpoint may take hours.
    mockPodClaim.mockReset().mockResolvedValue(undefined)
    const restoring = await launchWorkspace(specOf(await prepareWorkspaceSubstrate(INTENT), { tree: treeOf({ restoring: true }) }))
    await awaitWorkspaceReady(restoring)
    expect(mockPodClaim.mock.calls[0][1]).toMatchObject({ waitMs: 4 * 60 * 60_000 })
  })

  it('waits for the life\'s start instruction, past one written partway and one of another life', async () => {
    vi.useFakeTimers()
    const startFile = path.join(workspaceCheckpointsDir(PROJECT_ID, 's1'), LIVES_DIR, 'L1', START_FILE)
    const readFile = vi.spyOn(fs, 'readFile')
    const reads = (): number => readFile.mock.calls.filter(([file]) => file === startFile).length
    /** Let the poll read the file at least once more. */
    const pollPast = async (): Promise<void> => {
      const seen = reads()
      await vi.waitFor(() => { expect(reads()).toBeGreaterThan(seen + 1) })
    }
    const handle = await launchWorkspace(specOf(await prepareWorkspaceSubstrate(INTENT), { tree: treeOf() }))
    seedPod('s1')
    let done = false
    const ready = awaitWorkspaceReady(handle).then(() => { done = true })

    await pollPast()
    await writeStart('{"version": 1, "life": "L')
    await pollPast()
    await writeStart({ life: 'L0' })
    await pollPast()
    expect(done).toBe(false)
    expect(fakeMountd.sent('/bind')).toEqual([])

    await writeStart()
    await vi.waitFor(() => { expect(done).toBe(true) })
    await ready
    expect((fakeMountd.sent('/bind')[0].body as { trees: unknown[] }).trees).toHaveLength(2)
  })

  it('tells the claim the caller\'s variables, the identity and trusted checkouts, the shells\' cwd, and pnpm\'s store', async () => {
    const substrate = await prepareWorkspaceSubstrate(INTENT)
    const claim = await claimOf(await launchWorkspace(specOf(substrate, {
      env: [
        'CALLER_SAID=yes', 'YAAC_GIT_NAME=Ada', 'YAAC_GIT_EMAIL=ada@example.com',
        'YAAC_CHECKOUTS=.:web', 'YAAC_STATUS_RIGHT= s1 ',
      ],
      cwd: 'web',
      scratchDirs: ['/workspace/node_modules'],
    })))
    expect(claim.env.CALLER_SAID).toBe('yes')
    expect(claim.git).toEqual({ name: 'Ada', email: 'ada@example.com', safeDirectories: ['/workspace', '/workspace/web'] })
    expect(claim.statusRight).toBe(' s1 ')
    expect(claim.cwd).toBe('/workspace/web')
    // pnpm's SQLite store index cannot be shared between pods, so each has
    // its own, inside the root scratch dir so pnpm hardlinks. Both
    // spellings: pnpm 10 reads only npm_config_.
    expect(claim.env).toMatchObject({
      pnpm_config_store_dir: '/workspace/node_modules/.pnpm-store',
      npm_config_store_dir: '/workspace/node_modules/.pnpm-store',
    })
    // No tree, so nothing to wait for.
    expect(claim).not.toHaveProperty('startedMarker')

    const plain = await claimOf(await launchWorkspace(specOf(substrate)))
    expect(plain.cwd).toBe('/workspace')
    expect(plain.env.pnpm_config_store_dir).toBe('/home/yaac/.local/share/pnpm/store')
  })

  it('binds and claims a launch once, and only waits for a pod it did not launch', async () => {
    const handle = await launchWorkspace(specOf(await prepareWorkspaceSubstrate(INTENT)))
    await claimOf(handle)
    mockPodClaim.mockClear()
    await awaitWorkspaceReady(handle)
    expect(mockPodClaim).not.toHaveBeenCalled()
    expect(fakeMountd.sent('/bind')).toHaveLength(1)
  })

  it('fails before the claim when the pod has no node, a mount is in no tier a workspace may use, or mountd refuses the bind', async () => {
    const substrate = await prepareWorkspaceSubstrate(INTENT)

    seedPod('s1', null)
    await expect(awaitWorkspaceReady(await launchWorkspace(specOf(substrate)))).rejects.toThrow('pod is not on a node')

    seedPod('s1')
    await expect(awaitWorkspaceReady(await launchWorkspace(specOf(substrate, {
      mounts: [{ source: { kind: 'hostPath', path: secretKeyPath() }, mountPath: '/x' }],
    })))).rejects.toThrow(/is in no storage tier a workspace may mount/)
    expect(fakeMountd.sent('/bind')).toEqual([])

    fakeMountd.refusals.set('POST /bind', 'mount point is a symlink')
    await expect(awaitWorkspaceReady(await launchWorkspace(specOf(substrate))))
      .rejects.toThrow('mountd refused /bind: mount point is a symlink')
    expect(mockPodClaim).not.toHaveBeenCalled()
  })
})
