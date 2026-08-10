import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('#features/projects/list', () => ({ listProjects: vi.fn() }))
vi.mock('#store/projects/config', () => ({ resolveProjectConfig: vi.fn() }))
vi.mock('#runtime/k8s/image-engine/image-builder', () => ({ resolveImageChain: vi.fn() }))
vi.mock('#runtime/k8s/images/build-coordinator', () => ({
  ensureImage: vi.fn(),
  pushImageShared: vi.fn(),
}))
// image-builds itself is the real in-memory registry, so retry's
// forget/re-fire behavior is exercised end-to-end.
vi.mock('#log', () => ({ serverLog: vi.fn() }))

import {
  prewarmProjectImage,
  reconcileImagePrewarm,
  retryImageBuild,
  PREWARM_SWEEP_INTERVAL_MS,
  _resetImagePrewarmForTests,
} from '#runtime/k8s/images/image-prewarm'
import { listProjects } from '#features/projects/list'
import { resolveProjectConfig } from '#store/projects/config'
import { resolveImageChain } from '#runtime/k8s/image-engine/image-builder'
import { ensureImage, pushImageShared } from '#runtime/k8s/images/build-coordinator'
import {
  attachImageBuildProject,
  clearAllImageBuildsForTests,
  failImageBuild,
  getImageBuild,
  hasBlockingFailure,
  registerImageBuild,
} from '#runtime/k8s/image-engine/image-builds'
import { _resetWorktreeListChangedForTests } from '#notify'
import { serverLog } from '#log'

