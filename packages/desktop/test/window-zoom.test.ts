import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createFsTransitionGuard, zoomAction } from '#window-zoom'

const base = { altKey: false, isFullScreen: false, isMaximized: false }

describe('zoomAction', () => {
  it('enters full screen on a plain macOS click', () => {
    expect(zoomAction({ ...base, platform: 'darwin' })).toBe('enter-full-screen')
  })

  it('exits full screen from full screen, whatever the modifier', () => {
    expect(zoomAction({ ...base, platform: 'darwin', isFullScreen: true })).toBe('exit-full-screen')
    expect(zoomAction({ ...base, platform: 'darwin', isFullScreen: true, altKey: true })).toBe('exit-full-screen')
    expect(zoomAction({ ...base, platform: 'linux', isFullScreen: true })).toBe('exit-full-screen')
  })

  it('zooms (maximize toggle) on macOS Option-click', () => {
    expect(zoomAction({ ...base, platform: 'darwin', altKey: true })).toBe('maximize')
    expect(zoomAction({ ...base, platform: 'darwin', altKey: true, isMaximized: true })).toBe('unmaximize')
  })

  it('toggles maximize on other platforms', () => {
    expect(zoomAction({ ...base, platform: 'linux' })).toBe('maximize')
    expect(zoomAction({ ...base, platform: 'win32', isMaximized: true })).toBe('unmaximize')
  })
})

describe('createFsTransitionGuard', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('arms on begin and disarms on settle', () => {
    const guard = createFsTransitionGuard(2000)
    expect(guard.active()).toBe(false)
    guard.begin()
    expect(guard.active()).toBe(true)
    guard.settle()
    expect(guard.active()).toBe(false)
  })

  it('disarms via the fallback timer when no event arrives', () => {
    const guard = createFsTransitionGuard(2000)
    guard.begin()
    vi.advanceTimersByTime(1999)
    expect(guard.active()).toBe(true)
    vi.advanceTimersByTime(1)
    expect(guard.active()).toBe(false)
  })

  it('an earlier transition timer cannot disarm a later transition', () => {
    const guard = createFsTransitionGuard(2000)
    guard.begin()
    vi.advanceTimersByTime(500)
    guard.settle()
    vi.advanceTimersByTime(1000)
    guard.begin()
    vi.advanceTimersByTime(600)
    expect(guard.active()).toBe(true)
    vi.advanceTimersByTime(1400)
    expect(guard.active()).toBe(false)
  })
})
