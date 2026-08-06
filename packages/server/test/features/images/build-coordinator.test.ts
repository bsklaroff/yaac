/**
 * The image build coordinator — `ensureImage`, `rebuildProjectImage`,
 * `pushImageShared`.
 *
 * Nothing under features/images or features/image-engine is mocked here:
 * builder selection and the whole builder-pod flow (manifests, in-pod
 * scripts, build argv, context tar) run for real, and the fakes start at
 * kubectl, spawn, podman and the registry. A chain build is therefore
 * covered end to end by the entry point that production actually calls, and
 * the internal generators are covered by the argument sets these tests
 * drive rather than by tests of their own.
 *
 * Every layer builds in a pod unless a test says otherwise, because that is
 * what an install does; the host engine is reached the two ways production
 * reaches it, `YAAC_NESTED` and an explicit `YAAC_IMAGE_BUILDER`.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import type * as childProcessModule from 'node:child_process'
import type * as kubectlModule from '#platform/k8s/kubectl'
import type * as imageBuilderModule from '#features/image-engine/image-builder'
import type * as mainRegistryModule from '#features/cluster/main-registry'

/**
 * spawn fake: records invocations and returns an inert child that closes
 * with `spawnState.closeCode` on the next tick. Context file lists are read
 * at spawn time — builder-pod deletes the list file once tar exits.
 *
 * `spawnState.hold` keeps matching children open instead, so a test can own
 * when they speak and when they die — that is the only way to drive the
 * idle build timeout.
 */
type FakeStream = EventEmitter & {
  pipe: ReturnType<typeof vi.fn>
  setEncoding: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
}
interface FakeChild extends EventEmitter {
  stdout: FakeStream
  stderr: FakeStream
  stdin: FakeStream
  pid: number
  /** Null while running — `killGroup` refuses to signal a reaped pid. */
  exitCode: number | null
  signalCode: string | null
}
/**
 * A held child: its argv (so a test can find the one building a given tag),
 * its output tap, a clean finish, and the signals its process group got.
 */
interface HeldChild {
  args: string[]
  log: (line: string) => void
  close: (code: number) => void
  signals: string[]
}
/** Fictional pids: the process.kill spy never lets one reach the OS. */
const FAKE_PID_BASE = 990_001
const spawned = vi.hoisted(() => [] as Array<{ file: string; args: string[] }>)
const held = vi.hoisted(() => [] as HeldChild[])
/** Group pid (negative) -> what the held fake child does when signalled. */
const killers = vi.hoisted(() => new Map<number, (signal: string) => void>())
const spawnState = vi.hoisted(() => ({
  closeCode: 0,
  /** Per-command exit code, for tests where only one step fails. */
  codeFor: null as null | ((file: string, args: string[]) => number | undefined),
  hold: null as null | ((file: string, args: string[]) => boolean),
  /** Announces each held child, so a test can await one instead of polling. */
  onHold: null as null | (() => void),
}))
const tarLists = vi.hoisted(() => [] as string[][])
const readListFile = vi.hoisted(() => (listFile: string): string[] => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('node:fs') as { readFileSync: (p: string, enc: string) => string }
  return nodeFs.readFileSync(listFile, 'utf8').split('\n').filter(Boolean)
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcessModule>()
  const fakeStream = (): FakeStream => Object.assign(new EventEmitter(), {
    pipe: vi.fn(), setEncoding: vi.fn(), end: vi.fn(), destroy: vi.fn(),
  })
  return {
    ...actual,
    spawn: (file: string, args: string[]) => {
      const child = new EventEmitter() as FakeChild
      child.stdout = fakeStream()
      child.stderr = fakeStream()
      child.stdin = fakeStream()
      child.pid = FAKE_PID_BASE + spawned.length
      child.exitCode = null
      child.signalCode = null
      if (file === 'tar' && args.includes('-T')) {
        tarLists.push(readListFile(args[args.indexOf('-T') + 1]))
      }
      spawned.push({ file, args })
      if (spawnState.hold?.(file, args)) {
        const signals: string[] = []
        killers.set(-child.pid, (signal) => {
          signals.push(signal)
          child.signalCode = signal
          child.emit('exit', null, signal)
          child.emit('close', null, signal)
        })
        held.push({
          args,
          signals,
          log: (line) => child.stdout.emit('data', `${line}\n`),
          close: (code) => child.emit('close', code),
        })
        spawnState.onHold?.()
      } else {
        const code = spawnState.codeFor?.(file, args) ?? spawnState.closeCode
        process.nextTick(() => child.emit('close', code))
      }
      return child
    },
  }
})

// Only chain resolution and the host build are faked; the rest of
// image-builder (context collection, .containerignore) runs for real
// because builder-pod's context planning goes through it.
vi.mock('#features/image-engine/image-builder', async (importOriginal) => ({
  ...(await importOriginal<typeof imageBuilderModule>()),
  buildImage: vi.fn(),
  resolveImageChain: vi.fn(),
}))

vi.mock('#platform/container/runtime', () => ({
  imageExists: vi.fn().mockResolvedValue(false),
  removeImage: vi.fn().mockResolvedValue(undefined),
  ensureHostPodman: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('#platform/container/registry', () => ({
  pushImageToRegistry: vi.fn(),
  registryHasTag: vi.fn().mockResolvedValue(false),
  registryHost: vi.fn(() => 'yaac-registry.yaac.svc.cluster.local:5000'),
  registryRef: vi.fn((tag: string) => `yaac-registry.yaac.svc.cluster.local:5000/${tag}`),
}))

const mockKubectlApply = vi.hoisted(() => vi.fn())
const mockKubectlWithRetry = vi.hoisted(() => vi.fn())
const mockKubectlGetJson = vi.hoisted(() => vi.fn())
const mockEnsureKubernetes = vi.hoisted(() => vi.fn())
vi.mock('#platform/k8s/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  k8sNamespace: () => 'test-ns',
  dataDirHash: () => 'ddh0000000000000',
  kubectlApply: mockKubectlApply,
  kubectlWithRetry: mockKubectlWithRetry,
  kubectlGetJson: mockKubectlGetJson,
  ensureKubernetes: mockEnsureKubernetes,
}))

vi.mock('#features/cluster/cluster-cidrs', () => ({
  nodeIpBlocks: vi.fn().mockResolvedValue(['10.89.0.7/32']),
  apiserverIpBlocks: vi.fn().mockResolvedValue(['10.89.0.7/32']),
  resetClusterCidrCache: vi.fn(),
}))

const mockVapAvailable = vi.hoisted(() => vi.fn())
vi.mock('#features/cluster/vcluster', () => ({ vapAvailable: mockVapAvailable }))

const mockEnsureMainRegistry = vi.hoisted(() => vi.fn())
vi.mock('#features/cluster/main-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof mainRegistryModule>()),
  ensureMainRegistry: mockEnsureMainRegistry,
}))

