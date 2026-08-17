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
  document.documentElement.style.removeProperty('--app-top')
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
  /** Install a fake visualViewport whose shape can be changed, as a soft
   *  keyboard opening — or a pinch-zoom — would. */
  function stubVisualViewport(
    height: number,
  ): (next: { height?: number; offsetTop?: number; scale?: number }) => void {
    const listeners = new Set<() => void>()
    const state = { height, offsetTop: 0, scale: 1 }
    const vv = {
      get height() { return state.height },
      get offsetTop() { return state.offsetTop },
      get scale() { return state.scale },
      addEventListener: (_: string, fn: () => void) => { listeners.add(fn) },
      removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn) },
    }
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true, writable: true })
    return (next) => {
      Object.assign(state, next)
      for (const fn of listeners) fn()
    }
  }

  it('publishes the visual height and follows the keyboard opening', () => {
    const change = stubVisualViewport(844)
    renderHook(() => useVisualViewportHeight(true))
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('844px')
    expect(document.documentElement.style.getPropertyValue('--app-top')).toBe('0px')

    // Keyboard up: the visual viewport shrinks, the app height follows.
    act(() => change({ height: 500 }))
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('500px')
  })

  it('follows the slide the keyboard puts the visual viewport through', () => {
    // iOS scrolls the focused control into view and stays there, so the
    // visible region starts partway down the layout viewport. An app that
    // published only the height would sit above it, with the page showing
    // through underneath.
    const change = stubVisualViewport(844)
    renderHook(() => useVisualViewportHeight(true))

    act(() => change({ height: 500, offsetTop: 344 }))
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('500px')
    expect(document.documentElement.style.getPropertyValue('--app-top')).toBe('344px')

    // Keyboard down: back over the whole viewport.
    act(() => change({ height: 844, offsetTop: 0 }))
    expect(document.documentElement.style.getPropertyValue('--app-top')).toBe('0px')
  })

  it('leaves a pinch-zoomed pan alone — that one is the user looking around', () => {
    const change = stubVisualViewport(844)
    renderHook(() => useVisualViewportHeight(true))

    act(() => change({ height: 400, offsetTop: 200, scale: 2 }))
    expect(document.documentElement.style.getPropertyValue('--app-top')).toBe('0px')
  })

  it('still follows the keyboard on a scale left a hair off 1 by an old pinch', () => {
    // `scale` is a float, and a browser is free not to land back on exactly 1.
    // Read as "zoomed", that device loses the keyboard compensation for good —
    // with no zoom on screen to suggest why.
    const change = stubVisualViewport(844)
    renderHook(() => useVisualViewportHeight(true))

    act(() => change({ height: 500, offsetTop: 344, scale: 1.0000001 }))
    expect(document.documentElement.style.getPropertyValue('--app-top')).toBe('344px')
  })

  it('publishes nothing while disabled, so the desktop keeps its own sizing', () => {
    stubVisualViewport(1000)
    renderHook(() => useVisualViewportHeight(false))
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('')
    expect(document.documentElement.style.getPropertyValue('--app-top')).toBe('')
  })

  it('clears the property when the shell stops being mobile', () => {
    stubVisualViewport(844)
    const { rerender } = renderHook(({ on }: { on: boolean }) => useVisualViewportHeight(on), {
      initialProps: { on: true },
    })
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('844px')
    rerender({ on: false })
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('')
    expect(document.documentElement.style.getPropertyValue('--app-top')).toBe('')
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
