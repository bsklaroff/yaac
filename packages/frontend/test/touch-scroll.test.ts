import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { patchTouchScroll } from '#lib/touch-scroll'
import type { CoreMouseEvent } from '#lib/xterm-internals'
import { fakeXterm } from './harness'

describe('patchTouchScroll', () => {
  // The glide runs on animation frames and times the finger with the
  // performance clock. Both are faked (frames as 60Hz timers, since Node has
  // none) so a test controls swipe speed.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16))
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  type Report = Pick<CoreMouseEvent, 'col' | 'row' | 'button' | 'action'>

  /** A terminal recording its reports and local scrolls, with a stand-in
   *  for the element the patch binds to and a swipe driver. Cell height is
   *  `cellHeight`, so a report is earned every 5 cells of travel. */
  function fakeTerm(cellHeight = 17): {
    term: ReturnType<typeof fakeXterm>
    reports: Report[]
    /** Lines passed to `term.scrollLines` (local scrolling). */
    scrolled: number[]
    prevented: number
    setMouseActive: (a: boolean) => void
    swipe: (
      dy: number,
      opts?: { steps?: number; fingers?: number; msPerStep?: number; holdMs?: number },
    ) => void
    touch: (type: string, y: number, opts?: { fingers?: number; stamp?: number }) => void
    listeners: Map<string, (e: TouchEvent) => void>
  } {
    const reports: Report[] = []
    const scrolled: number[] = []
    const listeners = new Map<string, (e: TouchEvent) => void>()
    let mouseActive = true
    let prevented = 0
    const el = {
      addEventListener: (type: string, fn: (e: TouchEvent) => void): void => {
        listeners.set(type, fn)
      },
      removeEventListener: (type: string): void => {
        listeners.delete(type)
      },
    }
    const term = fakeXterm({
      element: el as unknown as HTMLElement,
      coreMouseService: {
        get areMouseEventsActive(): boolean {
          return mouseActive
        },
        triggerMouseEvent: (e: CoreMouseEvent): boolean => {
          reports.push({ ...e })
          return true
        },
        consumeWheelEvent: () => 0,
      },
      _renderService: { dimensions: { css: { cell: { height: cellHeight } }, device: { cell: { height: 0 } } } },
    }, {
      scrollLines: (n: number): void => { scrolled.push(n) },
    })

    /** Drag `dy` pixels (positive = down the screen) in `steps` touchmoves,
     *  `msPerStep` apart, then hold still for `holdMs` before lifting. With no
     *  time passing the release speed is unmeasurable, so nothing glides. */
    const swipe = (
      dy: number,
      { steps = 10, fingers = 1, msPerStep = 0, holdMs = 0 } = {},
    ): void => {
      touch('touchstart', 300, { fingers })
      for (let i = 1; i <= steps; i++) {
        vi.advanceTimersByTime(msPerStep)
        touch('touchmove', 300 + (dy * i) / steps, { fingers })
      }
      vi.advanceTimersByTime(holdMs)
      touch('touchend', 300 + dy, { fingers: 0 })
    }

    /** Dispatch one touch event at `y`, stamped with when the finger was
     *  there — now, unless the test says the handler is running late. */
    const touch = (
      type: string,
      y: number,
      { fingers = 1, stamp = performance.now() }: { fingers?: number; stamp?: number } = {},
    ): void => {
      listeners.get(type)?.({
        touches: Array.from({ length: fingers }, (_, i) => (
          { identifier: i, clientX: 100, clientY: y } as unknown as Touch
        )),
        timeStamp: stamp,
        cancelable: true,
        preventDefault: () => { prevented++ },
      } as unknown as TouchEvent)
    }

    return {
      term,
      reports,
      scrolled,
      get prevented(): number { return prevented },
      setMouseActive: (a) => { mouseActive = a },
      swipe,
      touch,
      listeners,
    }
  }

  it('turns a swipe down into wheel-up reports at the touched cell', () => {
    const f = fakeTerm()
    patchTouchScroll(f.term)
    f.swipe(200) // 200px / 85px-per-report → 2
    expect(f.reports).toHaveLength(2)
    expect(f.reports[0]).toMatchObject({ button: 4, action: 0, col: 3, row: 4 }) // WHEEL, UP
    expect(f.reports[1]).toMatchObject({ button: 4, action: 0 })
  })

  it('turns a swipe up into wheel-down reports', () => {
    const f = fakeTerm()
    patchTouchScroll(f.term)
    f.swipe(-200)
    expect(f.reports).toHaveLength(2)
    expect(f.reports.every((r) => r.action === 1)).toBe(true) // DOWN
  })

  it('claims the gesture so it cannot also land as a tap', () => {
    const f = fakeTerm()
    patchTouchScroll(f.term)
    f.swipe(200, { steps: 4 })
    // Every move past the slop is preventDefault'd, not just those that earned
    // a report. Otherwise the browser synthesizes a click that
    // patchClickForwarding would forward to the TUI.
    expect(f.prevented).toBeGreaterThanOrEqual(3)
  })

  it('leaves a tap alone: under the slop nothing is claimed or reported', () => {
    const f = fakeTerm()
    patchTouchScroll(f.term)
    f.swipe(6, { steps: 3 })
    expect(f.reports).toHaveLength(0)
    expect(f.prevented).toBe(0)
  })

  it('accumulates travel across moves, so a slow drag still scrolls', () => {
    const f = fakeTerm()
    patchTouchScroll(f.term)
    // 100 moves of 2px each: no single move earns a report, the run earns two.
    f.swipe(200, { steps: 100 })
    expect(f.reports).toHaveLength(2)
  })

  it('ignores a two-finger gesture', () => {
    const f = fakeTerm()
    patchTouchScroll(f.term)
    f.swipe(200, { fingers: 2 })
    expect(f.reports).toHaveLength(0)
  })

  it('scrolls the local history line by line when the app does not track the mouse', () => {
    const f = fakeTerm()
    patchTouchScroll(f.term)
    f.setMouseActive(false)
    // The first 20px move only crosses the slop; the other 180px at a 17px
    // cell are 10 lines back, followed 1:1, with no reports.
    f.swipe(200)
    expect(f.reports).toHaveLength(0)
    expect(f.scrolled.reduce((a, b) => a + b, 0)).toBe(-10)
    // And forward.
    f.scrolled.length = 0
    f.swipe(-100)
    expect(f.scrolled.reduce((a, b) => a + b, 0)).toBe(5)
  })

  it('starts each gesture fresh rather than carrying travel between them', () => {
    const f = fakeTerm()
    patchTouchScroll(f.term)
    f.swipe(80) // under one report's worth
    f.swipe(80)
    expect(f.reports).toHaveLength(0)
  })

  it('glides on after a flick, in its direction, and comes to a stop', () => {
    const f = fakeTerm()
    patchTouchScroll(f.term)
    // 200px in 100ms is 2px/ms at release. The drag earns 2 reports; the glide
    // adds about velocity × 500ms (~1000px, ~12 reports).
    f.swipe(200, { msPerStep: 10 })
    expect(f.reports).toHaveLength(2)
    vi.advanceTimersByTime(500)
    const early = f.reports.length
    vi.advanceTimersByTime(3000)
    expect(f.reports.length).toBeGreaterThanOrEqual(12)
    expect(f.reports.length).toBeLessThanOrEqual(16)
    // Decelerating: most of the glide lands in its first time constant.
    expect(early - 2).toBeGreaterThan(f.reports.length - early)
    expect(f.reports.every((r) => r.action === 0)).toBe(true) // all UP
    // The frame chain itself ended, not just the reports.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ends a glide whose next frame comes late, rather than emitting the rest at once', () => {
    let frame: FrameRequestCallback | null = null
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frame = cb
      return 1
    })
    const f = fakeTerm()
    patchTouchScroll(f.term)
    f.swipe(200, { msPerStep: 10 })
    const held = frame as FrameRequestCallback | null
    expect(held).not.toBeNull()
    // The tab was backgrounded for 5s; the frame fires on return.
    vi.advanceTimersByTime(5000)
    frame = null
    held?.(performance.now())
    expect(f.reports).toHaveLength(2) // the drag's, and nothing more
    expect(frame).toBeNull() // and no further frame asked for
  })

  it('measures the finger by when it moved, not when the handler ran', () => {
    const f = fakeTerm()
    patchTouchScroll(f.term)
    // A slow drag (0.25px/ms) whose moves a busy main thread handles 1ms
    // apart: by handler time it would look like a fast flick.
    const t0 = performance.now()
    f.touch('touchstart', 300, { stamp: t0 })
    for (let i = 1; i <= 10; i++) {
      vi.advanceTimersByTime(1)
      f.touch('touchmove', 300 + i * 10, { stamp: t0 + i * 40 })
    }
    f.touch('touchend', 400, { fingers: 0, stamp: t0 + 410 })
    const dragged = f.reports.length
    vi.advanceTimersByTime(3000)
    expect(f.reports).toHaveLength(dragged)
  })

  it('glides the way the finger was going when it reversed just before lifting', () => {
    const f = fakeTerm()
    patchTouchScroll(f.term)
    f.touch('touchstart', 300)
    // Down 80px over 80ms, then flicked back up 40px in 20ms: the window's net
    // travel is still down, but the finger left going up.
    for (let i = 1; i <= 8; i++) {
      vi.advanceTimersByTime(10)
      f.touch('touchmove', 300 + i * 10)
    }
    for (let i = 1; i <= 4; i++) {
      vi.advanceTimersByTime(5)
      f.touch('touchmove', 380 - i * 10)
    }
    f.touch('touchend', 340, { fingers: 0 })
    vi.advanceTimersByTime(3000)
    expect(f.reports.length).toBeGreaterThan(5)
    expect(f.reports.every((r) => r.action === 1)).toBe(true) // all DOWN
  })

  it('does not glide after a drag the finger stopped before lifting', () => {
    const f = fakeTerm()
    patchTouchScroll(f.term)
    f.swipe(200, { msPerStep: 10, holdMs: 100 })
    vi.advanceTimersByTime(3000)
    expect(f.reports).toHaveLength(2)
  })

  it('a touch stops a glide, and is not also a tap', () => {
    const f = fakeTerm()
    patchTouchScroll(f.term)
    f.swipe(-200, { msPerStep: 10 })
    vi.advanceTimersByTime(100)
    const prevented = f.prevented
    f.swipe(0, { steps: 0 }) // a tap
    const stopped = f.reports.length
    vi.advanceTimersByTime(3000)
    expect(f.reports).toHaveLength(stopped)
    expect(f.reports.every((r) => r.action === 1)).toBe(true) // all DOWN
    // The tap's touchend is canceled, so no click reaches the TUI.
    expect(f.prevented).toBe(prevented + 1)
  })

  it('leaves a tap after a glide has ended alone', () => {
    const f = fakeTerm()
    patchTouchScroll(f.term)
    f.swipe(200, { msPerStep: 10 })
    vi.advanceTimersByTime(5000)
    const prevented = f.prevented
    f.swipe(0, { steps: 0 })
    expect(f.prevented).toBe(prevented)
  })

  it('the disposer unbinds every listener and stops a glide', () => {
    const f = fakeTerm()
    const dispose = patchTouchScroll(f.term)
    f.swipe(200, { msPerStep: 10 })
    dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(f.listeners.size).toBe(0)
  })

  it('scrolls nothing while the cell height is unmeasured', () => {
    const f = fakeTerm(0)
    patchTouchScroll(f.term)
    f.swipe(400)
    expect(f.reports).toHaveLength(0)
  })

  // The handler can only claim the gesture because CSS tells the browser not
  // to pan.
  it('the stylesheet still takes touch-action away from the terminal', () => {
    const css = readFileSync(`${import.meta.dirname}/../src/index.css`, 'utf8')
    expect(css).toMatch(/\.xterm\s*\{[^}]*touch-action:\s*none/)
  })
})
