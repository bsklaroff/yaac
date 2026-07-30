import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { addToBacklog, paceStep, patchWheelPacing } from '#lib/wheel-pacing'

describe('paceStep', () => {
  it('emits the whole backlog when under the per-flush cap', () => {
    expect(paceStep(1, 2, 6)).toEqual({ emit: 1, carry: 0 })
    expect(paceStep(-2, 2, 6)).toEqual({ emit: -2, carry: 0 })
    expect(paceStep(0, 2, 6)).toEqual({ emit: 0, carry: 0 })
  })

  it('caps emission per flush and carries the rest', () => {
    expect(paceStep(5, 2, 6)).toEqual({ emit: 2, carry: 3 })
    expect(paceStep(-5, 2, 6)).toEqual({ emit: -2, carry: -3 })
  })

  it('clamps the carried backlog to the cap', () => {
    expect(paceStep(20, 2, 6)).toEqual({ emit: 2, carry: 6 })
    expect(paceStep(-20, 2, 6)).toEqual({ emit: -2, carry: -6 })
  })
})

describe('addToBacklog', () => {
  it('accumulates signed reports', () => {
    expect(addToBacklog(0, 1, 6)).toBe(1)
    expect(addToBacklog(1, -1, 6)).toBe(0)
    expect(addToBacklog(-2, -1, 6)).toBe(-3)
  })

  it('drops the excess beyond the cap in either direction', () => {
    expect(addToBacklog(6, 1, 6)).toBe(6)
    expect(addToBacklog(-6, -1, 6)).toBe(-6)
  })
})

