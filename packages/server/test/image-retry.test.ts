import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Stub the rebuild targets so we assert what retry *fires* without running a
// real prewarm sweep or touching the proxy client (which pulls in k8s). The
// proxy method is hoisted to a standalone fn so tests reference it directly
// (an `obj.method` reference would trip eslint's unbound-method rule).
const { ensureRunning } = vi.hoisted(() => ({ ensureRunning: vi.fn().mockResolvedValue(undefined) }))
vi.mock('#image-prewarm', () => ({ prewarmProjectImage: vi.fn().mockResolvedValue(undefined) }))
vi.mock('#lib/container/proxy-client', () => ({ proxyClient: { ensureRunning } }))

import { retryImageBuild } from '#image-retry'
import { prewarmProjectImage } from '#image-prewarm'
import {
  attachImageBuildProject,
  clearAllImageBuildsForTests,
  failImageBuild,
  getImageBuild,
  hasBlockingFailure,
  registerImageBuild,
} from '#image-builds'
import { _resetSessionListChangedForTests } from '#sessions-changed'

describe('retryImageBuild', () => {
  beforeEach(() => { clearAllImageBuildsForTests(); vi.clearAllMocks() })
  afterEach(() => { clearAllImageBuildsForTests(); _resetSessionListChangedForTests() })

  it('forgets a failed project build and re-triggers its chain', () => {
    const id = registerImageBuild({
      tag: 'yaac-tools:abc', layer: 'tools', action: 'build', projectSlug: 'proj-a', reason: 'prewarm',
    })
    failImageBuild(id, 'boom')
    expect(hasBlockingFailure(['yaac-tools:abc'], 10 * 60_000)).toBe(true)

    expect(retryImageBuild(id)).toBe(true)
    // The entry is forgotten, so it no longer backs off the prewarm sweep.
    expect(getImageBuild(id)).toBeUndefined()
    expect(hasBlockingFailure(['yaac-tools:abc'], 10 * 60_000)).toBe(false)
    expect(vi.mocked(prewarmProjectImage)).toHaveBeenCalledWith('proj-a')
    expect(ensureRunning).not.toHaveBeenCalled()
  })

  it('re-triggers every owning project of a shared layer', () => {
    const id = registerImageBuild({
      tag: 'yaac-base:abc', layer: 'base', action: 'build', projectSlug: 'proj-a', reason: 'prewarm',
    })
    attachImageBuildProject(id, 'proj-b')
    failImageBuild(id, 'boom')

    expect(retryImageBuild(id)).toBe(true)
    expect(vi.mocked(prewarmProjectImage)).toHaveBeenCalledWith('proj-a')
    expect(vi.mocked(prewarmProjectImage)).toHaveBeenCalledWith('proj-b')
  })

  it('rebuilds the proxy sidecar for an infra build with no owning project', () => {
    const id = registerImageBuild({
      tag: 'yaac-proxy:abc', layer: 'proxy', action: 'build', reason: 'session',
    })
    failImageBuild(id, 'boom')

    expect(retryImageBuild(id)).toBe(true)
    expect(ensureRunning).toHaveBeenCalledTimes(1)
    expect(vi.mocked(prewarmProjectImage)).not.toHaveBeenCalled()
  })

  it('no-ops (and rebuilds nothing) for an unknown id or a running build', () => {
    expect(retryImageBuild('missing')).toBe(false)

    const running = registerImageBuild({
      tag: 'x:1', layer: 'base', action: 'build', projectSlug: 'p', reason: 'session',
    })
    expect(retryImageBuild(running)).toBe(false)
    expect(getImageBuild(running)?.status).toBe('running') // still tracked
    expect(vi.mocked(prewarmProjectImage)).not.toHaveBeenCalled()
    expect(ensureRunning).not.toHaveBeenCalled()
  })
})
