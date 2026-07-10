import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@yaac/server/lib/container/image-builder', () => ({
  buildImage: vi.fn(),
  resolveImageChain: vi.fn(),
}))

vi.mock('@yaac/server/lib/container/runtime', () => ({
  imageExists: vi.fn().mockResolvedValue(false),
  removeImage: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@yaac/server/lib/k8s/registry', () => ({
  pushImageToRegistry: vi.fn(),
  registryHasTag: vi.fn().mockResolvedValue(false),
  registryRef: vi.fn((tag: string) => `localhost:5001/${tag}`),
}))

vi.mock('@yaac/server/log', () => ({
  serverLog: vi.fn(),
}))

import {
  buildLayerShared,
  ensureImage,
  pushImageShared,
  rebuildLayerExclusive,
  rebuildProjectImage,
  _clearBuildCoordinatorForTests,
} from '@yaac/server/lib/container/build-coordinator'
import { buildImage, resolveImageChain, type ImageLayer } from '@yaac/server/lib/container/image-builder'
import { imageExists, removeImage } from '@yaac/server/lib/container/runtime'
import { pushImageToRegistry, registryHasTag } from '@yaac/server/lib/k8s/registry'
import { clearAllImageBuildsForTests, listImageBuilds } from '@yaac/server/image-builds'
import type { ImageLayerName } from '@yaac/shared/types'

const mockBuildImage = vi.mocked(buildImage)
const mockResolveChain = vi.mocked(resolveImageChain)
const mockImageExists = vi.mocked(imageExists)
const mockRemoveImage = vi.mocked(removeImage)
const mockPush = vi.mocked(pushImageToRegistry)
const mockHasTag = vi.mocked(registryHasTag)

function layer(tag: string, name: ImageLayerName = 'base'): ImageLayer {
  return { tag, name, dockerfile: '/df', context: '/ctx', contentHash: 'h' }
}

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

