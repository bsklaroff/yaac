/**
 * The main registry's GC. The registry pod is faked by a temp directory laid
 * out like registry:2's storage. Each `kubectl exec` into it runs for real
 * against that tree, except `garbage-collect`, which is only recorded, so
 * the tests assert which tags survive.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type * as childProcessModule from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const run = promisify(execFile)

type ExecCallback = (err: unknown, res?: { stdout: string; stderr: string }) => void
/** Answers `kubectl` children; any other binary runs for real. */
const kubectl = vi.hoisted(() => ({ handler: null as null | ((args: string[]) => Promise<string>) }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcessModule>()
  return {
    ...actual,
    execFile: (file: string, args: string[], opts: unknown, cb?: ExecCallback) => {
      const done = (typeof opts === 'function' ? opts : cb) as ExecCallback
      if (file !== 'kubectl') {
        actual.execFile(file, args, (err, stdout, stderr) => { done(err, { stdout, stderr }) })
        return
      }
      if (!kubectl.handler) throw new Error(`unexpected kubectl ${args.join(' ')}`)
      kubectl.handler(args).then((stdout) => { done(null, { stdout, stderr: '' }) }, (err: unknown) => { done(err) })
    },
  }
})
vi.mock('#drivers/k8s/container/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof registryModule>()),
  registryTagState: vi.fn(),
}))
const mockServerLog = vi.hoisted(() => vi.fn())
vi.mock('#log', () => ({ serverLog: mockServerLog, pipeToServerLog: vi.fn() }))

import { reconcileMainRegistryGc } from '#drivers/k8s/images'
// Setup values and test hooks, not units under test.
import {
  _mainRegistryGcSettledForTests,
  _resetMainRegistryGcForTests,
} from '#drivers/k8s/images/main-registry-gc'
import { resolveImageChain } from '#drivers/k8s/image-engine'
import { registryHost, registryTagState } from '#drivers/k8s/container/registry'
import { REGISTRY_UPSTREAM_IMAGE } from '#drivers/k8s/cluster'
import { USER_DOCKERFILE, userBuildDir } from '#lib/build-dirs'
import type * as registryModule from '#drivers/k8s/container/registry'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'

const DAY_MS = 24 * 60 * 60_000
const DEMO = '3f2c9a1e-5b7d-4c8e-9f01-2a3b4c5d6e7f'
const USER = `yaac-user-${DEMO}`
const CACHE = `yaac-buildcache-${DEMO}`
const hex = (c: string): string => c.repeat(16)
const ref = (tag: string): string => `${registryHost()}/${tag}`

let dataDir: string
/** Stands in for the registry pod's `/var/lib/registry`. */
let storage: string
const reposDir = (): string => path.join(storage, 'docker/registry/v2/repositories')

/** Put `repo:tag` in the registry, last written `ageDays` ago. */
async function pushTag(repoTag: string, ageDays: number): Promise<void> {
  const [repo, tag] = repoTag.split(':')
  const tagDir = path.join(reposDir(), repo, '_manifests/tags', tag)
  await fs.mkdir(path.join(tagDir, 'current'), { recursive: true })
  const link = path.join(tagDir, 'current/link')
  await fs.writeFile(link, 'sha256:0')
  const when = new Date(Date.now() - ageDays * DAY_MS)
  const repoDir = path.join(reposDir(), repo)
  for (const p of [link, path.join(tagDir, 'current'), tagDir, repoDir]) await fs.utimes(p, when, when)
}

/** Every `repo:tag` the registry still holds. */
async function survivors(): Promise<string[]> {
  const { stdout } = await run('find', [reposDir(), '-path', '*/_manifests/tags/*', '-prune', '-type', 'd'])
  return stdout.split('\n').filter(Boolean).map((p) => {
    const rel = path.relative(reposDir(), p)
    const [repo, tag] = rel.split('/_manifests/tags/')
    return `${repo}:${tag}`
  }).sort()
}

/** A push landing in the registry right now. */
async function startUpload(): Promise<void> {
  const dir = path.join(reposDir(), 'yaac-tools/_uploads/u1')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'data'), '')
}

interface Fixture {
  /** Images named by pods and workload templates, as full refs. */
  pods?: string[]
  scaledToZero?: string[]
  nodes?: Array<{ name: string; images: string[][] }>
  /** Called with each in-registry argv before it runs. */
  beforeExec?: (argv: string[]) => Promise<void> | void
  collect?: () => Promise<void>
}