describe('patchWheelPacing', () => {
  type Report = { col: number; row: number; button: number; action: number }

  /** A fake of exactly the internals the patch touches, plus the public
   *  attachCustomWheelEventHandler. */
  function fakeTerm(): {
    term: Terminal
    reports: Report[]
    setMouseActive: (a: boolean) => void
    wheel: (deltaY: number, opts?: Partial<WheelEvent>) => boolean | undefined
  } {
    const reports: Report[] = []
    let handler: ((ev: WheelEvent) => boolean) | null = null
    let mouseActive = true
    const coreMouseService = {
      get areMouseEventsActive(): boolean {
        return mouseActive
      },
      triggerMouseEvent: (e: Report): boolean => {
        reports.push({ ...e })
        return true
      },
      // Real consumeWheelEvent damps and carries fractions; the fake maps
      // one event to one line so tests control the report count directly.
      consumeWheelEvent: (ev: WheelEvent): number => (ev.deltaY === 0 ? 0 : ev.deltaY < 0 ? -1 : 1),
    }
    const term = {
      _core: {
        screenElement: {},
        _mouseService: {
          getMouseReportCoords: () => ({ col: 3, row: 4, x: 30, y: 40 }),
        },
        coreMouseService,
        _renderService: { dimensions: { device: { cell: { height: 16 } } } },
        _coreBrowserService: { dpr: 2 },
      },
      attachCustomWheelEventHandler: (h: (ev: WheelEvent) => boolean): void => {
        handler = h
      },
    } as unknown as Terminal
    return {
      term,
      reports,
      setMouseActive: (a) => { mouseActive = a },
      wheel: (deltaY, opts = {}) => handler?.({
        deltaY, ctrlKey: false, altKey: false, shiftKey: false, ...opts,
      } as WheelEvent),
    }
  }

  /** Run pending animation-frame callbacks one frame at a time. */
  function frames(): { step: () => void; dispose: () => void } {
    let queue: FrameRequestCallback[] = []
    let id = 1
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      queue.push(cb)
      return id++
    })
    vi.stubGlobal('cancelAnimationFrame', (): void => { /* dropped with the queue */ })
    return {
      step: () => {
        const run = queue
        queue = []
        for (const cb of run) cb(0)
      },
      dispose: () => vi.unstubAllGlobals(),
    }
  }

  let raf: { step: () => void; dispose: () => void }
  beforeEach(() => { raf = frames() })
  afterEach(() => raf.dispose())

  it('claims wheel events while mouse reporting is active, passes them through when not', () => {
    const f = fakeTerm()
    expect(patchWheelPacing(f.term)).not.toBeNull()
    expect(f.wheel(100)).toBe(false)
    f.setMouseActive(false)
    expect(f.wheel(100)).toBe(true)
  })

  it('emits one wheel report per qualifying event, on the next frame', () => {
    const f = fakeTerm()
    patchWheelPacing(f.term)
    f.wheel(-100)
    expect(f.reports).toHaveLength(0) // nothing until the frame flushes
    raf.step()
    expect(f.reports).toHaveLength(1)
    expect(f.reports[0]).toMatchObject({ button: 4, action: 0 }) // WHEEL, UP
    // 1-based coord fixup happens inside the real triggerMouseEvent; the
    // patch hands over the raw report coords.
    expect(f.reports[0]).toMatchObject({ col: 3, row: 4 })
  })

  it('paces a burst across frames and drops backlog beyond the cap', () => {
    const f = fakeTerm()
    patchWheelPacing(f.term)
    for (let i = 0; i < 20; i++) f.wheel(100) // one gesture's worth of events
    // Backlog is capped at 6; drained 2 per frame → 3 frames, 6 reports.
    raf.step()
    raf.step()
    raf.step()
    raf.step()
    expect(f.reports).toHaveLength(6)
    expect(f.reports.every((r) => r.action === 1)).toBe(true) // DOWN
  })

  it('a reversal cancels queued scroll in the old direction', () => {
    const f = fakeTerm()
    patchWheelPacing(f.term)
    for (let i = 0; i < 4; i++) f.wheel(100)
    for (let i = 0; i < 4; i++) f.wheel(-100)
    raf.step()
    raf.step()
    expect(f.reports).toHaveLength(0) // netted out before any flush
  })

  it('drops the backlog if mouse reporting turns off before the flush', () => {
    const f = fakeTerm()
    patchWheelPacing(f.term)
    f.wheel(100)
    f.setMouseActive(false)
    raf.step()
    expect(f.reports).toHaveLength(0)
  })

  it('emits nothing for events below the line threshold', () => {
    const f = fakeTerm()
    patchWheelPacing(f.term)
    expect(f.wheel(0)).toBe(false)
    raf.step()
    expect(f.reports).toHaveLength(0)
  })

  it('the disposer stops emission and restores stock handling', () => {
    const f = fakeTerm()
    const dispose = patchWheelPacing(f.term)
    f.wheel(100)
    dispose?.()
    raf.step()
    expect(f.reports).toHaveLength(0)
    expect(f.wheel(100)).toBe(true) // stock: xterm processes the event
  })

  it('reports failure without throwing when the internals are missing', () => {
    expect(patchWheelPacing({} as Terminal)).toBeNull()
    expect(patchWheelPacing({ _core: {} } as unknown as Terminal)).toBeNull()
  })

  // Canaries for the pinned dependency (same convention as selection.test.ts):
  // the patch reaches into private xterm internals, so an upgrade that
  // renames or mangles them must fail here rather than silently reverting
  // scrolling to unpaced reports.
  it('still finds the private names in the shipped xterm bundle', () => {
    const require = createRequire(import.meta.url)
    const bundle = readFileSync(require.resolve('@xterm/xterm'), 'utf8')
    expect(bundle).toContain('coreMouseService')
    expect(bundle).toContain('consumeWheelEvent')
    expect(bundle).toContain('triggerMouseEvent')
    expect(bundle).toContain('areMouseEventsActive')
    expect(bundle).toContain('getMouseReportCoords')
    expect(bundle).toContain('_renderService')
    expect(bundle).toContain('_coreBrowserService')
    expect(bundle).toContain('attachCustomWheelEventHandler')
  })
})
