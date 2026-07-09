// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { isElectron } from '@/frontend/lib/platform'

afterEach(() => vi.unstubAllGlobals())

describe('isElectron', () => {
  it('is true when the userAgent contains Electron', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 yaac/0.0.3 Electron/43.0.0 Safari/537.36' })
    expect(isElectron()).toBe(true)
  })
  it('is false in a normal browser', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 Chrome/120.0 Safari/537.36' })
    expect(isElectron()).toBe(false)
  })
})
