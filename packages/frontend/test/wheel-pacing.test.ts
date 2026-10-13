import { describe, it, expect, vi, beforeEach } from 'vitest'
import { patchWheelPacing } from '#lib/wheel-pacing'
import type { CoreMouseEvent } from '#lib/xterm-internals'
import { fakeXterm } from './harness'

describe('patchWheelPacing', () => {
  type Report = Pick<CoreMouseEvent, 'col' | 'row' | 'button' | 'action'>

  /** A terminal recording its wheel reports and its custom wheel handler. */
  function fakeTerm(): {
    term: ReturnType<typeof fakeXterm>
    reports: Report[]
    setMouseActive: (a: boolean) => void
    wheel: (deltaY: number, opts?: Partial<WheelEvent>) => boolean | undefined
  } {
    const reports: Report[] = []
    let handler: ((ev: WheelEvent) => boolean) | null = null
    let mouseActive = true
    // Events default to 200 ms apart, far enough for each to be a notch.
    let now = 0
    const term = fakeXterm({
      coreMouseService: {
        get areMouseEventsActive(): boolean {
          return mouseActive
        },
        triggerMouseEvent: (e: CoreMouseEvent): boolean => {
          reports.push({ ...e })
          return true
        },
        // Real consumeWheelEvent damps and carries fractions; the fake maps
        // one event to one line so tests control the report count directly.
        consumeWheelEvent: (ev: WheelEvent): number => (ev.deltaY === 0 ? 0 : ev.deltaY < 0 ? -1 : 1),
      },
    }, {
      attachCustomWheelEventHandler: (h: (ev: WheelEvent) => boolean): void => {
        handler = h
      },
    })
    return {
      term,
      reports,
      setMouseActive: (a) => { mouseActive = a },
      wheel: (deltaY, opts = {}) => handler?.({
        deltaY, deltaMode: 0, timeStamp: (now += 200), ctrlKey: false, altKey: false, shiftKey: false, ...opts,
      } as WheelEvent),
    }
  }

  /** Pending animation-frame callbacks, run one frame at a time by `step`. */
  let queue: FrameRequestCallback[] = []
  const step = (): void => {
    const run = queue
    queue = []
    for (const cb of run) cb(0)
  }
  beforeEach(() => {
    queue = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => queue.push(cb))
    vi.stubGlobal('cancelAnimationFrame', (): void => { queue = [] })
  })

  it('claims wheel events while mouse reporting is active, passes them through when not', () => {
    const f = fakeTerm()
    patchWheelPacing(f.term)
    expect(f.wheel(100)).toBe(false)
    f.setMouseActive(false)
    expect(f.wheel(100)).toBe(true)
  })

  it('emits one wheel report per trackpad event, on the next frame', () => {
    const f = fakeTerm()
    patchWheelPacing(f.term)
    f.wheel(-10)
    expect(f.reports).toHaveLength(0) // nothing until the frame flushes
    step()
    expect(f.reports).toHaveLength(1)
    expect(f.reports[0]).toMatchObject({ button: 4, action: 0 }) // WHEEL, UP
    // 1-based coord fixup happens inside the real triggerMouseEvent; the
    // patch hands over the raw report coords.
    expect(f.reports[0]).toMatchObject({ col: 3, row: 4 })
  })

  it('emits extra reports for a mouse-wheel notch', () => {
    const f = fakeTerm()
    patchWheelPacing(f.term)
    f.wheel(100) // pixel-mode notch
    step()
    expect(f.reports).toHaveLength(2)
    f.wheel(3, { deltaMode: 1 }) // line-mode notch (Firefox)
    step()
    expect(f.reports).toHaveLength(4)
    expect(f.reports.every((r) => r.action === 1)).toBe(true) // DOWN
  })

  it('treats a stream of large pixel deltas as a trackpad fling', () => {
    const f = fakeTerm()
    patchWheelPacing(f.term)
    // A fling arrives at the frame rate; only its first event, with nothing
    // before it, can pass for a notch.
    for (let i = 0; i < 20; i++) {
      f.wheel(-60, { timeStamp: 10_000 + i * 16 })
      step()
    }
    expect(f.reports).toHaveLength(21)
  })

  it('paces a burst across frames and drops backlog beyond the cap', () => {
    const f = fakeTerm()
    patchWheelPacing(f.term)
    for (let i = 0; i < 20; i++) f.wheel(100) // one gesture's worth of events
    // Backlog is capped at 6; drained 2 per frame → 3 frames, 6 reports.
    step()
    step()
    step()
    step()
    expect(f.reports).toHaveLength(6)
    expect(f.reports.every((r) => r.action === 1)).toBe(true) // DOWN
  })

  it('a reversal cancels queued scroll in the old direction', () => {
    const f = fakeTerm()
    patchWheelPacing(f.term)
    for (let i = 0; i < 3; i++) f.wheel(100)
    for (let i = 0; i < 3; i++) f.wheel(-100)
    step()
    step()
    expect(f.reports).toHaveLength(0) // netted out before any flush
  })

  it('drops the backlog if mouse reporting turns off before the flush', () => {
    const f = fakeTerm()
    patchWheelPacing(f.term)
    f.wheel(100)
    f.setMouseActive(false)
    step()
    expect(f.reports).toHaveLength(0)
  })

  it('emits nothing for events below the line threshold', () => {
    const f = fakeTerm()
    patchWheelPacing(f.term)
    expect(f.wheel(0)).toBe(false)
    step()
    expect(f.reports).toHaveLength(0)
  })

  it('the disposer stops emission and restores stock handling', () => {
    const f = fakeTerm()
    const dispose = patchWheelPacing(f.term)
    f.wheel(100)
    dispose()
    step()
    expect(f.reports).toHaveLength(0)
    expect(f.wheel(100)).toBe(true) // stock: xterm processes the event
  })
})
