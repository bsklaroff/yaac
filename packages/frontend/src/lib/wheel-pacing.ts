import type { Terminal } from '@xterm/xterm'

/**
 * Wheel pacing: stop a scroll gesture from queueing more scroll reports
 * than tmux can answer.
 *
 * tmux runs with `mouse on`, so each wheel report round-trips to the
 * workspace and comes back as a redraw. A trackpad flick emits reports much
 * faster than that, so the pane would keep scrolling long after the gesture
 * ends. The pacer sends the same reports on animation frames, a few per
 * frame, and drops any backlog beyond a small cap.
 *
 * As in stock xterm, each wheel event that crosses the line threshold
 * (xterm's consumeWheelEvent) becomes a report, except that a mouse-wheel
 * notch becomes REPORTS_PER_NOTCH of them: tmux scrolls a fixed 5 lines per
 * report, which is too little for one click of a wheel. Only a notch
 * reported in line mode or as a large pixel delta is recognized (Chrome and
 * Edge on Windows and Linux, Firefox); wheels that report small pixel
 * deltas, as macOS mice and high-resolution wheels usually do, are handled
 * like a trackpad.
 */

/** Reports sent for one mouse-wheel notch. Trackpad events stay at one,
 *  since a swipe already emits a stream of them. */
const REPORTS_PER_NOTCH = 2
/** Quiet time before an event that may count as a notch. A trackpad fling
 *  arrives at the frame rate with deltas as large as a notch's, while
 *  notches come one at a time. */
const NOTCH_MIN_GAP_MS = 50

/** Reports sent per animation frame. Matches typical wheel event rates, so
 *  only a free-spinning wheel is slowed. */
const MAX_REPORTS_PER_FLUSH = 2
/** Cap on queued reports; the excess is dropped. Limits how far the pane
 *  keeps scrolling after the gesture ends. */
const MAX_BACKLOG_REPORTS = 6

/** One pacing step: how many reports to emit from a signed `pending`
 *  backlog (negative = scroll up) and how many to carry over. */
export function paceStep(
  pending: number,
  maxPerFlush: number = MAX_REPORTS_PER_FLUSH,
  maxBacklog: number = MAX_BACKLOG_REPORTS,
): { emit: number; carry: number } {
  const sign = pending < 0 ? -1 : 1
  const emit = sign * Math.min(Math.abs(pending), maxPerFlush)
  const rest = pending - emit
  // `|| 0` turns -0 into 0.
  const carry = sign * Math.min(Math.abs(rest), maxBacklog) || 0
  return { emit: emit || 0, carry }
}

/** Add signed reports to the backlog, dropping any excess over the cap. */
export function addToBacklog(
  pending: number,
  add: number,
  maxBacklog: number = MAX_BACKLOG_REPORTS,
): number {
  const next = pending + add
  const sign = next < 0 ? -1 : 1
  return sign * Math.min(Math.abs(next), maxBacklog) || 0
}

/** Whether a wheel event is a mouse-wheel notch rather than part of a
 *  trackpad swipe: a line- or page-mode delta, or a pixel delta of at least
 *  50 (xterm's trackpad test in consumeWheelEvent), arriving at least
 *  NOTCH_MIN_GAP_MS after the previous wheel event. */
export function isWheelNotch(ev: WheelEvent, msSincePrevious: number): boolean {
  if (msSincePrevious < NOTCH_MIN_GAP_MS) return false
  // 0 is WheelEvent.DOM_DELTA_PIXEL.
  return ev.deltaMode !== 0 || Math.abs(ev.deltaY) >= 50
}

/** xterm's ICoreMouseEvent (see selection.ts). */
type CoreMouseEvent = {
  col: number
  row: number
  x: number
  y: number
  button: number
  action: number
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
}