// pipeToServerLog is the one #log name with behaviour the build path
// depends on: it is what turns a child's stdout into the lines the
// build-tracking registry ingests. Faked to split lines, not stubbed out.
vi.mock('#log', () => ({
  serverLog: vi.fn(),
  pipeToServerLog: (
    stream: { on: (ev: string, fn: (chunk: unknown) => void) => void },
    _prefix: string,
    onLine?: (line: string) => void,
  ) => {
    stream.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) if (line) onLine?.(line)
    })
  },
}))

import { ensureImage, pushImageShared, rebuildProjectImage } from '#features/images'
import { _clearBuildCoordinatorForTests } from '#features/images/build-coordinator'
import { buildImage, resolveImageChain, type ImageLayer } from '#features/image-engine/image-builder'
import { imageExists, removeImage } from '#platform/container/runtime'
import { pushImageToRegistry, registryHasTag } from '#platform/container/registry'
import { clearAllImageBuildsForTests, listImageBuilds } from '#features/image-engine/image-builds'
// Bounds and layout constants: expected values, not units under test.
import {
  BUILDER_ACTIVE_DEADLINE_SECONDS,
  BUILDER_BUILD_IDLE_TIMEOUT_MS,
  BUILDER_CONTEXT_DIR,
  BUILDER_GRAPHROOT_SIZELIMIT_BYTES,
  BUILDER_GRAPHROOT_TMPFS_BYTES,
  BUILDER_CPU_REQUEST_MILLIS,
  BUILDER_LOCAL_TAG,
  BUILDER_MEMORY_LIMIT_BYTES,
  BUILDER_MEMORY_REQUEST_BYTES,
  BUILDER_UPSTREAM_IMAGE,
  SHIPPED_BUILD_CACHE_REPO,
} from '#features/image-engine/builder-pod'
import { BUILDER_CONTEXT_MAX_BYTES } from '#platform/build-context'
import type { ImageLayerName } from '@yaac/shared/types'

const mockBuildImage = vi.mocked(buildImage)
const mockResolveChain = vi.mocked(resolveImageChain)
const mockImageExists = vi.mocked(imageExists)
const mockRemoveImage = vi.mocked(removeImage)
const mockPush = vi.mocked(pushImageToRegistry)
const mockHasTag = vi.mocked(registryHasTag)

const CLUSTER_HOST = 'yaac-registry.yaac.svc.cluster.local:5000'
const LAYERED_DOCKERFILE = 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n'

/**
 * A context every layer whose own files are beside the point can share.
 * Real, not fake: a pod build streams its context in, so the coordinator's
 * every path now stats and tars actual files.
 */
let SHARED_CTX = ''
beforeAll(async () => {
  // Untracked: the per-test cleanup wipes what it made, and this outlives it.
  SHARED_CTX = await makeContext({ Dockerfile: LAYERED_DOCKERFILE }, false)
})

/** A layer over the shared context — for tests about chains, not contexts. */
function layer(
  tag: string,
  name: ImageLayerName = 'base',
  over: Partial<ImageLayer> = {},
): ImageLayer {
  return {
    tag,
    name,
    dockerfile: path.join(SHARED_CTX, 'Dockerfile'),
    context: SHARED_CTX,
    contentHash: 'h',
    ...over,
  }
}

const tmpDirs: string[] = []
async function makeContext(files: Record<string, string>, track = true): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-coord-test-'))
  if (track) tmpDirs.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await fs.writeFile(path.join(dir, rel), content)
  }
  return dir
}

/** An untrusted layer over a real on-disk context — builds in a pod. */
async function podLayer(over: Partial<ImageLayer> = {}, files?: Record<string, string>): Promise<ImageLayer> {
  const dir = await makeContext(files ?? { 'Dockerfile.yaac': LAYERED_DOCKERFILE })
  return {
    tag: 'yaac-base:p1',
    name: 'project',
    dockerfile: path.join(dir, 'Dockerfile.yaac'),
    context: dir,
    buildArgs: { BASE_IMAGE: 'yaac-tools:t1' },
    contentHash: 'p1',
    ...over,
  }
}

function chain(layers: ImageLayer[]): void {
  mockResolveChain.mockResolvedValue({ layers, finalTag: layers.at(-1)!.tag })
}

interface PodManifest {
  metadata: { name: string; namespace: string; labels: Record<string, string>; annotations: Record<string, string> }
  spec: {
    restartPolicy: string
    activeDeadlineSeconds: number
    automountServiceAccountToken: boolean
    enableServiceLinks: boolean
    runtimeClassName: string
    priorityClassName: string
    securityContext: { seccompProfile: { type: string } }
    containers: Array<{
      image: string
      imagePullPolicy: string
      command: string[]
      securityContext: { capabilities: { add: string[] } }
      resources: {
        requests: Record<string, string>
        limits: { memory: string }
      }
      volumeMounts: Array<{ name: string; mountPath: string }>
    }>
    volumes: Array<{ name: string; emptyDir: { sizeLimit: string } }>
  }
}

const appliedKinds = (): string[] =>
  mockKubectlApply.mock.calls.map((c) => (c[0] as { kind: string }).kind)

function appliedOfKind<T>(kind: string): T {
  const found = mockKubectlApply.mock.calls
    .map((c) => c[0] as { kind: string })
    .find((m) => m.kind === kind)
  expect(found, `no ${kind} was applied`).toBeDefined()
  return found as T
}

/** The remote argv of each in-pod `kubectl exec`, in order. */
const remoteCommands = (): string[][] =>
  spawned.filter((s) => s.file === 'kubectl')
    .map((s) => s.args.slice(s.args.indexOf('--') + 1))

const deleteCalls = (): string[][] =>
  mockKubectlWithRetry.mock.calls
    .map((c) => c[0] as string[])
    .filter((args) => args[0] === 'delete')

interface Deferred {
  promise: Promise<void>
  resolve: () => void
  reject: (err: Error) => void
}
function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (err: Error) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/**
 * Park every in-pod `podman build` so a test owns when each layer finishes.
 * The steps around it (storage bootstrap, parent pull, context tar, push)
 * still complete on their own.
 */
function holdPodBuilds(): void {
  spawnState.hold = (file, args) => file === 'kubectl' && args.includes('build')
}

