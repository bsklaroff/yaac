import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { YaacConfig } from '@yaac/shared/types'

vi.mock('#drivers/k8s/image-engine/image-builder', () => ({ resolveImageChain: vi.fn() }))
vi.mock('#drivers/k8s/images/build-coordinator', () => ({
  ensureImage: vi.fn(),
  pushImageShared: vi.fn(),
}))
// The egress client is the process boundary an infra retry crosses: the
// sidecar has no project chain, so re-running ensureRunning IS its rebuild.
const { ensureRunning } = vi.hoisted(() => ({ ensureRunning: vi.fn() }))
vi.mock('#drivers/k8s/egress', () => ({ proxyClient: { ensureRunning } }))
// image-builds itself is the real in-memory registry, so retry's
// forget/re-fire behavior is exercised end-to-end.
vi.mock('#log', () => ({ serverLog: vi.fn() }))

import {
  prewarmProjectImage,
  reconcileImagePrewarm,
  retryImageBuild,
  PREWARM_SWEEP_INTERVAL_MS,
  _resetImagePrewarmForTests,
} from '#drivers/k8s/images/image-prewarm'
import { resolveImageChain } from '#drivers/k8s/image-engine/image-builder'
import { ensureImage, pushImageShared } from '#drivers/k8s/images/build-coordinator'
import {
  attachImageBuildProject,
  clearAllImageBuildsForTests,
  failImageBuild,
  getImageBuild,
  hasBlockingFailure,
  registerImageBuild,
} from '#drivers/k8s/image-engine/image-builds'
import { _resetWorktreeListChangedForTests } from '#notify'
import { serverLog } from '#log'

// The pass's own accessor, which is what the step is handed in production.
const mockResolveConfig = vi.fn<(slug: string) => Promise<YaacConfig | undefined>>()
const mockResolveChain = vi.mocked(resolveImageChain)
const mockEnsureImage = vi.mocked(ensureImage)
const mockPush = vi.mocked(pushImageShared)

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))



