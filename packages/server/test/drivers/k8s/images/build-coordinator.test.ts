/**
 * The image build coordinator — `ensureImage` and `pushImageShared`.
 *
 * A DELIBERATE exception to "one describe per barrel function": only
 * `ensureImage` is on the images barrel, and `pushImageShared` is
 * folder-internal, reached from `workspace-image.ts`. Its describe stays
 * because the coverage rule outranks the layout rule here — that caller
 * mocks this module wholesale (it must: ESM intra-module calls bypass
 * `vi.mock`, which is why they are siblings at all), so the push
 * short-circuits and the coalescing are exercised nowhere else. Fold it
 * upward only if a barrel-level test ever drives those paths for real.
 *
 * Nothing under features/images is mocked here: the trust-split routing in
 * build-engine and the whole builder-pod flow (manifests, in-pod scripts,
 * build argv, context tar) run for real, and the fakes start at kubectl,
 * spawn, podman and the registry. A chain build is therefore covered end to
 * end by the entry point that production actually calls, and the internal
 * generators are covered by the argument sets these tests drive rather than
 * by tests of their own.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type * as childProcessModule from 'node:child_process'
import type * as kubectlModule from '#drivers/k8s/substrate/kubectl'
import type * as imageBuilderModule from '#drivers/k8s/image-engine/image-builder'
import type * as mainRegistryModule from '#drivers/k8s/cluster/main-registry'

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
/** A held child: its output tap and the signals its process group got. */
interface HeldChild {
  log: (line: string) => void
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
        held.push({ signals, log: (line) => child.stdout.emit('data', `${line}\n`) })
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
vi.mock('#drivers/k8s/image-engine/image-builder', async (importOriginal) => ({
  ...(await importOriginal<typeof imageBuilderModule>()),
  buildImage: vi.fn(),
  resolveImageChain: vi.fn(),
}))

vi.mock('#drivers/k8s/container/runtime', () => ({
  imageExists: vi.fn().mockResolvedValue(false),
}))

vi.mock('#drivers/k8s/container/registry', () => ({
  pushImageToRegistry: vi.fn(),
  registryHasTag: vi.fn().mockResolvedValue(false),
  registryHost: vi.fn(() => 'yaac-registry.yaac.svc.cluster.local:5000'),
  registryRef: vi.fn((tag: string) => `yaac-registry.yaac.svc.cluster.local:5000/${tag}`),
}))

const mockKubectlApply = vi.hoisted(() => vi.fn())
const mockKubectlWithRetry = vi.hoisted(() => vi.fn())
const mockKubectlGetJson = vi.hoisted(() => vi.fn())
const mockEnsureKubernetes = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/substrate/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  k8sNamespace: () => 'test-ns',
  dataDirHash: () => 'ddh0000000000000',
  kubectlApply: mockKubectlApply,
  kubectlWithRetry: mockKubectlWithRetry,
  kubectlGetJson: mockKubectlGetJson,
  ensureKubernetes: mockEnsureKubernetes,
}))

vi.mock('#drivers/k8s/cluster/cluster-cidrs', () => ({
  nodeIpBlocks: vi.fn().mockResolvedValue(['10.89.0.7/32']),
  resetClusterCidrCache: vi.fn(),
}))

const mockEnsureMainRegistry = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/cluster/main-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof mainRegistryModule>()),
  ensureMainRegistry: mockEnsureMainRegistry,
}))

vi.mock('#log', () => ({ serverLog: vi.fn(), pipeToServerLog: vi.fn() }))

import { ensureImage, pushImageShared } from '#drivers/k8s/images/build-coordinator'
import { _clearBuildCoordinatorForTests } from '#drivers/k8s/images/build-coordinator'
import { buildImage, resolveImageChain, type ImageLayer } from '#drivers/k8s/image-engine/image-builder'
import { imageExists } from '#drivers/k8s/container/runtime'
import { pushImageToRegistry, registryHasTag } from '#drivers/k8s/container/registry'
import { clearAllImageBuildsForTests, listImageBuilds } from '#drivers/k8s/image-engine/image-builds'
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
} from '#drivers/k8s/images/builder-pod'
import { BUILDER_CONTEXT_MAX_BYTES } from '#lib/build-context'
import type { ImageLayerName } from '@yaac/shared/types'

const mockBuildImage = vi.mocked(buildImage)
const mockResolveChain = vi.mocked(resolveImageChain)
const mockImageExists = vi.mocked(imageExists)
const mockPush = vi.mocked(pushImageToRegistry)
const mockHasTag = vi.mocked(registryHasTag)

const CLUSTER_HOST = 'yaac-registry.yaac.svc.cluster.local:5000'
const LAYERED_DOCKERFILE = 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n'