/** The parked in-pod build of `tag`, once it exists. */
async function parkedBuild(tag: string): Promise<HeldChild> {
  await vi.waitFor(() => {
    expect(held.some((h) => h.args.includes(tag)), `no parked build of ${tag}`).toBe(true)
  })
  return held.find((h) => h.args.includes(tag))!
}

/** Tags whose in-pod `podman build` ran, in order. */
const builtTags = (): string[] =>
  remoteCommands()
    .filter((argv) => argv[0] === 'podman' && argv[1] === 'build')
    .map((argv) => argv[argv.indexOf('-t') + 1])

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.clearAllMocks()
  _clearBuildCoordinatorForTests()
  clearAllImageBuildsForTests()
  spawned.length = 0
  tarLists.length = 0
  held.length = 0
  killers.clear()
  spawnState.closeCode = 0
  spawnState.codeFor = null
  spawnState.hold = null
  spawnState.onHold = null
  // Held children are killed by pid (negated: the group). Spied, so a
  // fictional pid can never reach a real process group.
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal: string) => {
    const die = killers.get(pid)
    if (!die) throw new Error(`ESRCH: unexpected process.kill(${pid})`)
    die(signal)
    return true
  }) as typeof process.kill)
  mockImageExists.mockResolvedValue(false)
  // Registry state, the process boundary the builder pod's own image
  // ensure also crosses: only the pinned podman-stable mirror is present,
  // so `ensureBuilderImage` resolves to its ref without pulling or pushing.
  mockHasTag.mockImplementation((tag: string) => Promise.resolve(tag === BUILDER_LOCAL_TAG))
  mockRemoveImage.mockResolvedValue(undefined)
  mockVapAvailable.mockResolvedValue(true)
  mockEnsureKubernetes.mockResolvedValue(undefined)
  mockEnsureMainRegistry.mockResolvedValue(undefined)
  mockKubectlApply.mockResolvedValue(undefined)
  mockKubectlWithRetry.mockResolvedValue({ stdout: '', stderr: '' })
  mockKubectlGetJson.mockResolvedValue(null)
})