describe('reconcileImagePrewarm', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    _resetImagePrewarmForTests()
    clearAllImageBuildsForTests()
    // This suite may itself run inside a nested yaac session or an e2e
    // harness — neutralize the ambient gates explicitly.
    vi.stubEnv('YAAC_NESTED', undefined)
    vi.stubEnv('YAAC_IMAGE_PREWARM', undefined)
    vi.stubEnv('YAAC_REQUIRE_PREBUILT_IMAGES', undefined)
    vi.stubEnv('YAAC_IMAGE_PREFIX', undefined)
    mockResolveConfig.mockResolvedValue(undefined)
    mockResolveChain.mockResolvedValue({ layers: [], finalTag: 'yaac-tools:t' })
    mockEnsureImage.mockResolvedValue('yaac-tools:t')
    mockPush.mockResolvedValue('localhost:5001/yaac-tools:t')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    clearAllImageBuildsForTests()
    _resetWorktreeListChangedForTests()
  })

  it('runs inside a nested yaac session (in-pod dockerfile edits are the hot path)', async () => {
    vi.stubEnv('YAAC_NESTED', '1')
    reconcileImagePrewarm(['p'], mockResolveConfig)
    await flush()
    expect(mockEnsureImage).toHaveBeenCalledWith(
      'p', undefined, false, false, { reason: 'prewarm' })
  })

  it('is a no-op when YAAC_IMAGE_PREWARM=0', async () => {
    vi.stubEnv('YAAC_IMAGE_PREWARM', '0')
    reconcileImagePrewarm(['p'], mockResolveConfig)
    await flush()
    expect(mockEnsureImage).not.toHaveBeenCalled()
  })

  it('is a no-op under requirePrebuilt (e2e workers must never build)', async () => {
    vi.stubEnv('YAAC_REQUIRE_PREBUILT_IMAGES', '1')
    reconcileImagePrewarm(['p'], mockResolveConfig)
    await flush()
    expect(mockEnsureImage).not.toHaveBeenCalled()
  })

  it('ensures and pushes every project, threading nestedContainers from config', async () => {
    mockResolveConfig.mockImplementation((slug) =>
      Promise.resolve(slug === 'nested' ? { nestedContainers: true } : undefined))
    mockResolveChain.mockImplementation((slug: string) =>
      Promise.resolve({ layers: [], finalTag: `final-${slug}:x` }))
    mockEnsureImage.mockImplementation((slug: string) => Promise.resolve(`final-${slug}:x`))

    reconcileImagePrewarm(['plain', 'nested'], mockResolveConfig)
    await flush()

    expect(mockEnsureImage).toHaveBeenCalledWith(
      'plain', undefined, false, false, { reason: 'prewarm' })
    expect(mockEnsureImage).toHaveBeenCalledWith(
      'nested', undefined, false, true, { reason: 'prewarm' })
    expect(mockPush).toHaveBeenCalledWith(
      'final-plain:x', { projectSlug: 'plain', reason: 'prewarm' })
    expect(mockPush).toHaveBeenCalledWith(
      'final-nested:x', { projectSlug: 'nested', reason: 'prewarm' })
  })

  it('virtualCluster implies the nestable layer', async () => {
    mockResolveConfig.mockResolvedValue({ virtualCluster: true })
    reconcileImagePrewarm(['vc'], mockResolveConfig)
    await flush()
    expect(mockEnsureImage).toHaveBeenCalledWith(
      'vc', undefined, false, true, { reason: 'prewarm' })
  })

  it('skips a project whose prewarm is still in flight, then resumes', async () => {
    let release!: () => void
    mockEnsureImage.mockImplementation(() =>
      new Promise((res) => { release = () => res('yaac-tools:t') }))

    // Distinct past-interval timestamps so the sweep throttle never skips —
    // the in-flight mark is what must dedupe here.
    reconcileImagePrewarm(['p'], mockResolveConfig, PREWARM_SWEEP_INTERVAL_MS)
    reconcileImagePrewarm(['p'], mockResolveConfig, PREWARM_SWEEP_INTERVAL_MS * 2)
    await flush()
    expect(mockEnsureImage).toHaveBeenCalledTimes(1)

    release()
    await flush()
    reconcileImagePrewarm(['p'], mockResolveConfig, PREWARM_SWEEP_INTERVAL_MS * 3)
    await flush()
    expect(mockEnsureImage).toHaveBeenCalledTimes(2)
  })

  it('builds NOTHING for a project whose config cannot be read', async () => {
    // A config that exists and won't parse rejects the accessor, and that has
    // to stand the project down rather than fall back to defaults: `{}` here
    // would build a nestedContainers project's chain without its nestable
    // layer and then push it — wrong, and successful at being wrong.
    mockResolveConfig.mockRejectedValueOnce(new Error('yaac-config.json: invalid nestedContainers'))

    reconcileImagePrewarm(['p'], mockResolveConfig, PREWARM_SWEEP_INTERVAL_MS)
    await flush()

    expect(mockEnsureImage).not.toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()
    expect(vi.mocked(serverLog)).toHaveBeenCalledWith(
      expect.stringContaining('[image-prewarm] p:'))
  })

  it('logs a failed prewarm and retries it on a later sweep', async () => {
    mockEnsureImage.mockRejectedValueOnce(new Error('podman build exited with code 1'))

    reconcileImagePrewarm(['p'], mockResolveConfig, PREWARM_SWEEP_INTERVAL_MS)
    await flush()
    expect(vi.mocked(serverLog)).toHaveBeenCalledWith(
      expect.stringContaining('[image-prewarm] p:'))

    reconcileImagePrewarm(['p'], mockResolveConfig, PREWARM_SWEEP_INTERVAL_MS * 2)
    await flush()
    expect(mockEnsureImage).toHaveBeenCalledTimes(2)
  })

  it('throttles: a sweep inside the interval is a no-op', async () => {
    reconcileImagePrewarm(['p'], mockResolveConfig, PREWARM_SWEEP_INTERVAL_MS)
    await flush()
    reconcileImagePrewarm(['p'], mockResolveConfig, PREWARM_SWEEP_INTERVAL_MS + 5_000)
    await flush()
    expect(mockEnsureImage).toHaveBeenCalledTimes(1)

    reconcileImagePrewarm(['p'], mockResolveConfig, PREWARM_SWEEP_INTERVAL_MS * 2)
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
    // Real registry: a recently-failed build for one of the chain's tags is
    // what makes hasBlockingFailure gate the sweep.
    const id = registerImageBuild({
      tag: 'yaac-base:b', layer: 'base', action: 'build', projectSlug: 'p', reason: 'prewarm',
    })
    failImageBuild(id, 'boom')

    await prewarmProjectImage('p', {})

    expect(mockEnsureImage).not.toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('respects the test image prefix', async () => {
    vi.stubEnv('YAAC_IMAGE_PREFIX', 'yaac-test')
    await prewarmProjectImage('p', {})
    expect(mockResolveChain).toHaveBeenCalledWith('p', 'yaac-test', false)
    expect(mockEnsureImage).toHaveBeenCalledWith(
      'p', 'yaac-test', false, false, { reason: 'prewarm' })
  })
})

