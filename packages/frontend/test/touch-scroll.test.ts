import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { patchTouchScroll, reportsForTravel } from '#lib/touch-scroll'

describe('reportsForTravel', () => {
  it('earns one report per whole unit of travel, carrying the remainder', () => {
    expect(reportsForTravel(0, 85)).toEqual({ reports: 0, rest: 0 })
    expect(reportsForTravel(40, 85)).toEqual({ reports: 0, rest: 40 })
    expect(reportsForTravel(85, 85)).toEqual({ reports: -1, rest: 0 })
    expect(reportsForTravel(200, 85)).toEqual({ reports: -2, rest: 30 })
  })

  it('inverts the sign: a finger moving down scrolls back', () => {
    // Positive travel (down the screen) pulls earlier content in, which is a
    // wheel-up — the negative direction the report path uses.
    expect(reportsForTravel(170, 85).reports).toBe(-2)
    expect(reportsForTravel(-170, 85).reports).toBe(2)
    expect(reportsForTravel(-200, 85)).toEqual({ reports: 2, rest: -30 })
  })

  it('earns nothing while the cell height is unmeasured', () => {
    expect(reportsForTravel(500, 0)).toEqual({ reports: 0, rest: 500 })
  })
})

describe('patchTouchScroll', () => {
  // The glide runs on animation frames and measures the finger on the
  // performance clock; both are faked so a test decides how fast a swipe was.
  // Node has no animation frames, so they are timers at 60Hz.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16))
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  type Report = { col: number; row: number; button: number; action: number }

  /** A fake of exactly the internals the patch touches, plus a stand-in for
   *  the element it binds to and a swipe driver. Cell height is 17, so a
   *  report is earned every 85px of travel. */
  function fakeTerm(
    // `unknown` so a test can hand over a reshaped dimensions object, which is
    // the whole point of the option.
    { dimensions = { css: { cell: { height: 17 } } } }: { dimensions?: unknown } = {},
  ): {
    term: Terminal
    reports: Report[]
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
    const listeners = new Map<string, (e: TouchEvent) => void>()
    let mouseActive = true
    let prevented = 0
    const coreMouseService = {
      get areMouseEventsActive(): boolean {
        return mouseActive
      },
      triggerMouseEvent: (e: Report): boolean => {
        reports.push({ ...e })
        return true
      },
    }
    const el = {
      addEventListener: (type: string, fn: (e: TouchEvent) => void): void => {
        listeners.set(type, fn)
      },
      removeEventListener: (type: string): void => {
        listeners.delete(type)
      },
    }
    const term = {
      _core: {
        element: el,
        screenElement: {},
        _mouseService: {
          getMouseReportCoords: () => ({ col: 3, row: 4, x: 30, y: 40 }),
        },
        coreMouseService,
        _renderService: { dimensions },
      },
    } as unknown as Terminal

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
      get prevented(): number { return prevented },
      setMouseActive: (a) => { mouseActive = a },
      swipe,
      touch,
      listeners,
    }
  }

  it('turns a swipe down into wheel-up reports at the touched cell', () => {
    const f = fakeTerm()
    expect(patchTouchScroll(f.term)).not.toBeNull()
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
    // Every move past the slop is preventDefault'd, not just the ones that
    // earned a report — otherwise the browser gets to synthesize the click
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

  it('sends nothing when nothing is reporting the mouse', () => {
    const f = fakeTerm()
    patchTouchScroll(f.term)
    f.setMouseActive(false)
    f.swipe(200)
    expect(f.reports).toHaveLength(0)
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
    // 200px in 100ms: 2px/ms at release. The drag alone earns 2 reports; the
    // glide adds about velocity × 500ms more travel — ~1000px, ~12 reports.
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
    dispose?.()
    expect(vi.getTimerCount()).toBe(0)
    expect(f.listeners.size).toBe(0)
  })

  it('reports failure without throwing when the internals are missing', () => {
    expect(patchTouchScroll({} as Terminal)).toBeNull()
    expect(patchTouchScroll({ _core: {} } as unknown as Terminal)).toBeNull()
  })

  it('says so once, and claims nothing, when the cell-height shape has moved', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* quiet */ })
    // What an xterm upgrade reshaping dimensions leaves behind: the install
    // guard still passes (_renderService is there), so this is the only place
    // a dead touch path can announce itself.
    const f = fakeTerm({ dimensions: {} })
    expect(patchTouchScroll(f.term)).not.toBeNull()
    f.swipe(400)
    f.swipe(400)
    expect(f.reports).toHaveLength(0)
    // Nothing claimed: the gesture is left to the browser, exactly as it was
    // before this patch existed, so a tap is still a tap.
    expect(f.prevented).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  // Canaries for the pinned dependency (same convention as selection.test.ts):
  // the patch reaches into private xterm internals, so an upgrade that renames
  // or mangles them must fail here rather than silently leaving a phone with
  // no way to scroll a pane.
  it('still finds the private names in the shipped xterm bundle', () => {
    const require = createRequire(import.meta.url)
    const bundle = readFileSync(require.resolve('@xterm/xterm'), 'utf8')
    expect(bundle).toContain('screenElement')
    expect(bundle).toContain('_mouseService')
    expect(bundle).toContain('getMouseReportCoords')
    expect(bundle).toContain('coreMouseService')
    expect(bundle).toContain('triggerMouseEvent')
    expect(bundle).toContain('areMouseEventsActive')
    expect(bundle).toContain('_renderService')
    // Not just the service: the shape under it. Its own guard can only prove
    // _renderService exists, so a reshaped `dimensions` would leave the patch
    // reporting success with every gesture dead — the one failure here that
    // isn't loud on its own.
    expect(bundle).toContain('dimensions.css.cell.height')
  })

  // The gesture is only claimable because the browser was told not to pan;
  // the rule and the handler are two halves of one mechanism.
  it('the stylesheet still takes touch-action away from the terminal', () => {
    const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.xterm\s*\{[^}]*touch-action:\s*none/)
  })
})