afterEach(async () => {
  _clearBuildCoordinatorForTests()
  clearAllImageBuildsForTests()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  for (const dir of tmpDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

describe('ensureImage', () => {
  it('coalesces a shared layer across chains and fans out the distinct ones', async () => {
    const base = layer('yaac-base:shared')
    mockResolveChain.mockImplementation((slug: string) => Promise.resolve({
      layers: [base, layer(`yaac-tools-${slug}:x`, 'tools')],
      finalTag: `yaac-tools-${slug}:x`,
    }))
    holdPodBuilds()

    const a = ensureImage('proj-a', undefined, false, false, { reason: 'prewarm' })
    const b = ensureImage('proj-b', undefined, false, false, { reason: 'prewarm' })

    // Both chains wait on ONE base build, and both projects attach to its
    // single registry entry — even though each owns its own builder pod.
    const sharedBase = await parkedBuild('yaac-base:shared')
    await flush()
    expect(builtTags()).toEqual(['yaac-base:shared'])
    expect(listImageBuilds()[0]).toMatchObject({ projectSlugs: ['proj-a', 'proj-b'], status: 'running' })

    // Base resolves → both downstream layers build in parallel.
    sharedBase.close(0)
    await vi.waitFor(() => { expect(builtTags()).toHaveLength(3) })
    expect(builtTags().slice(1).sort())
      .toEqual(['yaac-tools-proj-a:x', 'yaac-tools-proj-b:x'])

    ;(await parkedBuild('yaac-tools-proj-a:x')).close(0)
    ;(await parkedBuild('yaac-tools-proj-b:x')).close(0)
    expect(await a).toBe('yaac-tools-proj-a:x')
    expect(await b).toBe('yaac-tools-proj-b:x')
    expect(listImageBuilds().every((e) => e.status === 'succeeded')).toBe(true)
  })

  it('propagates a build failure to every waiter and marks the entry failed', async () => {
    chain([layer('yaac-base:x')])
    holdPodBuilds()
    const a = ensureImage('proj-a')
    const b = ensureImage('proj-b')

    ;(await parkedBuild('yaac-base:x')).close(1)
    await expect(a).rejects.toThrow('exited with code 1')
    await expect(b).rejects.toThrow('exited with code 1')

    expect(listImageBuilds()[0]).toMatchObject({ status: 'failed' })
    expect(listImageBuilds()[0].error).toContain('exited with code 1')
    // A failed tag is not memoized as realized — the next ensure retries,
    // and the pod that failed under it was deleted rather than leaked. One
    // pod, not two: the joiner shares the winner's build and never leases
    // a builder of its own.
    expect(deleteCalls()).toHaveLength(1)
    held.length = 0
    const again = ensureImage('proj-a')
    ;(await parkedBuild('yaac-base:x')).close(0)
    await again
  })

  it('fans build output into the registry log', async () => {
    chain([layer('t:1')])
    holdPodBuilds()
    const build = ensureImage('proj')
    const held0 = await parkedBuild('t:1')
    held0.log('STEP 1/2: FROM ubuntu')
    await vi.waitFor(() => {
      expect(listImageBuilds()[0]).toMatchObject({ stepCurrent: 1, stepTotal: 2 })
    })
    held0.close(0)
    await build
  })

  it('skips present tags and memoizes the verification for the rest of the run', async () => {
    chain([layer('t:1'), layer('t:2', 'tools')])
    // The registry is what a pod-built tag is verified against — the host
    // store never holds one.
    mockHasTag.mockImplementation((tag: string) =>
      Promise.resolve(tag === 't:1' || tag === BUILDER_LOCAL_TAG))

    await ensureImage('proj')
    expect(builtTags()).toEqual(['t:2'])
    expect(mockHasTag.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['t:1', 't:2']))

    // Content-hash tags are immutable: neither the probed nor the freshly
    // built tag is re-checked on the next ensure.
    mockHasTag.mockClear()
    mockKubectlApply.mockClear()
    spawned.length = 0
    await ensureImage('proj')
    expect(mockHasTag.mock.calls.map((c) => c[0])).not.toContain('t:1')
    expect(builtTags()).toEqual([])
    // Nothing to build means no pod at all.
    expect(appliedKinds()).not.toContain('Pod')
  })

  it('reports layer starts with 1-based chain positions', async () => {
    chain([layer('t:1'), layer('t:2', 'tools')])
    const starts: string[] = []
    await ensureImage('proj', undefined, false, false, {
      onLayerStart: (i, total, name) => starts.push(`${i}/${total} ${name}`),
    })
    expect(starts).toEqual(['1/2 base', '2/2 tools'])
  })

  it('throws under requirePrebuilt without building or registering', async () => {
    chain([layer('t:1')])
    await expect(ensureImage('proj', undefined, true)).rejects.toThrow('missing or stale')
    expect(builtTags()).toEqual([])
    expect(listImageBuilds()).toEqual([])
  })

  it('builds a layer in a gvisor builder pod and pushes the product', async () => {
    // The whole cluster-pod path in one pass: pod manifest, storage
    // bootstrap, parent pull, context tar, cached build, delta push, pod
    // teardown.
    const tools = layer('yaac-tools:t1', 'tools')
    const project = await podLayer({}, {
      'Dockerfile.yaac': LAYERED_DOCKERFILE,
      'keep.txt': 'k',
      'skipped/file.txt': 's',
      '.containerignore': 'skipped\n',
    })
    chain([tools, project])
    // The parent is already in the registry, so only the project layer builds.
    mockHasTag.mockImplementation((tag: string) =>
      Promise.resolve(tag === tools.tag || tag === BUILDER_LOCAL_TAG))

    await ensureImage('proj')

    // Nothing host-side: no build, and no push either — the pod's own push
    // is what makes the product exist at all.
    expect(mockBuildImage).not.toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()

    // Infra ensured, then the role guard, egress policy and pod applied.
    expect(mockEnsureKubernetes).toHaveBeenCalled()
    expect(mockEnsureMainRegistry).toHaveBeenCalled()
    expect(appliedKinds()).toEqual(expect.arrayContaining([
      'ValidatingAdmissionPolicy', 'ValidatingAdmissionPolicyBinding', 'NetworkPolicy', 'Pod',
    ]))

    const pod = appliedOfKind<PodManifest>('Pod')
    expect(pod.metadata.name).toMatch(/^yaac-builder-[0-9a-f]{8}-[0-9a-f]{4}$/)
    expect(pod.metadata.namespace).toBe('test-ns')
    expect(pod.metadata.labels).toEqual({
      'yaac.data-dir-hash': 'ddh0000000000000',
      'yaac.role': 'builder',
    })
    // Sandboxed, bounded and unprivileged pod-side.
    expect(pod.spec.runtimeClassName).toBe('gvisor')
    // Above sessions for eviction, but on the no-preemption tier: a build
    // must never displace a running session to start.
    expect(pod.spec.priorityClassName).toBe('yaac-builder')
    expect(pod.spec.restartPolicy).toBe('Never')
    expect(pod.spec.activeDeadlineSeconds).toBe(BUILDER_ACTIVE_DEADLINE_SECONDS)
    expect(pod.spec.automountServiceAccountToken).toBe(false)
    expect(pod.spec.enableServiceLinks).toBe(false)
    expect(pod.spec.securityContext.seccompProfile.type).toBe('RuntimeDefault')
    expect(pod.spec.containers[0].resources.limits.memory).toBe(String(BUILDER_MEMORY_LIMIT_BYTES))
    // Requested explicitly, well under the limit: kubernetes defaults an
    // omitted request UP TO the limit, which would reserve the whole 8Gi
    // ceiling — 8 sessions' worth of node — for one routine build.
    expect(pod.spec.containers[0].resources.requests).toEqual({
      cpu: `${BUILDER_CPU_REQUEST_MILLIS}m`,
      memory: String(BUILDER_MEMORY_REQUEST_BYTES),
    })
    expect(BUILDER_MEMORY_REQUEST_BYTES).toBeLessThan(BUILDER_MEMORY_LIMIT_BYTES)
    expect(pod.spec.containers[0].command).toEqual(['sleep', 'infinity'])
    // The pinned podman-stable mirror — never the session's user-customizable
    // image.
    expect(pod.spec.containers[0].image).toBe(`${CLUSTER_HOST}/${BUILDER_LOCAL_TAG}`)
    expect(pod.spec.containers[0].imagePullPolicy).toBe('IfNotPresent')
    expect(pod.spec.containers[0].securityContext.capabilities.add).toContain('SETFCAP')
    // Graphroot on a sentry tmpfs emptyDir.
    expect(pod.metadata.annotations['dev.gvisor.spec.mount.podman-graphroot.type']).toBe('bind')
    expect(pod.metadata.annotations['dev.gvisor.spec.mount.podman-graphroot.options'])
      .toBe(`rw,size=${BUILDER_GRAPHROOT_TMPFS_BYTES}`)
    expect(pod.spec.volumes).toEqual([{
      name: 'podman-graphroot',
      emptyDir: { sizeLimit: String(BUILDER_GRAPHROOT_SIZELIMIT_BYTES) },
    }])
    expect(pod.spec.containers[0].volumeMounts).toEqual([{
      name: 'podman-graphroot', mountPath: '/var/lib/containers',
    }])

    const np = appliedOfKind<{
      spec: { podSelector: { matchLabels: Record<string, string> }; policyTypes: string[]; egress: unknown[] }
    }>('NetworkPolicy')
    expect(np.spec.podSelector.matchLabels).toEqual({ 'yaac.role': 'builder' })
    expect(np.spec.policyTypes).toEqual(['Egress'])
    expect(np.spec.egress).toEqual([{}])

    // storage.conf bootstrap, parent pull, extract, build, push — in order.
    const remote = remoteCommands()
    expect(remote).toHaveLength(5)
    // Native overlay: the stock image forces fuse-overlayfs, broken on runsc.
    expect(remote[0][2]).toContain('driver = "overlay"')
    expect(remote[0][2]).not.toContain('fuse-overlayfs')
    expect(remote[0][2]).toContain('enable_partial_images = "true"')
    expect(remote[0][2]).toContain('graphroot = "/var/lib/containers/storage"')
    // Parent materialized under the bare tag so --build-arg BASE_IMAGE matches.
    expect(remote[1][2]).toContain(`podman pull --tls-verify=false ${CLUSTER_HOST}/${tools.tag}`)
    expect(remote[1][2]).toContain(`podman tag ${CLUSTER_HOST}/${tools.tag} ${tools.tag}`)
    expect(remote[1][2]).toContain(`if podman image exists ${tools.tag}; then exit 0; fi`)
    expect(remote[2][2]).toContain(`tar -xf - -C ${BUILDER_CONTEXT_DIR}`)
    // Build: chroot isolation, per-project registry step cache.
    expect(remote[3].slice(0, 4)).toEqual(['podman', 'build', '--isolation', 'chroot'])
    expect(remote[3]).toContain(project.tag)
    const cacheRef = `${CLUSTER_HOST}/yaac-buildcache-project-proj`
    expect(remote[3].join(' '))
      .toContain(`--cache-from ${cacheRef} --cache-to ${cacheRef} --cache-ttl 168h`)
    expect(remote[3].join(' ')).toContain(`-f ${BUILDER_CONTEXT_DIR}/Dockerfile.yaac`)
    expect(remote[3].join(' ')).toContain(`--build-arg BASE_IMAGE=${tools.tag}`)
    expect(remote[3].at(-1)).toBe(BUILDER_CONTEXT_DIR)
    expect(remote[4].slice(0, 3)).toEqual(['podman', 'push', '--tls-verify=false'])
    expect(remote[4]).toContain(`${CLUSTER_HOST}/${project.tag}`)

    // Context honors .containerignore exactly like contextHash().
    expect(tarLists[0]).toEqual(expect.arrayContaining(['keep.txt', '.containerignore', 'Dockerfile.yaac']))
    expect(tarLists[0].some((f) => f.startsWith('skipped/'))).toBe(false)

    // ensureImage owns the builder, so the pod dies with the chain.
    expect(deleteCalls()).toHaveLength(1)
    expect(deleteCalls()[0]).toContain(pod.metadata.name)
  })

  it('builds a whole cold chain in one pod, each parent already local', async () => {
    // The shipped layers used to build on the host and be pushed so a pod
    // could pull them back. In one pod they are simply there: only the
    // first layer has no parent to resolve, and no layer pulls one.
    const base = layer('yaac-base:c1')
    const tools = layer('yaac-tools:c2', 'tools', { buildArgs: { BASE_IMAGE: base.tag } })
    const project = await podLayer({ tag: 'yaac-base:c3', buildArgs: { BASE_IMAGE: tools.tag } })
    chain([base, tools, project])

    await ensureImage('proj')

    expect(builtTags()).toEqual([base.tag, tools.tag, project.tag])
    // One pod for the chain, deleted once.
    expect(mockKubectlApply.mock.calls
      .filter((c) => (c[0] as { kind: string }).kind === 'Pod')).toHaveLength(1)
    expect(deleteCalls()).toHaveLength(1)
    // Every layer pushes its own product: the graphroot dies with the pod,
    // so an unpushed layer would be lost.
    const pushes = remoteCommands().filter((argv) => argv[1] === 'push')
    expect(pushes.map((argv) => argv.at(-1))).toEqual([
      `${CLUSTER_HOST}/${base.tag}`,
      `${CLUSTER_HOST}/${tools.tag}`,
      `${CLUSTER_HOST}/${project.tag}`,
    ])
    // No parent is fetched: every pull is the guarded form, which exits
    // before pulling because the pod just built the tag.
    for (const argv of remoteCommands().filter((a) => a.join(' ').includes('podman pull'))) {
      expect(argv[2]).toMatch(/^if podman image exists \S+; then exit 0; fi$/m)
    }
  })

  it('caches the shipped layers apart from a project\'s own', async () => {
    // The shipped layers are identical across projects, so they share one
    // cache repo; the project's own layers must not read or write it.
    const tools = layer('yaac-tools:t1', 'tools')
    const project = await podLayer({ buildArgs: { BASE_IMAGE: tools.tag } })
    chain([tools, project])

    await ensureImage('proj')

    const cacheRepos = remoteCommands()
      .filter((argv) => argv[1] === 'build')
      .map((argv) => argv[argv.indexOf('--cache-to') + 1])
    expect(cacheRepos).toEqual([
      `${CLUSTER_HOST}/${SHIPPED_BUILD_CACHE_REPO}`,
      `${CLUSTER_HOST}/yaac-buildcache-project-proj`,
    ])
    // No project slug can be sanitized into the shipped repo's name.
    expect(SHIPPED_BUILD_CACHE_REPO).not.toMatch(/^yaac-buildcache-project-/)
  })

  it('refuses to build a shipped layer in a pod that ran a project one', async () => {
    // The chain order that makes this unrepresentable is `push()` calls in
    // resolveImageChain; the lease is where the consequence would land, so
    // it does not take that on faith. A future layer appended after
    // `project` gets a fresh pod rather than the tainted one.
    const project = await podLayer({ tag: 'yaac-base:t1', buildArgs: undefined })
    const shipped = layer('yaac-tools:t2', 'tools', { buildArgs: { BASE_IMAGE: project.tag } })
    chain([project, shipped])

    await ensureImage('proj')

    const pods = mockKubectlApply.mock.calls
      .map((c) => c[0] as { kind: string; metadata: { name: string } })
      .filter((m) => m.kind === 'Pod')
    expect(pods).toHaveLength(2)
    expect(pods[0].metadata.name).not.toBe(pods[1].metadata.name)
    // Both are deleted — the tainted one when it is replaced, the second
    // when the chain ends.
    expect(deleteCalls()).toHaveLength(2)
    // The fresh pod has no local parent, so it pulls the tainted pod's
    // product from the registry like any first layer would.
    expect(remoteCommands().filter((argv) => argv.join(' ').includes('podman pull')))
      .toHaveLength(1)
  })

  it('keeps one pod for a chain whose shipped layers come first', async () => {
    // The ordinary shape, and the reason the taint check is not just a
    // blanket fresh-pod-per-layer rule.
    const tools = layer('yaac-tools:o1', 'tools')
    const project = await podLayer({ buildArgs: { BASE_IMAGE: tools.tag } })
    chain([tools, project])
    await ensureImage('proj')
    expect(mockKubectlApply.mock.calls
      .filter((c) => (c[0] as { kind: string }).kind === 'Pod')).toHaveLength(1)
  })

  it('retries a builder pod on the upstream image when the mirror will not run', async () => {
    // registryHasTag answers on the manifest, so a mirror whose blobs a
    // registry collect took out from under it still reads present. Without
    // this retry that is every build on the install failing to schedule,
    // recoverable only by deleting the mirror tag by hand.
    const podImage = (): string[] => mockKubectlApply.mock.calls
      .map((c) => c[0] as { kind: string; spec?: { containers: Array<{ image: string }> } })
      .filter((m) => m.kind === 'Pod')
      .map((m) => m.spec!.containers[0].image)
    let waits = 0
    mockKubectlWithRetry.mockImplementation((args: string[]) => {
      if (args[0] !== 'wait') return Promise.resolve({ stdout: '', stderr: '' })
      waits += 1
      return waits === 1
        ? Promise.reject(new Error('timed out waiting for the condition'))
        : Promise.resolve({ stdout: '', stderr: '' })
    })
    chain([await podLayer({ buildArgs: undefined })])

    await ensureImage('proj')

    expect(podImage()).toEqual([`${CLUSTER_HOST}/${BUILDER_LOCAL_TAG}`, BUILDER_UPSTREAM_IMAGE])
  })

  it('does not retry when the pod was already on the upstream image', async () => {
    mockHasTag.mockResolvedValue(false)
    mockKubectlWithRetry.mockImplementation((args: string[]) =>
      args[0] === 'wait'
        ? Promise.reject(new Error('timed out waiting for the condition'))
        : Promise.resolve({ stdout: '', stderr: '' }))
    chain([await podLayer({ buildArgs: undefined })])

    await expect(ensureImage('proj')).rejects.toThrow('timed out')
    expect(mockKubectlApply.mock.calls
      .filter((c) => (c[0] as { kind: string }).kind === 'Pod')).toHaveLength(1)
  })

  it('falls back to the upstream builder image when no mirror exists', async () => {
    // The bootstrap floor: a builder pod cannot be the source of its own
    // image, so an install with an empty registry still gets one.
    mockHasTag.mockResolvedValue(false)
    chain([layer('t:1')])
    await ensureImage('proj')
    expect(appliedOfKind<PodManifest>('Pod').spec.containers[0].image)
      .toBe(BUILDER_UPSTREAM_IMAGE)
  })

  it('ships a parentless layer without a pull, and its dockerfile even when ignored', async () => {
    const project = await podLayer(
      { buildArgs: { YAAC_UID: '1000' } },
      { 'Dockerfile.yaac': 'FROM ubuntu\n', '.containerignore': 'Dockerfile.yaac\n' },
    )
    chain([project])
    await ensureImage('proj')

    const scripts = remoteCommands().map((argv) => argv.join(' '))
    expect(scripts.some((s) => s.includes('podman pull'))).toBe(false)
    expect(scripts.some((s) => s.includes('--build-arg YAAC_UID=1000'))).toBe(true)
    // The dockerfile always ships, ignore file or not.
    expect(tarLists[0]).toContain('Dockerfile.yaac')
  })

  it('sanitizes the project slug into a valid OCI cache repo', async () => {
    chain([await podLayer({ buildArgs: undefined })])
    await ensureImage('My Project!')
    expect(remoteCommands()[2].join(' ')).toContain(`${CLUSTER_HOST}/yaac-buildcache-project-my-project-`)
  })

  it('consults the registry for realized tags, never the host store', async () => {
    const tools = layer('yaac-tools:t1', 'tools')
    const project = await podLayer()
    chain([tools, project])
    mockImageExists.mockResolvedValue(true) // a stale host store must not count
    mockHasTag.mockResolvedValue(true)

    await ensureImage('proj')
    expect(mockHasTag).toHaveBeenCalledWith(project.tag)
    expect(mockImageExists).not.toHaveBeenCalled()
    expect(appliedKinds()).not.toContain('Pod')
  })

  it('builds on the in-pod engine in a nested install, and on request', async () => {
    // A nested install's engine IS the outer sandbox; an inner builder pod
    // would be an unvalidated vcluster pod and strictly worse.
    vi.stubEnv('YAAC_NESTED', '1')
    chain([layer('yaac-base:n1'), layer('yaac-user:n2', 'user')])
    mockBuildImage.mockResolvedValue(undefined)
    await ensureImage('proj')
    expect(appliedKinds()).not.toContain('Pod')
    expect(mockBuildImage.mock.calls.map((c) => c[0])).toEqual(['yaac-base:n1', 'yaac-user:n2'])
    // The host store is the authority there, and its products still have to
    // be pushed before a session pod can pull them.
    expect(mockImageExists).toHaveBeenCalled()

    // The same backend is reachable by request on a machine that would
    // rather pay its own podman than the sandbox tax.
    _clearBuildCoordinatorForTests()
    vi.unstubAllEnvs()
    vi.stubEnv('YAAC_IMAGE_BUILDER', 'host-podman')
    mockBuildImage.mockClear()
    chain([layer('yaac-base:h1')])
    await ensureImage('proj')
    expect(appliedKinds()).not.toContain('Pod')
    expect(mockBuildImage.mock.calls.map((c) => c[0])).toEqual(['yaac-base:h1'])
  })

  it('fails closed when the ValidatingAdmissionPolicy API is unavailable', async () => {
    mockVapAvailable.mockResolvedValue(false)
    chain([await podLayer({ buildArgs: undefined })])
    await expect(ensureImage('proj')).rejects.toThrow(/ValidatingAdmissionPolicy/)
    // Without the guard the builder role label is forgeable — no pod may exist.
    expect(appliedKinds()).not.toContain('Pod')
  })

  it('maps an unreachable cluster to a `yaac cluster check` pointer', async () => {
    mockEnsureKubernetes.mockRejectedValue(new Error('no cluster'))
    chain([await podLayer({ buildArgs: undefined })])
    await expect(ensureImage('proj')).rejects.toThrow(/yaac cluster check/)
  })

  it('explains a Ready timeout with whatever the pod status accounts for', async () => {
    // A bare `kubectl wait` timeout reads as a broken build; the node
    // refusing to schedule the pod is the far likelier cause.
    mockKubectlWithRetry.mockImplementation((args: string[]) =>
      args[0] === 'wait'
        ? Promise.reject(new Error('timed out'))
        : Promise.resolve({ stdout: '', stderr: '' }))
    const unschedulable = {
      status: {
        conditions: [{
          type: 'PodScheduled', status: 'False', reason: 'Unschedulable',
          message: '0/1 nodes are available: 1 Insufficient memory.',
        }],
      },
    }
    mockKubectlGetJson.mockImplementation((args: string[]) =>
      Promise.resolve(args[1] === 'pod' ? unschedulable : null))
    chain([await podLayer({ buildArgs: undefined })])
    await expect(ensureImage('proj'))
      .rejects.toThrow(/not scheduled \(Unschedulable\): 0\/1 nodes are available/)
    // The pod is torn down even though provisioning failed after apply.
    expect(deleteCalls().length).toBeGreaterThan(0)

    // A container stuck pulling is named the same way.
    _clearBuildCoordinatorForTests()
    mockKubectlGetJson.mockImplementation((args: string[]) => Promise.resolve(
      args[1] === 'pod'
        ? {
          status: {
            conditions: [{ type: 'PodScheduled', status: 'True' }],
            containerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff' } } }],
          },
        }
        : null))
    chain([await podLayer({ tag: 'yaac-base:p2', buildArgs: undefined })])
    await expect(ensureImage('proj')).rejects.toThrow(/container waiting \(ImagePullBackOff\)/)

    // A status that explains nothing leaves the bare timeout.
    _clearBuildCoordinatorForTests()
    mockKubectlGetJson.mockResolvedValue({ status: {} })
    chain([await podLayer({ tag: 'yaac-base:p3', buildArgs: undefined })])
    await expect(ensureImage('proj')).rejects.toThrow('timed out')
  })

  it('kills an in-pod build only once it stops producing output', async () => {
    // The in-pod build budget is idle, not total: a slow layer that keeps
    // logging must outlive it, and only silence ends the build.
    spawnState.hold = (file, args) => file === 'kubectl' && args.includes('build')
    const reachedBuild = new Promise<void>((r) => { spawnState.onHold = r })
    chain([await podLayer({ buildArgs: undefined })])
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const build = ensureImage('proj')
    const settled = vi.fn()
    void build.then(settled, settled)

    // The steps before the build (context stat, tar) are filesystem IO,
    // which no amount of timer advancing completes — wait them out for real.
    await reachedBuild
    expect(held).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(BUILDER_BUILD_IDLE_TIMEOUT_MS - 1_000)
    held[0].log('STEP 2/5: RUN cargo build --release')
    await vi.advanceTimersByTimeAsync(BUILDER_BUILD_IDLE_TIMEOUT_MS - 1_000)
    expect(settled).not.toHaveBeenCalled()
    expect(held[0].signals).toEqual([])

    await vi.advanceTimersByTimeAsync(2_000)
    await expect(build).rejects.toThrow(
      /builder exec \[podman build .*\] produced no output for 600s/,
    )
    expect(held[0].signals).toEqual(['SIGTERM'])
    // The pod the wedged build was holding is released, not leaked.
    expect(deleteCalls().length).toBeGreaterThan(0)
  })

  it('blames the whole-pod deadline when the pod dies under the build', async () => {
    // A build that keeps printing never trips an idle budget, so the pod's
    // deadline is what ends it — and kubectl, whose connection died with the
    // pod, can only report a signal. The pod's own status has the reason.
    spawnState.codeFor = (file, args) =>
      (file === 'kubectl' && args.includes('build') ? 137 : undefined)
    mockKubectlGetJson.mockImplementation((args: string[]) => Promise.resolve(
      args[1] === 'pod' ? { status: { phase: 'Failed', reason: 'DeadlineExceeded' } } : null,
    ))
    chain([await podLayer({ buildArgs: undefined })])

    await expect(ensureImage('proj')).rejects.toThrow(
      /exited with code 137[\s\S]*stopped at the whole-pod deadline/,
    )
  })

  it('rejects a dockerfile outside its context, and an oversized context', async () => {
    const dir = await makeContext({ 'Dockerfile.yaac': 'FROM x' })
    chain([{
      tag: 'yaac-base:o1', name: 'project', dockerfile: '/elsewhere/Dockerfile',
      context: dir, contentHash: 'o1',
    }])
    await expect(ensureImage('proj')).rejects.toThrow(/outside its build context/)

    _clearBuildCoordinatorForTests()
    // Sparse file: st_size crosses the cap without touching the disk.
    const fh = await fs.open(path.join(dir, 'big.bin'), 'w')
    await fh.truncate(BUILDER_CONTEXT_MAX_BYTES + 1)
    await fh.close()
    chain([{
      tag: 'yaac-base:o2', name: 'project', dockerfile: path.join(dir, 'Dockerfile.yaac'),
      context: dir, contentHash: 'o2',
    }])
    await expect(ensureImage('proj')).rejects.toThrow(/\.containerignore/)
  })
})

describe('pushImageShared', () => {
  it('is satisfied by the build itself on the cluster backend', async () => {
    // A pod build ENDS in the registry, so there is nothing to push and
    // nowhere to push it from — not even for a forced rebuild, whose fresh
    // bytes the pod already wrote over the tag. Inventing a push row here
    // would report work that never happens.
    mockHasTag.mockResolvedValue(false)
    const ref = await pushImageShared('t:1', { projectSlug: 'a', reason: 'rebuild' }, { force: true })
    expect(ref).toBe(`${CLUSTER_HOST}/t:1`)
    expect(mockPush).not.toHaveBeenCalled()
    expect(listImageBuilds()).toEqual([])
  })

  describe('on the host backend', () => {
    // The push only exists where a build lands in a local store first: a
    // nested install, or a machine that asked for its own podman.
    beforeEach(() => { vi.stubEnv('YAAC_IMAGE_BUILDER', 'host-podman') })

    it('returns the ref without pushing or registering when the tag is present', async () => {
      mockHasTag.mockResolvedValue(true)
      const ref = await pushImageShared('t:1', { projectSlug: 'a', reason: 'prewarm' })
      expect(ref).toBe(`${CLUSTER_HOST}/t:1`)
      expect(mockPush).not.toHaveBeenCalled()
      expect(listImageBuilds()).toEqual([])
    })

    it('pushes even a present tag when forced (the store holds fresh bytes)', async () => {
      mockHasTag.mockResolvedValue(true)
      mockImageExists.mockResolvedValue(true)
      mockPush.mockResolvedValue(`${CLUSTER_HOST}/t:1`)
      await pushImageShared('t:1', { projectSlug: 'a', reason: 'rebuild' }, { force: true })
      expect(mockPush).toHaveBeenCalledTimes(1)
      expect(mockPush.mock.calls[0][1]).toMatchObject({ force: true })
    })

    it('treats a forced push of a registry-only tag as already satisfied', async () => {
      // Nothing local to push: whoever put it in the registry pushed it.
      mockHasTag.mockResolvedValue(true)
      mockImageExists.mockResolvedValue(false)
      const ref = await pushImageShared('t:1', { projectSlug: 'a', reason: 'rebuild' }, { force: true })
      expect(ref).toBe(`${CLUSTER_HOST}/t:1`)
      expect(mockPush).not.toHaveBeenCalled()
    })

    it('caches a verified registry tag — the second push skips even the HEAD', async () => {
      mockHasTag.mockResolvedValue(true)
      await pushImageShared('t:1', { projectSlug: 'a', reason: 'session' })
      mockHasTag.mockClear()

      const ref = await pushImageShared('t:1', { projectSlug: 'a', reason: 'session' })
      expect(ref).toBe(`${CLUSTER_HOST}/t:1`)
      expect(mockHasTag).not.toHaveBeenCalled()
    })

    it('caches a completed push the same way', async () => {
      mockHasTag.mockResolvedValue(false)
      mockPush.mockResolvedValue(`${CLUSTER_HOST}/t:1`)
      await pushImageShared('t:1', { projectSlug: 'a', reason: 'session' })
      mockHasTag.mockClear()
      mockPush.mockClear()

      await pushImageShared('t:1', { projectSlug: 'a', reason: 'session' })
      expect(mockHasTag).not.toHaveBeenCalled()
      expect(mockPush).not.toHaveBeenCalled()
    })

    it('a forced push bypasses the cache (rebuilds change bytes under the tag)', async () => {
      mockHasTag.mockResolvedValue(true)
      mockImageExists.mockResolvedValue(true)
      mockPush.mockResolvedValue(`${CLUSTER_HOST}/t:1`)
      await pushImageShared('t:1', { projectSlug: 'a', reason: 'session' })

      await pushImageShared('t:1', { projectSlug: 'a', reason: 'rebuild' }, { force: true })
      expect(mockPush).toHaveBeenCalledTimes(1)
    })

    it('passes the compression format through to the push', async () => {
      mockPush.mockResolvedValue(`${CLUSTER_HOST}/t:1`)
      await pushImageShared('t:1', { projectSlug: 'a', reason: 'session' }, { compressionFormat: 'zstd' })
      expect(mockPush.mock.calls[0][1]).toMatchObject({ compressionFormat: 'zstd' })
    })

    it('coalesces concurrent pushes of the same tag', async () => {
      const d = deferred()
      mockPush.mockImplementation(() => d.promise.then(() => `${CLUSTER_HOST}/t:1`))
      const a = pushImageShared('t:1', { projectSlug: 'a', reason: 'session' })
      const b = pushImageShared('t:1', { projectSlug: 'b', reason: 'session' })
      await flush()
      expect(mockPush).toHaveBeenCalledTimes(1)
      d.resolve()
      expect(await a).toBe(`${CLUSTER_HOST}/t:1`)
      expect(await b).toBe(`${CLUSTER_HOST}/t:1`)
      expect(listImageBuilds()[0]).toMatchObject({ action: 'push', status: 'succeeded' })
    })

    it('marks the entry failed and rejects when the push fails', async () => {
      mockPush.mockRejectedValue(new Error('registry down'))
      await expect(pushImageShared('t:1', { projectSlug: 'a', reason: 'session' }))
        .rejects.toThrow('registry down')
      expect(listImageBuilds()[0]).toMatchObject({ action: 'push', status: 'failed' })
    })
  })
})

describe('rebuildProjectImage', () => {
  it('rebuilds tools with --no-cache and downstream layers with the cache', async () => {
    const tools = layer('yaac-tools:2', 'tools')
    const user = await podLayer({
      tag: 'yaac-user-p:3', name: 'user', buildArgs: { BASE_IMAGE: tools.tag },
    })
    chain([layer('yaac-base:1'), tools, user])

    expect(await rebuildProjectImage('p')).toBe('yaac-user-p:3')

    // Base untouched; tools and everything downstream rebuilt, in one pod.
    expect(builtTags()).toEqual(['yaac-tools:2', 'yaac-user-p:3'])
    const builds = remoteCommands().filter((argv) => argv[1] === 'build')
    // A forced rebuild drops the step cache entirely — reusing it is
    // exactly what the command exists to defeat.
    expect(builds[0]).toContain('--no-cache')
    expect(builds[0].join(' ')).not.toContain('--cache-from')
    // Downstream layers keep theirs: only tools is forced.
    expect(builds[1]).not.toContain('--no-cache')
    expect(builds[1].join(' ')).toContain('--cache-from')
    // Nothing to remove first: the tag's bytes live in the registry and the
    // rebuild's own push overwrites them.
    expect(mockRemoveImage).not.toHaveBeenCalled()
    expect(listImageBuilds().every((e) => e.reason === 'rebuild')).toBe(true)
  })

  it('waits out an in-flight build, then rebuilds inside the slot', async () => {
    chain([layer('yaac-tools:1', 'tools')])
    holdPodBuilds()
    const inflight = ensureImage('p')
    const first = await parkedBuild('yaac-tools:1')

    const rebuild = rebuildProjectImage('p')
    await flush()
    // Still waiting on the in-flight build — no second build yet.
    expect(builtTags()).toEqual(['yaac-tools:1'])

    first.close(0)
    await inflight
    await vi.waitFor(() => { expect(builtTags()).toHaveLength(2) })
    const second = held.filter((h) => h.args.includes('yaac-tools:1')).at(-1)!
    expect(second.args).toContain('--no-cache')
    second.close(0)
    await rebuild
  })

  it('lets a concurrent ensure join the no-cache rebuild instead of racing it', async () => {
    chain([layer('yaac-tools:1', 'tools')])
    holdPodBuilds()
    const rebuild = rebuildProjectImage('a')
    const parked = await parkedBuild('yaac-tools:1')

    const join = ensureImage('b')
    await flush()
    expect(builtTags()).toEqual(['yaac-tools:1'])

    parked.close(0)
    await Promise.all([rebuild, join])
    expect(listImageBuilds()[0].projectSlugs).toEqual(['a', 'b'])
  })

  it('removes the stale host image first on the host backend', async () => {
    // Where the build lands in a local store, the stale tag has to go
    // before the rebuild — inside the single-flight slot, so the removal
    // never races a concurrent build of the tag.
    vi.stubEnv('YAAC_IMAGE_BUILDER', 'host-podman')
    chain([layer('yaac-tools:1', 'tools')])
    mockBuildImage.mockResolvedValue(undefined)
    await rebuildProjectImage('p')
    expect(mockRemoveImage.mock.calls.map((c) => c[0])).toEqual(['yaac-tools:1'])
    expect(mockBuildImage.mock.calls[0][4]).toMatchObject({ noCache: true })
  })

  it('rejects a standalone Dockerfile.yaac chain (no tools layer)', async () => {
    chain([layer('yaac-base:custom', 'project')])
    await expect(rebuildProjectImage('p')).rejects.toThrow(/standalone Dockerfile\.yaac/)
    expect(builtTags()).toEqual([])
  })

  it('invalidates the verified push cache for a rebuilt tag', async () => {
    vi.stubEnv('YAAC_IMAGE_BUILDER', 'host-podman')
    mockHasTag.mockResolvedValue(true)
    await pushImageShared('yaac-tools:1', { projectSlug: 'a', reason: 'session' })
    chain([layer('yaac-tools:1', 'tools')])
    mockBuildImage.mockResolvedValue(undefined)
    await rebuildProjectImage('a')
    mockHasTag.mockClear()

    await pushImageShared('yaac-tools:1', { projectSlug: 'a', reason: 'session' })
    // The push cache was dropped with the rebuild — the registry is
    // re-consulted instead of trusted.
    expect(mockHasTag).toHaveBeenCalledTimes(1)
  })
})