describe('retryImageBuild', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearAllImageBuildsForTests()
    // retry fires prewarmProjectImage fire-and-forget; keep its leaves inert
    // so the background rebuild does no real work. The observable we assert
    // on is that prewarmProjectImage was kicked off for the right slug — its
    // first step is asking the caller's reader for that project's config.
    mockResolveConfig.mockResolvedValue(undefined)
    mockResolveChain.mockResolvedValue({ layers: [], finalTag: 'yaac-tools:t' })
    mockEnsureImage.mockResolvedValue('yaac-tools:t')
    mockPush.mockResolvedValue('localhost:5001/yaac-tools:t')
    ensureRunning.mockResolvedValue(undefined)
  })
  afterEach(() => {
    clearAllImageBuildsForTests()
    _resetWorktreeListChangedForTests()
  })

  it('forgets a failed project build and re-triggers its chain', () => {
    const id = registerImageBuild({
      tag: 'yaac-tools:abc', layer: 'tools', action: 'build', projectSlug: 'proj-a', reason: 'prewarm',
    })
    failImageBuild(id, 'boom')
    expect(hasBlockingFailure(['yaac-tools:abc'], 10 * 60_000)).toBe(true)

    expect(retryImageBuild(id, mockResolveConfig)).toBe(true)
    // The entry is forgotten, so it no longer backs off the prewarm sweep.
    expect(getImageBuild(id)).toBeUndefined()
    expect(hasBlockingFailure(['yaac-tools:abc'], 10 * 60_000)).toBe(false)
    // retry kicked off prewarmProjectImage('proj-a'); its synchronous first
    // step is asking for that project's config.
    expect(mockResolveConfig).toHaveBeenCalledWith('proj-a')
  })

  it('re-triggers every owning project of a shared layer', () => {
    const id = registerImageBuild({
      tag: 'yaac-base:abc', layer: 'base', action: 'build', projectSlug: 'proj-a', reason: 'prewarm',
    })
    attachImageBuildProject(id, 'proj-b')
    failImageBuild(id, 'boom')

    expect(retryImageBuild(id, mockResolveConfig)).toBe(true)
    expect(mockResolveConfig).toHaveBeenCalledWith('proj-a')
    expect(mockResolveConfig).toHaveBeenCalledWith('proj-b')
  })

  // A build with no owning project is the shared egress sidecar, which
  // belongs to no chain: re-running ensureRunning is what rebuilds it,
  // because that path redeploys when the image tag is missing — exactly what
  // the failed build left behind. Detached, like the project path.
  it('rebuilds the sidecar for an infra build with no owning project', async () => {
    const id = registerImageBuild({
      tag: 'yaac-proxy:abc', layer: 'proxy', action: 'build', reason: 'session',
    })
    failImageBuild(id, 'boom')

    expect(retryImageBuild(id, mockResolveConfig)).toBe(true)
    expect(getImageBuild(id)).toBeUndefined()
    expect(ensureRunning).toHaveBeenCalledTimes(1)
    // No project chain to re-fire — the sidecar is nobody's.
    expect(mockResolveConfig).not.toHaveBeenCalled()
    await flush()
  })

  // A project build rebuilds through its own chain; nothing touches the
  // sidecar, which would redeploy the datapath under running worktrees.
  it('leaves the sidecar alone for a project build', () => {
    const id = registerImageBuild({
      tag: 'yaac-tools:abc', layer: 'tools', action: 'build', projectSlug: 'proj-a', reason: 'prewarm',
    })
    failImageBuild(id, 'boom')

    retryImageBuild(id, mockResolveConfig)

    expect(ensureRunning).not.toHaveBeenCalled()
  })

  // A failed sidecar rebuild is logged, never raised: the caller already has
  // its answer, and the retry is fire-and-forget on both paths.
  it('swallows a sidecar rebuild that fails', async () => {
    ensureRunning.mockRejectedValue(new Error('cluster down'))
    const id = registerImageBuild({
      tag: 'yaac-proxy:abc', layer: 'proxy', action: 'build', reason: 'session',
    })
    failImageBuild(id, 'boom')

    expect(() => retryImageBuild(id, mockResolveConfig)).not.toThrow()
    await flush()
    expect(vi.mocked(serverLog).mock.calls.map((c) => String(c[0])).join('\n'))
      .toMatch(/image-retry.*proxy.*cluster down/)
  })

  it('no-ops (and rebuilds nothing) for an unknown id or a running build', () => {
    expect(retryImageBuild('missing', mockResolveConfig)).toBe(false)

    const running = registerImageBuild({
      tag: 'x:1', layer: 'base', action: 'build', projectSlug: 'p', reason: 'session',
    })
    expect(retryImageBuild(running, mockResolveConfig)).toBe(false)
    expect(getImageBuild(running)?.status).toBe('running') // still tracked
    expect(mockResolveConfig).not.toHaveBeenCalled()
    expect(ensureRunning).not.toHaveBeenCalled()
  })
})