describe('build coordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _clearBuildCoordinatorForTests()
    clearAllImageBuildsForTests()
    mockImageExists.mockResolvedValue(false)
    mockHasTag.mockResolvedValue(false)
    mockRemoveImage.mockResolvedValue(undefined)
  })

  afterEach(() => {
    _clearBuildCoordinatorForTests()
    clearAllImageBuildsForTests()
  })

  describe('buildLayerShared', () => {
    it('coalesces concurrent builds of the same tag into one podman run', async () => {
      const builds = deferBuilds()
      const a = buildLayerShared(layer('yaac-base:x'), { projectSlug: 'a', reason: 'session' })
      const b = buildLayerShared(layer('yaac-base:x'), { projectSlug: 'b', reason: 'prewarm' })

      await flush()
      expect(mockBuildImage).toHaveBeenCalledTimes(1)
      const [entry] = listImageBuilds()
      expect(entry.projectSlugs).toEqual(['a', 'b'])
      expect(entry.status).toBe('running')

      builds.get('yaac-base:x')!.resolve()
      await Promise.all([a, b])
      expect(listImageBuilds()[0].status).toBe('succeeded')
    })

    it('propagates a build failure to every waiter and marks the entry failed', async () => {
      const builds = deferBuilds()
      const a = buildLayerShared(layer('yaac-base:x'), { projectSlug: 'a', reason: 'session' })
      const b = buildLayerShared(layer('yaac-base:x'), { projectSlug: 'b', reason: 'session' })

      await flush()
      builds.get('yaac-base:x')!.reject(new Error('podman build exited with code 1'))
      await expect(a).rejects.toThrow('exited with code 1')
      await expect(b).rejects.toThrow('exited with code 1')

      const [entry] = listImageBuilds()
      expect(entry.status).toBe('failed')
      expect(entry.error).toContain('exited with code 1')
    })

    it('starts a fresh build for the same tag after the previous one finished', async () => {
      const builds = deferBuilds()
      const first = buildLayerShared(layer('t:1'), { projectSlug: 'a', reason: 'session' })
      builds.get('t:1')!.resolve()
      await first

      const second = buildLayerShared(layer('t:1'), { projectSlug: 'a', reason: 'session' })
      await flush()
      builds.get('t:1')!.resolve()
      await second
      expect(mockBuildImage).toHaveBeenCalledTimes(2)
    })

    it('fans build output into the registry log', async () => {
      mockBuildImage.mockImplementation((_tag, _df, _ctx, _args, opts) => {
        opts?.onLog?.('STEP 1/2: FROM ubuntu')
        return Promise.resolve()
      })
      await buildLayerShared(layer('t:1'), { projectSlug: 'a', reason: 'session' })
      const [entry] = listImageBuilds()
      expect(entry.stepCurrent).toBe(1)
      expect(entry.stepTotal).toBe(2)
    })
  })

  describe('ensureImage', () => {
    it('coalesces the shared base and fans out distinct downstream layers', async () => {
      const base = layer('yaac-base:shared')
      mockResolveChain.mockImplementation((slug: string) => Promise.resolve({
        layers: [base, layer(`yaac-user-${slug}:x`, 'user')],
        finalTag: `yaac-user-${slug}:x`,
      }))
      const builds = deferBuilds()

      const a = ensureImage('proj-a', undefined, false, false, { reason: 'prewarm' })
      const b = ensureImage('proj-b', undefined, false, false, { reason: 'prewarm' })

      // Both chains wait on ONE base build.
      await vi.waitFor(() => { expect(mockBuildImage).toHaveBeenCalledTimes(1) })
      expect(mockBuildImage.mock.calls[0][0]).toBe('yaac-base:shared')

      // Base resolves → both project layers build in parallel.
      builds.get('yaac-base:shared')!.resolve()
      await vi.waitFor(() => { expect(mockBuildImage).toHaveBeenCalledTimes(3) })
      const tags = mockBuildImage.mock.calls.slice(1).map((c) => c[0]).sort()
      expect(tags).toEqual(['yaac-user-proj-a:x', 'yaac-user-proj-b:x'])

      builds.get('yaac-user-proj-a:x')!.resolve()
      builds.get('yaac-user-proj-b:x')!.resolve()
      expect(await a).toBe('yaac-user-proj-a:x')
      expect(await b).toBe('yaac-user-proj-b:x')
    })

    it('skips layers whose tag already exists', async () => {
      mockResolveChain.mockResolvedValue({
        layers: [layer('t:1'), layer('t:2', 'tools')],
        finalTag: 't:2',
      })
      mockImageExists.mockImplementation((tag) => Promise.resolve(tag === 't:1'))
      const builds = deferBuilds()

      const result = ensureImage('proj', undefined, false, false)
      await vi.waitFor(() => { expect(mockBuildImage).toHaveBeenCalledTimes(1) })
      expect(mockBuildImage.mock.calls[0][0]).toBe('t:2')
      builds.get('t:2')!.resolve()
      expect(await result).toBe('t:2')
    })

    it('reports layer starts with 1-based chain positions', async () => {
      mockResolveChain.mockResolvedValue({
        layers: [layer('t:1'), layer('t:2', 'tools')],
        finalTag: 't:2',
      })
      mockBuildImage.mockResolvedValue(undefined)
      const starts: string[] = []
      await ensureImage('proj', undefined, false, false, {
        onLayerStart: (i, total, name) => starts.push(`${i}/${total} ${name}`),
      })
      expect(starts).toEqual(['1/2 base', '2/2 tools'])
    })

    it('throws under requirePrebuilt without building or registering', async () => {
      mockResolveChain.mockResolvedValue({ layers: [layer('t:1')], finalTag: 't:1' })
      await expect(ensureImage('proj', undefined, true)).rejects.toThrow('missing or stale')
      expect(mockBuildImage).not.toHaveBeenCalled()
      expect(listImageBuilds()).toEqual([])
    })
  })

  describe('rebuildLayerExclusive', () => {
    it('waits out an in-flight build, then removes and rebuilds inside the slot', async () => {
      const builds = deferBuilds()
      const inflight = buildLayerShared(layer('t:1'), { projectSlug: 'a', reason: 'session' })
      await flush()

      const rebuild = rebuildLayerExclusive(
        layer('t:1'), { projectSlug: 'a', reason: 'rebuild' }, { noCache: true },
      )
      await flush()
      // Still waiting on the in-flight build — no removal yet.
      expect(mockRemoveImage).not.toHaveBeenCalled()

      builds.get('t:1')!.resolve()
      await inflight
      await vi.waitFor(() => { expect(mockRemoveImage).toHaveBeenCalledWith('t:1') })
      await vi.waitFor(() => { expect(mockBuildImage).toHaveBeenCalledTimes(2) })
      expect(mockBuildImage.mock.calls[1][4]).toMatchObject({ noCache: true })

      builds.get('t:1')!.resolve()
      await rebuild
    })

    it('lets a concurrent ensure join the no-cache rebuild instead of racing the removal', async () => {
      const builds = deferBuilds()
      const rebuild = rebuildLayerExclusive(
        layer('t:1'), { projectSlug: 'a', reason: 'rebuild' }, { noCache: true },
      )
      await vi.waitFor(() => { expect(mockRemoveImage).toHaveBeenCalledTimes(1) })

      const join = buildLayerShared(layer('t:1'), { projectSlug: 'b', reason: 'session' })
      await flush()
      expect(mockBuildImage).toHaveBeenCalledTimes(1)

      builds.get('t:1')!.resolve()
      await Promise.all([rebuild, join])
      expect(listImageBuilds()[0].projectSlugs).toEqual(['a', 'b'])
    })
  })

  describe('pushImageShared', () => {
    it('returns the ref without pushing or registering when the tag is present', async () => {
      mockHasTag.mockResolvedValue(true)
      const ref = await pushImageShared('t:1', { projectSlug: 'a', reason: 'prewarm' })
      expect(ref).toBe('localhost:5001/t:1')
      expect(mockPush).not.toHaveBeenCalled()
      expect(listImageBuilds()).toEqual([])
    })

    it('pushes even a present tag when forced', async () => {
      mockHasTag.mockResolvedValue(true)
      mockPush.mockResolvedValue('localhost:5001/t:1')
      await pushImageShared('t:1', { projectSlug: 'a', reason: 'rebuild' }, { force: true })
      expect(mockPush).toHaveBeenCalledTimes(1)
      expect(mockPush.mock.calls[0][1]).toMatchObject({ force: true })
    })

    it('coalesces concurrent pushes of the same tag', async () => {
      const d = deferred()
      mockPush.mockImplementation(() => d.promise.then(() => 'localhost:5001/t:1'))
      const a = pushImageShared('t:1', { projectSlug: 'a', reason: 'session' })
      const b = pushImageShared('t:1', { projectSlug: 'b', reason: 'session' })
      await flush()
      expect(mockPush).toHaveBeenCalledTimes(1)
      d.resolve()
      expect(await a).toBe('localhost:5001/t:1')
      expect(await b).toBe('localhost:5001/t:1')
      expect(listImageBuilds()[0]).toMatchObject({ action: 'push', status: 'succeeded' })
    })

    it('marks the entry failed and rejects when the push fails', async () => {
      mockPush.mockRejectedValue(new Error('registry down'))
      await expect(pushImageShared('t:1', { projectSlug: 'a', reason: 'session' }))
        .rejects.toThrow('registry down')
      expect(listImageBuilds()[0]).toMatchObject({ action: 'push', status: 'failed' })
    })
  })

  describe('rebuildProjectImage', () => {
    it('rebuilds tools with --no-cache and downstream layers with cache', async () => {
      mockResolveChain.mockResolvedValue({
        layers: [
          layer('yaac-base:1'),
          layer('yaac-tools:2', 'tools'),
          layer('yaac-user-p:3', 'user'),
        ],
        finalTag: 'yaac-user-p:3',
      })
      mockBuildImage.mockResolvedValue(undefined)

      const result = await rebuildProjectImage('p')
      expect(result).toBe('yaac-user-p:3')
      // Base untouched; tools removed+rebuilt no-cache; user removed+rebuilt cached.
      expect(mockRemoveImage.mock.calls.map((c) => c[0])).toEqual(['yaac-tools:2', 'yaac-user-p:3'])
      expect(mockBuildImage.mock.calls.map((c) => [c[0], (c[4] as { noCache?: boolean }).noCache])).toEqual([
        ['yaac-tools:2', true],
        ['yaac-user-p:3', false],
      ])
      expect(listImageBuilds().every((e) => e.reason === 'rebuild')).toBe(true)
    })

    it('rejects a standalone Dockerfile.yaac chain (no tools layer)', async () => {
      mockResolveChain.mockResolvedValue({
        layers: [layer('yaac-base:custom', 'project')],
        finalTag: 'yaac-base:custom',
      })
      await expect(rebuildProjectImage('p')).rejects.toThrow(/standalone Dockerfile\.yaac/)
      expect(mockRemoveImage).not.toHaveBeenCalled()
    })
  })
})