/** The private xterm internals the patch below reaches into. */
type TerminalInternals = Terminal & {
  _core?: {
    screenElement?: HTMLElement
    _mouseService?: {
      getMouseReportCoords?: (
        e: MouseEvent,
        element: HTMLElement,
      ) => { col: number; row: number; x: number; y: number } | undefined
    }
    coreMouseService?: {
      areMouseEventsActive?: boolean
      triggerMouseEvent?: (e: CoreMouseEvent) => boolean
      consumeWheelEvent?: (e: WheelEvent, cellHeight?: number, dpr?: number) => number
    }
    _renderService?: {
      dimensions?: { device?: { cell?: { height?: number } } }
    }
    _coreBrowserService?: { dpr?: number }
  }
}

// xterm's CoreMouseButton / CoreMouseAction values, which are const enums
// and not exported. Wheel-up is UP and wheel-down is DOWN.
const MOUSE_BUTTON_WHEEL = 4
const MOUSE_ACTION_UP = 0
const MOUSE_ACTION_DOWN = 1

/**
 * Install the pacer as xterm's custom wheel handler. While mouse reporting
 * is active, wheel events go into the backlog and xterm sends nothing
 * itself; otherwise they get stock handling. Reports go through xterm's own
 * CoreMouseService, as in patchClickForwarding.
 *
 * Uses private xterm internals, whose names the unit tests check. Returns a
 * disposer, or null if the internals have changed (stock behavior then).
 *
 * Call after `term.open()`.
 */
export function patchWheelPacing(term: Terminal): (() => void) | null {
  const core = (term as TerminalInternals)._core
  const screen = core?.screenElement
  const mouse = core?._mouseService
  const coreMouse = core?.coreMouseService
  const render = core?._renderService
  const browser = core?._coreBrowserService
  if (
    !screen || !mouse?.getMouseReportCoords || !coreMouse?.triggerMouseEvent
    || !coreMouse.consumeWheelEvent || !render || !browser
  ) return null
  const getCoords = mouse.getMouseReportCoords.bind(mouse)
  const trigger = coreMouse.triggerMouseEvent.bind(coreMouse)
  const consume = coreMouse.consumeWheelEvent.bind(coreMouse)

  let pending = 0
  let raf = 0
  let lastWheelAt = -Infinity
  // Position and modifiers of the last wheel event.
  let at: { col: number; row: number; x: number; y: number } | null = null
  let mods: { ctrl: boolean; alt: boolean; shift: boolean } = { ctrl: false, alt: false, shift: false }

  const flush = (): void => {
    raf = 0
    // Mouse reporting may have turned off since (a TUI exited, a reconnect).
    if (!coreMouse.areMouseEventsActive) {
      pending = 0
      return
    }
    const { emit, carry } = paceStep(pending)
    pending = carry
    if (emit !== 0 && at) {
      const action = emit < 0 ? MOUSE_ACTION_UP : MOUSE_ACTION_DOWN
      for (let i = 0; i < Math.abs(emit); i++) {
        // triggerMouseEvent mutates its argument, so pass a fresh object.
        trigger({ ...at, button: MOUSE_BUTTON_WHEEL, action, ...mods })
      }
    }
    if (pending !== 0) raf = requestAnimationFrame(flush)
  }

  term.attachCustomWheelEventHandler((ev: WheelEvent): boolean => {
    // Without mouse reporting, leave the event to stock xterm.
    if (!coreMouse.areMouseEventsActive) return true
    const msSincePrevious = ev.timeStamp - lastWheelAt
    lastWheelAt = ev.timeStamp
    // consumeWheelEvent handles sensitivity and carries fractional lines.
    const lines = consume(ev, render.dimensions?.device?.cell?.height, browser.dpr)
    if (lines === 0) return false
    const pos = getCoords(ev, screen)
    if (!pos) return false
    at = pos
    mods = { ctrl: ev.ctrlKey, alt: ev.altKey, shift: ev.shiftKey }
    const reports = isWheelNotch(ev, msSincePrevious) ? REPORTS_PER_NOTCH : 1
    pending = addToBacklog(pending, lines < 0 ? -reports : reports)
    if (raf === 0) raf = requestAnimationFrame(flush)
    return false
  })

  return (): void => {
    if (raf !== 0) cancelAnimationFrame(raf)
    pending = 0
    // There is no detach; an always-true handler restores stock behavior.
    term.attachCustomWheelEventHandler(() => true)
  }
}
