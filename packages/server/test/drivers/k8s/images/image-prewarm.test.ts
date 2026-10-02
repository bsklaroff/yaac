import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { YaacConfig } from '@yaac/shared/types'

vi.mock('#drivers/k8s/image-engine/image-builder', () => ({ resolveImageChain: vi.fn() }))
vi.mock('#drivers/k8s/images/build-coordinator', () => ({
  ensureImage: vi.fn(),
}))
// image-builds is not mocked, so retry's forget/re-fire runs for real.
vi.mock('#log', () => ({ serverLog: vi.fn() }))

import {
  prewarmProjectImage,
  reconcileImagePrewarm,
  retryImageBuild,
  PREWARM_SWEEP_INTERVAL_MS,
  _resetImagePrewarmForTests,
} from '#drivers/k8s/images/image-prewarm'
import { resolveImageChain } from '#drivers/k8s/image-engine/image-builder'
import { ensureImage } from '#drivers/k8s/images/build-coordinator'
import {
  attachImageBuildProject,
  clearAllImageBuildsForTests,
  failImageBuild,
  getImageBuild,
  hasBlockingFailure,
  registerImageBuild,
} from '#drivers/k8s/image-engine/image-builds'
import { _resetWorkspaceListChangedForTests } from '#notify'
import { serverLog } from '#log'

// The config reader the reconcile step is given in production.
const mockResolveConfig = vi.fn<(slug: string) => Promise<YaacConfig | undefined>>()
const mockResolveChain = vi.mocked(resolveImageChain)
const mockEnsureImage = vi.mocked(ensureImage)

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const P = { slug: 'p', id: '3f2c9a1e-5b7d-4c8e-9f01-2a3b4c5d6e7f' }
const PLAIN = { slug: 'plain', id: '0b6f1d2c-3e4a-4b5c-8d9e-0f1a2b3c4d5e' }
const NESTED = { slug: 'nested', id: 'c1d2e3f4-a5b6-4c7d-8e9f-a0b1c2d3e4f5' }
const PROJ_A = { slug: 'proj-a', id: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d' }
const PROJ_B = { slug: 'proj-b', id: 'e9f8a7b6-c5d4-4e3f-9a2b-1c0d9e8f7a6b' }



describe('reconcileImagePrewarm', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    _resetImagePrewarmForTests()
    clearAllImageBuildsForTests()
    // Clear env gates an enclosing e2e harness may have set.
    vi.stubEnv('YAAC_IMAGE_PREWARM', undefined)
    vi.stubEnv('YAAC_REQUIRE_PREBUILT_IMAGES', undefined)
    vi.stubEnv('YAAC_IMAGE_PREFIX', undefined)
    mockResolveConfig.mockResolvedValue(undefined)
    mockResolveChain.mockResolvedValue({ layers: [], finalTag: 'yaac-tools:t' })
    mockEnsureImage.mockResolvedValue('yaac-tools:t')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    clearAllImageBuildsForTests()
    _resetWorkspaceListChangedForTests()
  })

  it('is a no-op when YAAC_IMAGE_PREWARM=0', async () => {
    vi.stubEnv('YAAC_IMAGE_PREWARM', '0')
    reconcileImagePrewarm([P], mockResolveConfig)
    await flush()
    expect(mockEnsureImage).not.toHaveBeenCalled()
  })

  it('is a no-op under requirePrebuilt (e2e workers must never build)', async () => {
    vi.stubEnv('YAAC_REQUIRE_PREBUILT_IMAGES', '1')
    reconcileImagePrewarm([P], mockResolveConfig)
    await flush()
    expect(mockEnsureImage).not.toHaveBeenCalled()
  })

  it('ensures every project, threading nestedContainers from config', async () => {
    mockResolveConfig.mockImplementation((slug) =>
      Promise.resolve(slug === 'nested' ? { nestedContainers: true } : undefined))
    mockResolveChain.mockImplementation((project) =>
      Promise.resolve({ layers: [], finalTag: `final-${project.slug}:x` }))
    mockEnsureImage.mockImplementation((project) => Promise.resolve(`final-${project.slug}:x`))

    reconcileImagePrewarm([PLAIN, NESTED], mockResolveConfig)
    await flush()

    expect(mockEnsureImage).toHaveBeenCalledWith(
      PLAIN, undefined, false, false, { reason: 'prewarm' })
    expect(mockEnsureImage).toHaveBeenCalledWith(
      NESTED, undefined, false, true, { reason: 'prewarm' })
  })

  it('skips a project whose prewarm is still in flight, then resumes', async () => {
    let release!: () => void
    mockEnsureImage.mockImplementation(() =>
      new Promise((res) => { release = () => res('yaac-tools:t') }))

    // Timestamps an interval apart, so only the in-flight mark can dedupe.
    reconcileImagePrewarm([P], mockResolveConfig, PREWARM_SWEEP_INTERVAL_MS)
    reconcileImagePrewarm([P], mockResolveConfig, PREWARM_SWEEP_INTERVAL_MS * 2)
    await flush()
    expect(mockEnsureImage).toHaveBeenCalledTimes(1)

    release()
    await flush()
    reconcileImagePrewarm([P], mockResolveConfig, PREWARM_SWEEP_INTERVAL_MS * 3)
    await flush()
    expect(mockEnsureImage).toHaveBeenCalledTimes(2)
  })

  it('builds NOTHING for a project whose config cannot be read', async () => {
    // An unparseable config skips the project rather than using defaults,
    // which could build a nestedContainers project without its nestable
    // layer.
    mockResolveConfig.mockRejectedValueOnce(new Error('yaac-config.json: invalid nestedContainers'))

    reconcileImagePrewarm([P], mockResolveConfig, PREWARM_SWEEP_INTERVAL_MS)
    await flush()

    expect(mockEnsureImage).not.toHaveBeenCalled()
    expect(vi.mocked(serverLog)).toHaveBeenCalledWith(
      expect.stringContaining('[image-prewarm] p:'))
  })

  it('logs a failed prewarm and retries it on a later sweep', async () => {
    mockEnsureImage.mockRejectedValueOnce(new Error('podman build exited with code 1'))

    reconcileImagePrewarm([P], mockResolveConfig, PREWARM_SWEEP_INTERVAL_MS)
    await flush()
    expect(vi.mocked(serverLog)).toHaveBeenCalledWith(
      expect.stringContaining('[image-prewarm] p:'))

    reconcileImagePrewarm([P], mockResolveConfig, PREWARM_SWEEP_INTERVAL_MS * 2)
    await flush()
    expect(mockEnsureImage).toHaveBeenCalledTimes(2)
  })

  it('throttles: a sweep inside the interval is a no-op', async () => {
    reconcileImagePrewarm([P], mockResolveConfig, PREWARM_SWEEP_INTERVAL_MS)
    await flush()
    reconcileImagePrewarm([P], mockResolveConfig, PREWARM_SWEEP_INTERVAL_MS + 5_000)
    await flush()
    expect(mockEnsureImage).toHaveBeenCalledTimes(1)

    reconcileImagePrewarm([P], mockResolveConfig, PREWARM_SWEEP_INTERVAL_MS * 2)
    await flush()
    expect(mockEnsureImage).toHaveBeenCalledTimes(2)
  })

  it('backs off a chain with a recent blocking failure', async () => {
    mockResolveChain.mockResolvedValue({
      layers: [
        { tag: 'yaac-base:b', name: 'base', dockerfile: '/df', context: '/ctx', contentHash: 'h' },
      ],
      finalTag: 'yaac-tools:t',
    })
    // A recent failed build of one of the chain's tags blocks the sweep.
    const id = registerImageBuild({
      tag: 'yaac-base:b', layer: 'base', project: P, reason: 'prewarm',
    })
    failImageBuild(id, 'boom')

    await prewarmProjectImage(P, {})

    expect(mockEnsureImage).not.toHaveBeenCalled()
  })

  it('respects the test image prefix', async () => {
    vi.stubEnv('YAAC_IMAGE_PREFIX', 'yaac-test')
    await prewarmProjectImage(P, {})
    expect(mockResolveChain).toHaveBeenCalledWith(P, 'yaac-test', false)
    expect(mockEnsureImage).toHaveBeenCalledWith(
      P, 'yaac-test', false, false, { reason: 'prewarm' })
  })
})