/** A host-built (trusted) layer; buildImage is mocked, so paths can be fake. */
function layer(tag: string, name: ImageLayerName = 'base'): ImageLayer {
  return { tag, name, dockerfile: '/df', context: '/ctx', contentHash: 'h' }
}

const tmpDirs: string[] = []
async function makeContext(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-coord-test-'))
  tmpDirs.push(dir)
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

/** buildImage mock that parks each tag on its own deferred. */
function deferBuilds(): Map<string, Deferred> {
  const byTag = new Map<string, Deferred>()
  mockBuildImage.mockImplementation((tag: string) => {
    const d = deferred()
    byTag.set(tag, d)
    return d.promise
  })
  return byTag
}

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
    const builds = deferBuilds()

    const a = ensureImage('proj-a', undefined, false, false, { reason: 'prewarm' })
    const b = ensureImage('proj-b', undefined, false, false, { reason: 'prewarm' })

    // Both chains wait on ONE base build, and both projects attach to its
    // single registry entry.
    await vi.waitFor(() => { expect(mockBuildImage).toHaveBeenCalledTimes(1) })
    expect(mockBuildImage.mock.calls[0][0]).toBe('yaac-base:shared')
    expect(listImageBuilds()[0]).toMatchObject({ projectSlugs: ['proj-a', 'proj-b'], status: 'running' })

    // Base resolves → both downstream layers build in parallel.
    builds.get('yaac-base:shared')!.resolve()
    await vi.waitFor(() => { expect(mockBuildImage).toHaveBeenCalledTimes(3) })
    expect(mockBuildImage.mock.calls.slice(1).map((c) => c[0]).sort())
      .toEqual(['yaac-tools-proj-a:x', 'yaac-tools-proj-b:x'])

    builds.get('yaac-tools-proj-a:x')!.resolve()
    builds.get('yaac-tools-proj-b:x')!.resolve()
    expect(await a).toBe('yaac-tools-proj-a:x')
    expect(await b).toBe('yaac-tools-proj-b:x')
    expect(listImageBuilds().every((e) => e.status === 'succeeded')).toBe(true)
  })

  it('propagates a build failure to every waiter and marks the entry failed', async () => {
    chain([layer('yaac-base:x')])
    const builds = deferBuilds()
    const a = ensureImage('proj-a')
    const b = ensureImage('proj-b')

    await vi.waitFor(() => { expect(mockBuildImage).toHaveBeenCalledTimes(1) })
    builds.get('yaac-base:x')!.reject(new Error('podman build exited with code 1'))
    await expect(a).rejects.toThrow('exited with code 1')
    await expect(b).rejects.toThrow('exited with code 1')

    expect(listImageBuilds()[0]).toMatchObject({ status: 'failed' })
    expect(listImageBuilds()[0].error).toContain('exited with code 1')
    // A failed tag is not memoized as realized — the next ensure retries.
    const retry = deferBuilds()
    const again = ensureImage('proj-a')
    await vi.waitFor(() => { expect(mockBuildImage).toHaveBeenCalledTimes(2) })
    retry.get('yaac-base:x')!.resolve()
    await again
  })

  it('fans build output into the registry log', async () => {
    chain([layer('t:1')])
    mockBuildImage.mockImplementation((_tag, _df, _ctx, _args, opts) => {
      opts?.onLog?.('STEP 1/2: FROM ubuntu')
      return Promise.resolve()
    })
    await ensureImage('proj')
    expect(listImageBuilds()[0]).toMatchObject({ stepCurrent: 1, stepTotal: 2 })
  })

  it('skips present tags and memoizes the verification for the rest of the run', async () => {
    chain([layer('t:1'), layer('t:2', 'tools')])
    mockImageExists.mockImplementation((tag) => Promise.resolve(tag === 't:1'))
    mockBuildImage.mockResolvedValue(undefined)

    await ensureImage('proj')
    // Only the absent layer built; both tags were probed once.
    expect(mockBuildImage.mock.calls.map((c) => c[0])).toEqual(['t:2'])
    expect(mockImageExists).toHaveBeenCalledTimes(2)

    // Content-hash tags are immutable: neither the probed nor the freshly
    // built tag is re-checked on the next ensure.
    mockImageExists.mockClear()
    mockBuildImage.mockClear()
    await ensureImage('proj')
    expect(mockImageExists).not.toHaveBeenCalled()
    expect(mockBuildImage).not.toHaveBeenCalled()
  })

  it('reports layer starts with 1-based chain positions', async () => {
    chain([layer('t:1'), layer('t:2', 'tools')])
    mockBuildImage.mockResolvedValue(undefined)
    const starts: string[] = []
    await ensureImage('proj', undefined, false, false, {
      onLayerStart: (i, total, name) => starts.push(`${i}/${total} ${name}`),
    })
    expect(starts).toEqual(['1/2 base', '2/2 tools'])
  })

  it('throws under requirePrebuilt without building or registering', async () => {
    chain([layer('t:1')])
    await expect(ensureImage('proj', undefined, true)).rejects.toThrow('missing or stale')
    expect(mockBuildImage).not.toHaveBeenCalled()
    expect(listImageBuilds()).toEqual([])
  })

  it('builds an untrusted layer in a gvisor builder pod and pushes the product', async () => {
    // The whole cluster-pod path in one pass: parent push, pod manifest,
    // storage bootstrap, parent pull, context tar, cached build, delta
    // push, pod teardown.
    const tools = layer('yaac-tools:t1', 'tools')
    const project = await podLayer({}, {
      'Dockerfile.yaac': LAYERED_DOCKERFILE,
      'keep.txt': 'k',
      'skipped/file.txt': 's',
      '.containerignore': 'skipped\n',
    })
    chain([tools, project])
    mockImageExists.mockResolvedValue(true) // tools already on host
    mockPush.mockResolvedValue(`${CLUSTER_HOST}/${tools.tag}`)

    await ensureImage('proj')

    // Trusted layer skipped host-side; nothing host-built.
    expect(mockBuildImage).not.toHaveBeenCalled()
    // The pod pulls its parent from the registry, so it is pushed first —
    // zstd, which materially cuts the empty-graphroot parent pull.
    expect(mockPush).toHaveBeenCalledTimes(1)
    expect(mockPush.mock.calls[0][0]).toBe(tools.tag)
    expect(mockPush.mock.calls[0][1]).toMatchObject({ compressionFormat: 'zstd' })

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
    // The pinned podman-stable mirror, resolved by the module's own image
    // ensure — never the session's user-customizable image.
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
    const cacheRef = `${CLUSTER_HOST}/yaac-buildcache-proj`
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

    // ensureImage owns the lease, so the pod dies with the chain.
    expect(deleteCalls()).toHaveLength(1)
    expect(deleteCalls()[0]).toContain(pod.metadata.name)
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
    // No parent tag means nothing to push ahead of the build.
    expect(mockPush).not.toHaveBeenCalled()
    // The dockerfile always ships, ignore file or not.
    expect(tarLists[0]).toContain('Dockerfile.yaac')
  })

  it('sanitizes the project slug into a valid OCI cache repo', async () => {
    chain([await podLayer({ buildArgs: undefined })])
    await ensureImage('My Project!')
    expect(remoteCommands()[2].join(' ')).toContain(`${CLUSTER_HOST}/yaac-buildcache-my-project-`)
  })

  it('reuses one builder pod across adjacent untrusted layers and deletes it once', async () => {
    const first = await podLayer({ buildArgs: undefined })
    const second = await podLayer({
      tag: 'yaac-user-proj:u1', name: 'user', buildArgs: { BASE_IMAGE: first.tag },
    })
    chain([first, second])

    await ensureImage('proj')

    expect(mockKubectlApply.mock.calls
      .filter((c) => (c[0] as { kind: string }).kind === 'Pod')).toHaveLength(1)
    expect(deleteCalls()).toHaveLength(1)
  })

  it('consults the registry for untrusted tags, never the host store', async () => {
    const tools = layer('yaac-tools:t1', 'tools')
    const project = await podLayer()
    chain([tools, project])
    mockImageExists.mockResolvedValue(true)
    mockHasTag.mockResolvedValue(true) // project tag already in the registry

    await ensureImage('proj')
    expect(mockHasTag).toHaveBeenCalledWith(project.tag)
    expect(appliedKinds()).not.toContain('Pod')
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('sandboxes any non-whitelisted layer name', async () => {
    // Whitelist semantics: an unknown name must not fall through to host podman.
    chain([await podLayer({ name: 'some-future-layer' as ImageLayerName, buildArgs: undefined })])
    await ensureImage('proj')
    expect(appliedKinds()).toContain('Pod')
    expect(mockBuildImage).not.toHaveBeenCalled()
  })

  it('fails closed when the ValidatingAdmissionPolicy API is unavailable', async () => {
    // Probed at the kubectl boundary, the way `vapAvailable` probes it: an
    // apiserver with no such resource type answers with an error.
    mockKubectlWithRetry.mockImplementation((args: string[]) =>
      args.includes('validatingadmissionpolicies')
        ? Promise.reject(new Error("the server doesn't have a resource type"))
        : Promise.resolve({ stdout: '', stderr: '' }))
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
  it('returns the ref without pushing or registering when the tag is present', async () => {
    mockHasTag.mockResolvedValue(true)
    const ref = await pushImageShared('t:1', { projectSlug: 'a', reason: 'prewarm' })
    expect(ref).toBe(`${CLUSTER_HOST}/t:1`)
    expect(mockPush).not.toHaveBeenCalled()
    expect(listImageBuilds()).toEqual([])
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
