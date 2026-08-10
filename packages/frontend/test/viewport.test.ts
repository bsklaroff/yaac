// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { MOBILE_QUERY, isMobileViewport, useIsMobile, useVisualViewportHeight } from '#lib/viewport'

/** A controllable matchMedia: `set()` flips the match and notifies listeners,
 *  the way a real resize or rotation would. */
function stubMatchMedia(initial: boolean): { set: (matches: boolean) => void; queries: string[] } {
  const listeners = new Set<(e: MediaQueryListEvent) => void>()
  const queries: string[] = []
  let matches = initial
  const mql = {
    get matches() { return matches },
    addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => { listeners.add(fn) },
    removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => { listeners.delete(fn) },
  }
  window.matchMedia = ((q: string) => { queries.push(q); return mql }) as unknown as typeof window.matchMedia
  return {
    queries,
    set: (next) => {
      matches = next
      for (const fn of listeners) fn({ matches: next } as MediaQueryListEvent)
    },
  }
}

const realMatchMedia = window.matchMedia

afterEach(() => {
  cleanup()
  window.matchMedia = realMatchMedia
  document.documentElement.style.removeProperty('--app-height')
})

describe('useIsMobile', () => {
  it('reports the breakpoint query and tracks it across a resize', () => {
    const mq = stubMatchMedia(false)
    const { result } = renderHook(() => useIsMobile())
    expect(mq.queries).toContain(MOBILE_QUERY)
    expect(result.current).toBe(false)

    act(() => mq.set(true))
    expect(result.current).toBe(true)

    act(() => mq.set(false))
    expect(result.current).toBe(false)
  })

  it('starts matching when the viewport is already narrow', () => {
    stubMatchMedia(true)
    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(true)
  })

  it('falls back to desktop where matchMedia is missing', () => {
    // @ts-expect-error — deleting a DOM global to model an old/odd environment
    delete window.matchMedia
    expect(isMobileViewport()).toBe(false)
    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(false)
  })

  it('drops its listener on unmount', () => {
    const mq = stubMatchMedia(false)
    const { unmount, result } = renderHook(() => useIsMobile())
    unmount()
    // No listener left to notice this — and no error from setting state on an
    // unmounted subscriber.
    act(() => mq.set(true))
    expect(result.current).toBe(false)
  })
})

describe('useVisualViewportHeight', () => {
  /** Install a fake visualViewport whose height can be changed, as a soft
   *  keyboard opening would. */
  function stubVisualViewport(height: number): (next: number) => void {
    const listeners = new Set<() => void>()
    const vv = {
      get height() { return height },
      addEventListener: (_: string, fn: () => void) => { listeners.add(fn) },
      removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn) },
    }
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true, writable: true })
    return (next) => {
      height = next
      for (const fn of listeners) fn()
    }
  }

  it('publishes the visual height and follows the keyboard opening', () => {
    const resize = stubVisualViewport(844)
    renderHook(() => useVisualViewportHeight(true))
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('844px')

    // Keyboard up: the visual viewport shrinks, the app height follows.
    act(() => resize(500))
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('500px')
  })

  it('publishes nothing while disabled, so the desktop keeps its own sizing', () => {
    stubVisualViewport(1000)
    renderHook(() => useVisualViewportHeight(false))
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('')
  })

  it('clears the property when the shell stops being mobile', () => {
    stubVisualViewport(844)
    const { rerender } = renderHook(({ on }: { on: boolean }) => useVisualViewportHeight(on), {
      initialProps: { on: true },
    })
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('844px')
    rerender({ on: false })
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('')
  })

  it('is inert where visualViewport is unavailable', () => {
    Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true, writable: true })
    expect(() => renderHook(() => useVisualViewportHeight(true))).not.toThrow()
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('')
  })
})

// The rest of the suite mocks matchMedia per-test; make sure no stray spy
// survives into the next file.
beforeEach(() => { vi.restoreAllMocks() })
