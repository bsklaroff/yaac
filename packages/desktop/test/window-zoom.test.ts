import { describe, it, expect } from 'vitest'
import { zoomAction } from '#window-zoom'

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
