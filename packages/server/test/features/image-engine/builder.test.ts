/**
 * The builder seam: which backend an install builds on, what each backend
 * does with a build/mirror/publish, and the preflight that runs before the
 * first session create.
 *
 * The fakes are the two process boundaries a builder has — podman on this
 * machine, and kubectl into a pod — so both backends run for real down to
 * the argv they produce. The cluster backend's build path itself (context
 * tar, step cache, product push) is driven end to end through `ensureImage`
 * in test/features/images/build-coordinator.test.ts, where it is wired up;
 * what is covered here is everything the seam decides before that.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type * as kubectlModule from '#platform/k8s/kubectl'
import type * as childProcessModule from 'node:child_process'
import type * as imageBuilderModule from '#features/image-engine/image-builder'

/**
 * spawn fake: an inert child that closes 0 on the next tick, recording the
 * argv. Every in-pod step is a `kubectl exec`, so this is where they land.
 */
const spawned = vi.hoisted(() => [] as Array<{ file: string; args: string[] }>)
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcessModule>()
  const stream = (): unknown => Object.assign(new EventEmitter(), {
    pipe: vi.fn(), setEncoding: vi.fn(), end: vi.fn(), destroy: vi.fn(),
  })
  return {
    ...actual,
    spawn: (file: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>
      child.stdout = stream()
      child.stderr = stream()
      child.stdin = stream()
      child.pid = 4242
      child.exitCode = null
      child.signalCode = null
      spawned.push({ file, args })
      process.nextTick(() => child.emit('close', 0))
      return child
    },
  }
})

const mockExecFile = vi.hoisted(() => vi.fn())
const mockPush = vi.hoisted(() => vi.fn((tag: string) => Promise.resolve(`registry/${tag}`)))
const mockHasTag = vi.hoisted(() => vi.fn())
const mockEnsureHostPodman = vi.hoisted(() => vi.fn())
const mockBuildImage = vi.hoisted(() => vi.fn())
const mockEnsureKubernetes = vi.hoisted(() => vi.fn())