const mockListProjects = vi.mocked(listProjects)
const mockResolveConfig = vi.mocked(resolveProjectConfig)
const mockResolveChain = vi.mocked(resolveImageChain)
const mockEnsureImage = vi.mocked(ensureImage)
const mockPush = vi.mocked(pushImageShared)

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function project(slug: string) {
  return { slug, remoteUrl: 'https://example.com/r.git', addedAt: '2026-01-01', worktreeCount: 0 }
}

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
    mockResolveConfig.mockResolvedValue(null)
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
    mockListProjects.mockResolvedValue([project('p')])
    await reconcileImagePrewarm()
    await flush()
    expect(mockEnsureImage).toHaveBeenCalledWith(
      'p', undefined, false, false, { reason: 'prewarm' })
  })

  it('is a no-op when YAAC_IMAGE_PREWARM=0', async () => {
    vi.stubEnv('YAAC_IMAGE_PREWARM', '0')
    await reconcileImagePrewarm()
    expect(mockListProjects).not.toHaveBeenCalled()
  })

  it('is a no-op under requirePrebuilt (e2e workers must never build)', async () => {
    vi.stubEnv('YAAC_REQUIRE_PREBUILT_IMAGES', '1')
    await reconcileImagePrewarm()
    expect(mockListProjects).not.toHaveBeenCalled()
  })

  it('swallows a project-list failure', async () => {
    mockListProjects.mockRejectedValue(new Error('fs gone'))
    await expect(reconcileImagePrewarm()).resolves.toBeUndefined()
  })

  it('ensures and pushes every project, threading nestedContainers from config', async () => {
    mockListProjects.mockResolvedValue([project('plain'), project('nested')])
    mockResolveConfig.mockImplementation((slug) =>
      Promise.resolve(slug === 'nested' ? { nestedContainers: true } : null))
    mockResolveChain.mockImplementation((slug: string) =>
      Promise.resolve({ layers: [], finalTag: `final-${slug}:x` }))
    mockEnsureImage.mockImplementation((slug: string) => Promise.resolve(`final-${slug}:x`))

    await reconcileImagePrewarm()
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
    mockListProjects.mockResolvedValue([project('vc')])
    mockResolveConfig.mockResolvedValue({ virtualCluster: true })
    await reconcileImagePrewarm()
    await flush()
    expect(mockEnsureImage).toHaveBeenCalledWith(
      'vc', undefined, false, true, { reason: 'prewarm' })
  })

  it('skips a project whose prewarm is still in flight, then resumes', async () => {
    mockListProjects.mockResolvedValue([project('p')])
    let release!: () => void
    mockEnsureImage.mockImplementation(() =>
      new Promise((res) => { release = () => res('yaac-tools:t') }))

    // Distinct past-interval timestamps so the sweep throttle never skips —
    // the in-flight mark is what must dedupe here.
    await reconcileImagePrewarm(PREWARM_SWEEP_INTERVAL_MS)
    await reconcileImagePrewarm(PREWARM_SWEEP_INTERVAL_MS * 2)
    expect(mockEnsureImage).toHaveBeenCalledTimes(1)

    release()
    await flush()
    await reconcileImagePrewarm(PREWARM_SWEEP_INTERVAL_MS * 3)
    await flush()
    expect(mockEnsureImage).toHaveBeenCalledTimes(2)
  })

  it('logs a failed prewarm and retries it on a later sweep', async () => {
    mockListProjects.mockResolvedValue([project('p')])
    mockEnsureImage.mockRejectedValueOnce(new Error('podman build exited with code 1'))

    await reconcileImagePrewarm(PREWARM_SWEEP_INTERVAL_MS)
    await flush()
    expect(vi.mocked(serverLog)).toHaveBeenCalledWith(
      expect.stringContaining('[image-prewarm] p:'))

    await reconcileImagePrewarm(PREWARM_SWEEP_INTERVAL_MS * 2)
    await flush()
    expect(mockEnsureImage).toHaveBeenCalledTimes(2)
  })

  it('throttles: a sweep inside the interval is a no-op', async () => {
    mockListProjects.mockResolvedValue([project('p')])

    await reconcileImagePrewarm(PREWARM_SWEEP_INTERVAL_MS)
    await flush()
    await reconcileImagePrewarm(PREWARM_SWEEP_INTERVAL_MS + 5_000)
    await flush()
    expect(mockListProjects).toHaveBeenCalledTimes(1)
    expect(mockEnsureImage).toHaveBeenCalledTimes(1)

    await reconcileImagePrewarm(PREWARM_SWEEP_INTERVAL_MS * 2)
    await flush()
    expect(mockListProjects).toHaveBeenCalledTimes(2)
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

    await prewarmProjectImage('p')

    expect(mockEnsureImage).not.toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('respects the test image prefix', async () => {
    vi.stubEnv('YAAC_IMAGE_PREFIX', 'yaac-test')
    await prewarmProjectImage('p')
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
    // so the background rebuild does no real work. The observable we assert on
    // is that prewarmProjectImage was kicked off for the right slug — its
    // first step is a resolveProjectConfig probe.
    mockResolveConfig.mockResolvedValue(null)
    mockResolveChain.mockResolvedValue({ layers: [], finalTag: 'yaac-tools:t' })
    mockEnsureImage.mockResolvedValue('yaac-tools:t')
    mockPush.mockResolvedValue('localhost:5001/yaac-tools:t')
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

    expect(retryImageBuild(id)).toEqual({ retried: true, infra: false })
    // The entry is forgotten, so it no longer backs off the prewarm sweep.
    expect(getImageBuild(id)).toBeUndefined()
    expect(hasBlockingFailure(['yaac-tools:abc'], 10 * 60_000)).toBe(false)
    // retry kicked off prewarmProjectImage('proj-a'); its synchronous first
    // step is the config probe.
    expect(mockResolveConfig).toHaveBeenCalledWith('proj-a')
  })

  it('re-triggers every owning project of a shared layer', () => {
    const id = registerImageBuild({
      tag: 'yaac-base:abc', layer: 'base', action: 'build', projectSlug: 'proj-a', reason: 'prewarm',
    })
    attachImageBuildProject(id, 'proj-b')
    failImageBuild(id, 'boom')

    expect(retryImageBuild(id)).toEqual({ retried: true, infra: false })
    expect(mockResolveConfig).toHaveBeenCalledWith('proj-a')
    expect(mockResolveConfig).toHaveBeenCalledWith('proj-b')
  })

  // The sidecar rebuild itself lives in the route: it goes through
  // #runtime/k8s/egress, which sits above this feature. All that is owed here is
  // forgetting the entry and reporting that the caller must do it.
  it('forgets an infra build with no owning project and reports it', () => {
    const id = registerImageBuild({
      tag: 'yaac-proxy:abc', layer: 'proxy', action: 'build', reason: 'session',
    })
    failImageBuild(id, 'boom')

    expect(retryImageBuild(id)).toEqual({ retried: true, infra: true })
    expect(getImageBuild(id)).toBeUndefined()
    expect(mockResolveConfig).not.toHaveBeenCalled()
  })

  it('no-ops (and rebuilds nothing) for an unknown id or a running build', () => {
    expect(retryImageBuild('missing')).toEqual({ retried: false, infra: false })

    const running = registerImageBuild({
      tag: 'x:1', layer: 'base', action: 'build', projectSlug: 'p', reason: 'session',
    })
    expect(retryImageBuild(running)).toEqual({ retried: false, infra: false })
    expect(getImageBuild(running)?.status).toBe('running') // still tracked
    expect(mockResolveConfig).not.toHaveBeenCalled()
  })
})