describe('retryImageBuild', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearAllImageBuildsForTests()
    // retry starts prewarmProjectImage without awaiting it. Its first step
    // reads the project's config, which is what the test observes.
    mockResolveConfig.mockResolvedValue(undefined)
    mockResolveChain.mockResolvedValue({ layers: [], finalTag: 'yaac-tools:t' })
    mockEnsureImage.mockResolvedValue('yaac-tools:t')
  })
  afterEach(() => {
    clearAllImageBuildsForTests()
    _resetWorkspaceListChangedForTests()
  })

  it('forgets a failed project build and re-triggers its chain', () => {
    const id = registerImageBuild({
      tag: 'yaac-tools:abc', layer: 'tools', project: PROJ_A, reason: 'prewarm',
    })
    failImageBuild(id, 'boom')
    expect(hasBlockingFailure(['yaac-tools:abc'], 10 * 60_000)).toBe(true)

    expect(retryImageBuild(id, mockResolveConfig)).toBe(true)
    // The entry is forgotten, so it no longer blocks the prewarm sweep.
    expect(getImageBuild(id)).toBeUndefined()
    expect(hasBlockingFailure(['yaac-tools:abc'], 10 * 60_000)).toBe(false)
    expect(mockResolveConfig).toHaveBeenCalledWith('proj-a')
  })

  it('re-triggers every owning project of a shared layer', async () => {
    const id = registerImageBuild({
      tag: 'yaac-base:abc', layer: 'base', project: PROJ_A, reason: 'prewarm',
    })
    attachImageBuildProject(id, PROJ_B)
    failImageBuild(id, 'boom')

    expect(retryImageBuild(id, mockResolveConfig)).toBe(true)
    expect(mockResolveConfig).toHaveBeenCalledWith('proj-a')
    expect(mockResolveConfig).toHaveBeenCalledWith('proj-b')
    // Each rebuild resolves its chain by the project's id, not its slug.
    await flush()
    expect(mockResolveChain).toHaveBeenCalledWith(PROJ_A, expect.any(String), false)
    expect(mockResolveChain).toHaveBeenCalledWith(PROJ_B, expect.any(String), false)
  })

  it('no-ops (and rebuilds nothing) for an unknown id or a running build', () => {
    expect(retryImageBuild('missing', mockResolveConfig)).toBe(false)

    const running = registerImageBuild({
      tag: 'x:1', layer: 'base', project: P, reason: 'session',
    })
    expect(retryImageBuild(running, mockResolveConfig)).toBe(false)
    expect(getImageBuild(running)?.status).toBe('running') // still tracked
    expect(mockResolveConfig).not.toHaveBeenCalled()
  })
})
