import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('#lib/project/list', () => ({ listProjects: vi.fn() }))
vi.mock('#lib/project/config', () => ({ resolveProjectConfig: vi.fn() }))
vi.mock('#lib/container/image-builder', () => ({ resolveImageChain: vi.fn() }))
vi.mock('#lib/container/build-coordinator', () => ({
  ensureImage: vi.fn(),
  pushImageShared: vi.fn(),
}))
vi.mock('#image-builds', () => ({ hasBlockingFailure: vi.fn() }))
vi.mock('#log', () => ({ serverLog: vi.fn() }))

import {
  prewarmProjectImage,
  reconcileImagePrewarm,
  PREWARM_SWEEP_INTERVAL_MS,
  _resetImagePrewarmForTests,
} from '#image-prewarm'
import { listProjects } from '#lib/project/list'
import { resolveProjectConfig } from '#lib/project/config'
import { resolveImageChain } from '#lib/container/image-builder'
import { ensureImage, pushImageShared } from '#lib/container/build-coordinator'
import { hasBlockingFailure } from '#image-builds'
import { serverLog } from '#log'

const mockListProjects = vi.mocked(listProjects)
const mockResolveConfig = vi.mocked(resolveProjectConfig)
const mockResolveChain = vi.mocked(resolveImageChain)
const mockEnsureImage = vi.mocked(ensureImage)
const mockPush = vi.mocked(pushImageShared)
const mockBlockingFailure = vi.mocked(hasBlockingFailure)

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function project(slug: string) {
  return { slug, remoteUrl: 'https://example.com/r.git', addedAt: '2026-01-01', sessionCount: 0 }
}

describe('image prewarm', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    _resetImagePrewarmForTests()
    // This suite may itself run inside a nested yaac session or an e2e
    // harness — neutralize the ambient gates explicitly.
    vi.stubEnv('YAAC_NESTED', undefined)
    vi.stubEnv('YAAC_IMAGE_PREWARM', undefined)
    vi.stubEnv('YAAC_REQUIRE_PREBUILT_IMAGES', undefined)
    vi.stubEnv('YAAC_IMAGE_PREFIX', undefined)
    mockResolveConfig.mockResolvedValue(null)
    mockResolveChain.mockResolvedValue({ layers: [], finalTag: 'yaac-tools:t' })
    mockBlockingFailure.mockReturnValue(false)
    mockEnsureImage.mockResolvedValue('yaac-tools:t')
    mockPush.mockResolvedValue('localhost:5001/yaac-tools:t')
  })
  afterEach(() => vi.unstubAllEnvs())

  describe('gates', () => {
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
  })

  describe('reconcileImagePrewarm', () => {
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
  })

  describe('prewarmProjectImage', () => {
    it('backs off a chain with a recent blocking failure', async () => {
      mockResolveChain.mockResolvedValue({
        layers: [
          { tag: 'yaac-base:b', name: 'base', dockerfile: '/df', context: '/ctx', contentHash: 'h' },
        ],
        finalTag: 'yaac-tools:t',
      })
      mockBlockingFailure.mockReturnValue(true)

      await prewarmProjectImage('p')

      expect(mockBlockingFailure).toHaveBeenCalledWith(
        ['yaac-base:b', 'yaac-tools:t'], expect.any(Number))
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
})