/** Every argv the pass ran inside the registry pod. */
let execs: string[][]
const collected = (): boolean => execs.some((a) => a.includes('garbage-collect'))
const logged = (needle: string): boolean =>
  mockServerLog.mock.calls.some((call) => String(call[0]).includes(needle))
interface PodManifest {
  metadata: { name: string }
  spec: {
    nodeName: string
    hostPID: boolean
    tolerations: unknown[]
    containers: Array<{ image: string; command: string[]; securityContext: unknown }>
  }
}
const prunePods = (): PodManifest[] => fakeCluster.callsOf('apply', 'Pod')
  .map((c) => c.body as unknown as PodManifest)
  .filter((m) => m.metadata.name.startsWith('yaac-node-image-gc-'))
const prunedRefs = (pod: PodManifest): string[] => {
  const command = pod.spec.containers[0].command
  return command.slice(command.indexOf('--') + 1)
}

function stage(f: Fixture = {}): void {
  fakeCluster.seed(
    ...(f.pods ?? []).map((image, i) => ({
      apiVersion: 'v1', kind: 'Pod', metadata: { name: `p${String(i)}`, namespace: 'other' }, spec: { containers: [{ image }] },
    })),
    ...(f.scaledToZero ?? []).map((image, i) => ({
      apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: `d${String(i)}`, namespace: 'other' },
      spec: { replicas: 0, template: { spec: { containers: [{ image }] } } },
    })),
    ...(f.nodes ?? []).map(({ name, images }) => ({
      apiVersion: 'v1', kind: 'Node', metadata: { name }, status: { images: images.map((names) => ({ names })) },
    })),
  )
  // Each prune pod succeeds at once and logs what it removed, as the
  // node's crictl prints it.
  fakeCluster.intercept((c) => {
    if (c.verb !== 'apply' || c.kind !== 'Pod') return
    c.body = { ...c.body, status: { phase: 'Succeeded' } }
    const pod = c.body as unknown as PodManifest
    fakeCluster.podLogs.set(pod.metadata.name, prunedRefs(pod).map((r) => `removed ${r}\n`).join(''))
  })
  kubectl.handler = async (args) => {
    if (args[0] !== 'exec') throw new Error(`unexpected kubectl ${args.join(' ')}`)
    const argv = args.slice(args.indexOf('--') + 1)
    execs.push(argv)
    await f.beforeExec?.(argv)
    if (argv.includes('garbage-collect')) {
      await f.collect?.()
      return ''
    }
    const real = argv.map((a) => a.replaceAll('/var/lib/registry', storage))
    return (await run(real[0], real.slice(1))).stdout
  }
}

/** Drive one reconcile and wait out the detached pass it starts. */
async function runPass(): Promise<void> {
  await reconcileMainRegistryGc([DEMO], () => Promise.resolve({}))
  await _mainRegistryGcSettledForTests()
}

beforeEach(async () => {
  dataDir = await createTempDataDir()
  storage = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-registry-'))
  execs = []
  kubectl.handler = null
  mockServerLog.mockReset()
  // The registry answers from the fake tree.
  vi.mocked(registryTagState).mockReset().mockImplementation(async (repoTag: string) => {
    const [repo, tag] = repoTag.split(':')
    return fs.access(path.join(reposDir(), repo, '_manifests/tags', tag))
      .then(() => 'present' as const, () => 'absent' as const)
  })
  _resetMainRegistryGcForTests()
  // The GC runs only on the default install; the test setup isolates the
  // namespace, so opt back in.
  vi.stubEnv('YAAC_K8S_NAMESPACE', 'yaac')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await cleanupTempDir(dataDir)
  await fs.rm(storage, { recursive: true, force: true })
})