vi.mock('#platform/container/runtime', () => ({
  ensureHostPodman: mockEnsureHostPodman,
  execFileAsync: mockExecFile,
  imageExists: vi.fn().mockResolvedValue(true),
  removeImage: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('#platform/container/registry', () => ({
  pushImageToRegistry: mockPush,
  registryHasTag: mockHasTag,
  registryHost: () => 'yaac-registry.yaac.svc.cluster.local:5000',
  registryRef: (tag: string) => `registry/${tag}`,
}))
vi.mock('#platform/k8s/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  k8sNamespace: () => 'test-ns',
  dataDirHash: () => 'ddh0000000000000',
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  kubectlGetJson: vi.fn().mockResolvedValue(null),
  ensureKubernetes: mockEnsureKubernetes,
}))
// Only the host build is faked; the cluster build runs for real into the
// spawn fake above.
vi.mock('#features/image-engine/image-builder', async (importOriginal) => ({
  ...(await importOriginal<typeof imageBuilderModule>()),
  buildImage: mockBuildImage,
}))
vi.mock('#log', () => ({ serverLog: vi.fn(), pipeToServerLog: vi.fn() }))

import {
  ensureImageBuildRuntime,
  ensureMirroredImage,
  imageBuilder,
  imageBuilderKind,
  withImageBuilder,
} from '#features/image-engine'
// State-reset hook and the pinned upstream image: setup values, not units
// under test.
import { _resetImageBuildRuntimeForTests } from '#features/image-engine/builder'
import { BUILDER_LOCAL_TAG } from '#features/image-engine/builder-pod'
import { kubectlApply, kubectlWithRetry } from '#platform/k8s/kubectl'

const ensureHost = vi.fn().mockResolvedValue(undefined)

/** The remote argv of each in-pod `kubectl exec`, in order. */
const remoteCommands = (): string[][] =>
  spawned.filter((s) => s.file === 'kubectl')
    .map((s) => s.args.slice(s.args.indexOf('--') + 1))

const UPSTREAM = 'docker.io/envoyproxy/envoy@sha256:' + 'a'.repeat(64)
const MIRROR_TAG = 'envoyproxy/envoy:v1.34.0-aaaaaaaaaaaa'

beforeEach(() => {
  vi.clearAllMocks()
  spawned.length = 0
  _resetImageBuildRuntimeForTests()
  mockHasTag.mockResolvedValue(false)
  mockExecFile.mockResolvedValue({ stdout: '', stderr: '' })
  mockEnsureKubernetes.mockResolvedValue(undefined)
  ensureHost.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('imageBuilderKind', () => {
  it('builds in cluster pods by default', () => {
    expect(imageBuilderKind()).toBe('cluster-pod')
  })

  it('uses the machine engine when nested — the session IS the sandbox', () => {
    // An inner builder pod would be a vcluster pod, unvalidated and
    // strictly worse than the outer sandbox already containing this server.
    vi.stubEnv('YAAC_NESTED', '1')
    expect(imageBuilderKind()).toBe('host-podman')
  })

  it('honours the explicit override in both directions', () => {
    vi.stubEnv('YAAC_IMAGE_BUILDER', 'host-podman')
    expect(imageBuilderKind()).toBe('host-podman')
    vi.stubEnv('YAAC_NESTED', '1')
    vi.stubEnv('YAAC_IMAGE_BUILDER', 'cluster-pod')
    expect(imageBuilderKind()).toBe('cluster-pod')
  })

  it('ignores an unrecognized value rather than refusing to boot', () => {
    vi.stubEnv('YAAC_IMAGE_BUILDER', 'buildkit')
    expect(imageBuilderKind()).toBe('cluster-pod')
  })
})

describe('imageBuilder', () => {
  it('realizes a host build in the machine store, and publishes separately', async () => {
    vi.stubEnv('YAAC_IMAGE_BUILDER', 'host-podman')
    const builder = imageBuilder(ensureHost)
    expect(builder.kind).toBe('host-podman')

    await builder.build({
      tag: 'yaac-base:h1',
      dockerfile: '/df',
      context: '/ctx',
      buildArgs: { YAAC_UID: '1000' },
      noCache: true,
      trust: 'shipped',
      cacheRepo: 'ignored-by-this-backend',
    })
    expect(mockBuildImage).toHaveBeenCalledWith(
      'yaac-base:h1', '/df', '/ctx', { YAAC_UID: '1000' },
      expect.objectContaining({ noCache: true }),
    )
    // A host product is in a local store and nowhere a pod can pull it
    // from, so publishing is a second, separate step.
    expect(await builder.publish('yaac-base:h1')).toBe('registry/yaac-base:h1')
    expect(mockPush).toHaveBeenCalledWith('yaac-base:h1', undefined)
    await builder.close()
    expect(ensureHost).not.toHaveBeenCalled()
  })

  it('realizes a cluster build in the registry, so publishing is a no-op', async () => {
    const builder = imageBuilder(ensureHost)
    expect(builder.kind).toBe('cluster-pod')
    // The tag's existence is the registry's answer, not a host store's.
    mockHasTag.mockResolvedValue(true)
    expect(await builder.imageExists('yaac-base:c1')).toBe(true)
    // Nothing to remove before a rebuild: the pod that built it is gone and
    // the rebuild's own push overwrites the tag.
    await builder.remove('yaac-base:c1')
    expect(mockExecFile).not.toHaveBeenCalled()
    expect(await builder.publish('yaac-base:c1')).toBe('registry/yaac-base:c1')
    expect(mockPush).not.toHaveBeenCalled()
    await builder.close()
  })
})

describe('withImageBuilder', () => {
  it('closes the builder even when the operation throws', async () => {
    mockHasTag.mockResolvedValue(true)
    await expect(withImageBuilder(ensureHost, async (builder) => {
      await builder.mirror({ upstream: UPSTREAM, tag: MIRROR_TAG })
      throw new Error('boom')
    })).rejects.toThrow('boom')
    // The pod it leased for the mirror is deleted, not leaked.
    const deletes = vi.mocked(kubectlWithRetry).mock.calls
      .map((c) => c[0])
      .filter((args) => args[0] === 'delete')
    expect(deletes).toHaveLength(1)
  })
})

describe('ensureMirroredImage', () => {
  it('skips everything when the registry already holds the pinned tag', async () => {
    mockHasTag.mockResolvedValue(true)
    const ref = await withImageBuilder(ensureHost, (b) =>
      ensureMirroredImage({ upstream: UPSTREAM, tag: MIRROR_TAG, label: 'Envoy image' }, b))
    expect(ref).toBe(`registry/${MIRROR_TAG}`)
    expect(spawned).toEqual([])
    expect(mockExecFile).not.toHaveBeenCalled()
  })

  it('refuses to mirror under requirePrebuilt, naming the image', async () => {
    await expect(withImageBuilder(ensureHost, (b) => ensureMirroredImage(
      { upstream: UPSTREAM, tag: MIRROR_TAG, label: 'Envoy image', requirePrebuilt: true }, b,
    ))).rejects.toThrow(/Envoy image .* is missing\. Restart the test run/)
    expect(spawned).toEqual([])
  })

  it('copies upstream into the registry from inside a builder pod', async () => {
    // The cluster backend has no host engine to pull with, so the mirror is
    // a pod doing pull → arch check → tag → push.
    mockHasTag.mockImplementation((tag: string) => Promise.resolve(tag === BUILDER_LOCAL_TAG))
    const ref = await withImageBuilder(ensureHost, (b) =>
      ensureMirroredImage({ upstream: UPSTREAM, tag: MIRROR_TAG, label: 'Envoy image' }, b))

    expect(ref).toBe(`registry/${MIRROR_TAG}`)
    expect(ensureHost).toHaveBeenCalled()
    expect(vi.mocked(kubectlApply).mock.calls
      .map((c) => (c[0] as { kind: string }).kind)).toContain('Pod')

    // storage.conf bootstrap, then the mirror script.
    const script = remoteCommands().at(-1)![2]
    expect(script).toContain(`podman pull ${UPSTREAM}`)
    expect(script).toContain(`podman tag ${UPSTREAM} ${MIRROR_TAG}`)
    expect(script).toContain(
      `podman push --tls-verify=false ${MIRROR_TAG} `
      + `yaac-registry.yaac.svc.cluster.local:5000/${MIRROR_TAG}`,
    )
    // The arch check runs against the NODE's arch, which is the one that
    // matters: a pin naming one platform's child manifest instead of the
    // multi-arch index fails here, not as an exec format error later.
    expect(script).toContain("want=$(podman info --format '{{.Host.Arch}}')")
    expect(script).toContain('exit 1')
  })

  it('refuses a host mirror built for another architecture', async () => {
    vi.stubEnv('YAAC_IMAGE_BUILDER', 'host-podman')
    const realArch = process.arch
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
    try {
      // podman reports amd64, which is what x64 means — the mirror is fine.
      mockExecFile.mockResolvedValue({ stdout: 'amd64', stderr: '' })
      await expect(withImageBuilder(ensureHost, (b) =>
        ensureMirroredImage({ upstream: UPSTREAM, tag: MIRROR_TAG, label: 'Envoy image' }, b),
      )).resolves.toBe(`registry/${MIRROR_TAG}`)

      // A child manifest for the wrong platform must not be mirrored.
      mockExecFile.mockResolvedValue({ stdout: 'arm64', stderr: '' })
      await expect(withImageBuilder(ensureHost, (b) =>
        ensureMirroredImage({ upstream: UPSTREAM, tag: MIRROR_TAG, label: 'Envoy image' }, b),
      )).rejects.toThrow(/is a arm64 image but this host is amd64/)
    } finally {
      Object.defineProperty(process, 'arch', { value: realArch, configurable: true })
    }
  })
})

describe('ensureImageBuildRuntime', () => {
  it('checks only the cluster on a cluster-pod install', async () => {
    // The point of the seam: a server that builds in pods has no host
    // engine to check, and `apt install podman` would be wrong advice.
    await ensureImageBuildRuntime()
    expect(mockEnsureHostPodman).not.toHaveBeenCalled()
    expect(mockEnsureKubernetes).toHaveBeenCalledTimes(1)
  })

  it('checks the machine engine too when that is what builds', async () => {
    vi.stubEnv('YAAC_IMAGE_BUILDER', 'host-podman')
    await ensureImageBuildRuntime()
    expect(mockEnsureHostPodman).toHaveBeenCalledTimes(1)
    expect(mockEnsureKubernetes).toHaveBeenCalledTimes(1)
  })

  it('verifies once per process, and never caches a failure', async () => {
    mockEnsureKubernetes.mockRejectedValueOnce(new Error('cluster down'))
    await expect(ensureImageBuildRuntime()).rejects.toThrow('cluster down')

    await ensureImageBuildRuntime()
    await ensureImageBuildRuntime()
    expect(mockEnsureKubernetes).toHaveBeenCalledTimes(2)
  })
})
