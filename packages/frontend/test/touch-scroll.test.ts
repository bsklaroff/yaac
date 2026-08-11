import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, it, expect, vi } from 'vitest'
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
    scrolledLines: number[]
    prevented: number
    setMouseActive: (a: boolean) => void
    swipe: (dy: number, opts?: { steps?: number; fingers?: number }) => void
    listeners: Map<string, (e: TouchEvent) => void>
  } {
    const reports: Report[] = []
    const scrolledLines: number[] = []
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
      scrollLines: (n: number): void => { scrolledLines.push(n) },
    } as unknown as Terminal

    /** Drag `dy` pixels (positive = down the screen) in `steps` touchmoves. */
    const swipe = (dy: number, { steps = 10, fingers = 1 } = {}): void => {
      const touches = (y: number): Touch[] =>
        Array.from({ length: fingers }, (_, i) => (
          { identifier: i, clientX: 100, clientY: y } as unknown as Touch
        ))
      const event = (y: number): TouchEvent => ({
        touches: touches(y),
        preventDefault: () => { prevented++ },
      } as unknown as TouchEvent)
      listeners.get('touchstart')?.(event(300))
      for (let i = 1; i <= steps; i++) listeners.get('touchmove')?.(event(300 + (dy * i) / steps))
      listeners.get('touchend')?.({} as TouchEvent)
    }

    return {
      term,
      reports,
      scrolledLines,
      get prevented(): number { return prevented },
      setMouseActive: (a) => { mouseActive = a },
      swipe,
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

  it('scrolls xterm itself when nothing is reporting the mouse', () => {
    const f = fakeTerm()
    patchTouchScroll(f.term)
    f.setMouseActive(false)
    f.swipe(200)
    expect(f.reports).toHaveLength(0)
    expect(f.scrolledLines).toEqual([-5, -5]) // two reports' worth, back
  })

  it('starts each gesture fresh rather than carrying travel between them', () => {
    const f = fakeTerm()
    patchTouchScroll(f.term)
    f.swipe(80) // under one report's worth
    f.swipe(80)
    expect(f.reports).toHaveLength(0)
  })

  it('the disposer unbinds every listener', () => {
    const f = fakeTerm()
    const dispose = patchTouchScroll(f.term)
    dispose?.()
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