describe('reconcileMainRegistryGc', () => {
  it('retires what nothing live names, keeps every live and recent tag, then collects', async () => {
    const { layers } = await resolveImageChain(DEMO, 'yaac')
    const [wantedBase, wantedTools] = layers.map((l) => l.tag)
    for (const [tag, age] of [
      // A project image: one generation a running pod names, two newest kept.
      [`${USER}:${hex('1')}`, 40], [`${USER}:${hex('2')}`, 30],
      [`${USER}:${hex('3')}`, 20], [`${USER}:${hex('4')}`, 10],
      [`${USER}:${hex('5')}`, 1],
      // The project's current chain, older than two newer builds elsewhere.
      [wantedBase, 50], [`yaac-base:${hex('b')}`, 60],
      [`yaac-base:${hex('c')}`, 5], [`yaac-base:${hex('d')}`, 4], [wantedTools, 50],
      // A stopped server: only its scaled-to-zero Deployment template names
      // the image `yaac server start` will need.
      [`yaac-server:${hex('e')}`, 90], [`yaac-server:${hex('f')}`, 3], [`yaac-server:${hex('0')}`, 2],
      // The e2e suite's images, which the suite retires itself.
      [`yaac-test-base:${hex('a')}`, 30], [`yaac-test-base:${hex('9')}`, 20], [`yaac-test-base:${hex('8')}`, 10],
      // Never retired: mirrors have no content-hash tag, and non-yaac repos
      // are left alone.
      ['yaac-registry2:0123456789ab', 300], ['envoyproxy/envoy:1.34-45d37d848802', 300],
      ['podman-stable:v5.5', 300],
      [`myapp:${hex('7')}`, 300],
      // Step cache entries expire after the cache TTL.
      [`${CACHE}:${'a'.repeat(64)}`, 30], [`${CACHE}:${'b'.repeat(64)}`, 1],
    ] as const) await pushTag(tag, age)
    stage({ pods: [ref(`${USER}:${hex('2')}`)], scaledToZero: [ref(`yaac-server:${hex('e')}`)] })

    await runPass()

    expect(await survivors()).toEqual([
      'envoyproxy/envoy:1.34-45d37d848802',
      `myapp:${hex('7')}`,
      'podman-stable:v5.5',
      `yaac-base:${hex('c')}`, `yaac-base:${hex('d')}`,
      `${CACHE}:${'b'.repeat(64)}`,
      'yaac-registry2:0123456789ab',
      `yaac-server:${hex('0')}`, `yaac-server:${hex('e')}`, `yaac-server:${hex('f')}`,
      `yaac-test-base:${hex('8')}`, `yaac-test-base:${hex('9')}`, `yaac-test-base:${hex('a')}`,
      `${USER}:${hex('2')}`, `${USER}:${hex('4')}`, `${USER}:${hex('5')}`,
      wantedBase, wantedTools,
    ].sort())
    // Untagging frees no disk until garbage-collect runs. The collect has
    // an in-container timeout, since killing the exec client would not
    // stop it.
    expect(execs.find((a) => a.includes('garbage-collect'))?.[0]).toBe('timeout')
    expect(logged('retired 4 stale tag(s) and collected their blobs')).toBe(true)
  })

  it('untags whole project repos no live project holds, unless a workload still names one', async () => {
    const gone = '0b6f1d2c-3e4a-4b5c-8d9e-0f1a2b3c4d5e'
    const stillRunning = 'c1d2e3f4-a5b6-4c7d-8e9f-a0b1c2d3e4f5'
    const justAdded = 'd2e3f4a5-b6c7-4d8e-9f0a-b1c2d3e4f5a6'
    for (const tag of [
      `yaac-proj-${DEMO}:${hex('1')}`, `${USER}:${hex('1')}`, `${CACHE}:${'a'.repeat(64)}`,
      // A removed project's repos.
      `yaac-proj-${gone}:${hex('1')}`, `yaac-user-${gone}:${hex('1')}`,
      `yaac-buildcache-${gone}:${'a'.repeat(64)}`,
      // Named by slug, from before projects had ids.
      `yaac-user-demo:${hex('1')}`, `yaac-buildcache-demo:${'a'.repeat(64)}`,
      // Removed, but a pod still uses its image.
      `yaac-proj-${stillRunning}:${hex('1')}`,
      // The e2e suite's and yaac's own chain are never swept here.
      `yaac-test-user-${gone}:${hex('1')}`, `yaac-test-proj-${gone}:${hex('1')}`,
      `yaac-tools:${hex('1')}`,
      // A project added after the pass read the live set, pushing now.
      `yaac-proj-${justAdded}:${hex('1')}`,
    ]) await pushTag(tag, 1)
    const now = new Date()
    await fs.utimes(path.join(reposDir(), `yaac-proj-${justAdded}`), now, now)
    stage({ pods: [ref(`yaac-proj-${stillRunning}:${hex('1')}`)] })

    await runPass()

    expect(await survivors()).toEqual([
      `yaac-proj-${DEMO}:${hex('1')}`, `${USER}:${hex('1')}`, `${CACHE}:${'a'.repeat(64)}`,
      `yaac-proj-${stillRunning}:${hex('1')}`,
      `yaac-test-user-${gone}:${hex('1')}`, `yaac-test-proj-${gone}:${hex('1')}`,
      `yaac-tools:${hex('1')}`,
      `yaac-proj-${justAdded}:${hex('1')}`,
    ].sort())
    // Removed repos also need a collect to free their blobs.
    expect(collected()).toBe(true)
    expect(logged('retired 5 stale tag(s) and collected their blobs')).toBe(true)
  })

  it('retires no generation while any project\'s chain cannot be resolved', async () => {
    for (const [tag, age] of [
      [`yaac-tools:${hex('a')}`, 30], [`yaac-tools:${hex('9')}`, 20], [`yaac-tools:${hex('8')}`, 10],
      [`${CACHE}:${'a'.repeat(64)}`, 30],
    ] as const) await pushTag(tag, age)
    // A Dockerfile.user mid-edit makes every project's chain fail to
    // resolve, so no generation is known to be live.
    await fs.mkdir(userBuildDir(), { recursive: true })
    await fs.writeFile(path.join(userBuildDir(), USER_DOCKERFILE), 'FROM ubuntu\n')
    stage()

    await runPass()

    // The step cache does not depend on chains, so it is still swept.
    expect(await survivors()).toEqual([
      `yaac-tools:${hex('8')}`, `yaac-tools:${hex('9')}`, `yaac-tools:${hex('a')}`,
    ])
    expect(logged('no image generation is retired this pass')).toBe(true)
  })

  it('drops each node\'s copy of what the registry retired, and nothing it still serves or a pod names', async () => {
    for (const [tag, age] of [
      [`${USER}:${hex('1')}`, 40], [`${USER}:${hex('2')}`, 30], [`${USER}:${hex('3')}`, 20],
      [`${USER}:${hex('4')}`, 10], [`${USER}:${hex('5')}`, 1],
    ] as const) await pushTag(tag, age)
    const gone = `yaac-old:${hex('6')}`
    stage({
      pods: [ref(`${USER}:${hex('1')}`), ref(`yaac-server:${hex('c')}`)],
      nodes: [
        { name: 'n1', images: [
          // Retired this pass; its digest name is the same image.
          [ref(`${USER}:${hex('3')}`), `${registryHost()}/${USER}@sha256:${'3'.repeat(64)}`],
          [ref(gone)],
          // Still used by a pod: kept.
          [ref(`${USER}:${hex('1')}`)],
          [ref(`yaac-server:${hex('c')}`)],
          // Still in the registry: kept warm for the next create.
          [ref(`${USER}:${hex('5')}`)],
          // Not yaac generations: a mirror and the node's own image.
          [ref('podman-stable:v5.5')],
          ['docker.io/kindest/local-path-helper:v20241212'],
        ] },
        { name: 'n2', images: [[ref(`${USER}:${hex('5')}`)]] },
      ],
    })

    await runPass()

    const pods = prunePods()
    expect(pods.map((p) => p.spec.nodeName)).toEqual(['n1'])
    expect(prunedRefs(pods[0])).toEqual([ref(`${USER}:${hex('3')}`), ref(gone)])
    // The node's crictl via PID 1's mount namespace, with a timeout long
    // enough for a multi-GB delete (crictl's default is 2s).
    expect(pods[0].spec.containers[0].command[2]).toContain('nsenter -t 1 -m -- crictl -t 10m rmi')
    expect(pods[0].spec.hostPID).toBe(true)
    // A privileged pod runs a digest-pinned image, never a registry tag,
    // since builder pods can write registry tags.
    expect(pods[0].spec.containers[0].image).toBe(REGISTRY_UPSTREAM_IMAGE)
    expect(pods[0].spec.containers[0].image).toMatch(/@sha256:[0-9a-f]{64}$/)
    expect(pods[0].spec.containers[0].securityContext).toEqual({ privileged: true, runAsUser: 0 })
    expect(pods[0].spec.tolerations).toEqual([{ operator: 'Exists' }])
    expect(logged('n1: removed 2 retired image(s)')).toBe(true)
  })

  it('keeps a node\'s image unless the registry answers that it is gone', async () => {
    stage({ nodes: [{ name: 'n1', images: [[ref(`yaac-old:${hex('6')}`)], [ref(`yaac-slow:${hex('7')}`)]] }] })
    // Only a 404 means retired; a slow or unreachable registry does not.
    vi.mocked(registryTagState).mockImplementation((repoTag: string) =>
      Promise.resolve(repoTag.startsWith('yaac-old:') ? 'absent' : 'unknown'))

    await runPass()

    expect(prunePods().flatMap(prunedRefs)).toEqual([ref(`yaac-old:${hex('6')}`)])
  })

  it('logs a collect that fails part-way through', async () => {
    await pushTag(`yaac-tools:${hex('a')}`, 30)
    await pushTag(`yaac-tools:${hex('9')}`, 20)
    await pushTag(`yaac-tools:${hex('8')}`, 10)
    stage({ collect: () => Promise.reject(new Error('collect timed out')) })

    await runPass()

    expect(logged('collect timed out')).toBe(true)
    expect(logged('collected their blobs')).toBe(false)
  })

  it('stands down while a push is in flight rather than untagging under it', async () => {
    await pushTag(`yaac-tools:${hex('a')}`, 30)
    await pushTag(`yaac-tools:${hex('9')}`, 20)
    await pushTag(`yaac-tools:${hex('8')}`, 10)
    await startUpload()
    stage()

    await runPass()

    expect(await survivors()).toContain(`yaac-tools:${hex('a')}`)
    expect(collected()).toBe(false)
    expect(logged('pushes in flight')).toBe(true)
  })

  it('re-checks for pushes after the untag and skips only the collect', async () => {
    await pushTag(`yaac-tools:${hex('a')}`, 30)
    await pushTag(`yaac-tools:${hex('9')}`, 20)
    await pushTag(`yaac-tools:${hex('8')}`, 10)
    stage({ beforeExec: (argv) => argv[2]?.includes('retired-generations') ? startUpload() : undefined })

    await runPass()

    // The tags are already untagged; the next pass collects their blobs.
    expect(await survivors()).not.toContain(`yaac-tools:${hex('a')}`)
    expect(collected()).toBe(false)
  })

  it('leaves the registry alone when nothing aged out', async () => {
    await pushTag(`yaac-tools:${hex('a')}`, 30)
    stage()

    await runPass()

    expect(collected()).toBe(false)
    expect(mockServerLog).not.toHaveBeenCalled()
  })

  it('detaches the pass so a collect cannot stall the reconcile tick', async () => {
    await pushTag(`yaac-tools:${hex('a')}`, 30)
    await pushTag(`yaac-tools:${hex('9')}`, 20)
    await pushTag(`yaac-tools:${hex('8')}`, 10)
    let release = (): void => {}
    let collectStarted = (): void => {}
    const collecting = new Promise<void>((resolve) => { release = resolve })
    const reachedCollect = new Promise<void>((resolve) => { collectStarted = resolve })
    stage({ collect: () => { collectStarted(); return collecting } })

    // Reconcile steps run in sequence, so this returns while the collect
    // runs, and a tick meanwhile does not start a second pass.
    await reconcileMainRegistryGc([DEMO], () => Promise.resolve({}))
    await reachedCollect
    const before = execs.length
    await reconcileMainRegistryGc([DEMO], () => Promise.resolve({}))
    expect(execs).toHaveLength(before)

    release()
    await _mainRegistryGcSettledForTests()
    expect(logged('collected their blobs')).toBe(true)
  })

  it('is a no-op on test-isolated installs', async () => {
    vi.stubEnv('YAAC_K8S_NAMESPACE', 'yaac-test-abc123')
    stage()
    await runPass()
    expect(execs).toEqual([])
    expect(fakeCluster.calls).toEqual([])
  })

  it('logs and moves on when there is no registry to sweep', async () => {
    stage()
    kubectl.handler = () => Promise.reject(new Error('deployments.apps "yaac-registry" not found'))

    await expect(runPass()).resolves.toBeUndefined()

    expect(logged('not found')).toBe(true)
  })
})
