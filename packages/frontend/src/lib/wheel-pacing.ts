import type { Terminal } from '@xterm/xterm'
import { MOUSE_ACTION_DOWN, MOUSE_ACTION_UP, MOUSE_BUTTON_WHEEL, type ReportCoords, xtermCore } from './xterm-internals'

/**
 * Wheel pacing: stop a scroll gesture from queueing more scroll reports
 * than a mouse-tracking app can answer.
 *
 * When the app tracks the mouse (every agent's fullscreen TUI),
 * it holds the transcript, so each wheel report round-trips to the
 * workspace and comes back as a redraw. A trackpad flick emits reports much
 * faster than that, so the pane would keep scrolling long after the gesture
 * ends. The pacer sends the same reports on animation frames, a few per
 * frame, and drops any backlog beyond a small cap. When the app does not
 * track the mouse, the history is in xterm's own scrollback and the wheel
 * gets stock, local handling.
 *
 * As in stock xterm, each wheel event that crosses the line threshold
 * (xterm's consumeWheelEvent) becomes a report, except that a mouse-wheel
 * notch becomes REPORTS_PER_NOTCH of them: apps scroll a few lines per
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

/** A signed backlog of reports (negative = scroll up) clamped to the cap,
 *  dropping the excess. */
function clampBacklog(n: number): number {
  // `|| 0` turns -0 into 0.
  return Math.sign(n) * Math.min(Math.abs(n), MAX_BACKLOG_REPORTS) || 0
}

/** Whether a wheel event is a mouse-wheel notch rather than part of a
 *  trackpad swipe: a line- or page-mode delta, or a pixel delta of at least
 *  50 (xterm's trackpad test in consumeWheelEvent), arriving at least
 *  NOTCH_MIN_GAP_MS after the previous wheel event. */
function isWheelNotch(ev: WheelEvent, msSincePrevious: number): boolean {
  if (msSincePrevious < NOTCH_MIN_GAP_MS) return false
  // 0 is WheelEvent.DOM_DELTA_PIXEL.
  return ev.deltaMode !== 0 || Math.abs(ev.deltaY) >= 50
}

/**
 * Install the pacer as xterm's custom wheel handler. While mouse reporting
 * is active, wheel events go into the backlog and xterm sends nothing
 * itself; otherwise they get stock handling. Reports go through xterm's own
 * CoreMouseService, as in patchClickForwarding. Returns a disposer. Call
 * after `term.open()`.
 */
export function patchWheelPacing(term: Terminal): () => void {
  const {
    screenElement: screen,
    _mouseService: mouse,
    coreMouseService: coreMouse,
    _renderService: render,
    _coreBrowserService: browser,
  } = xtermCore(term)

  let pending = 0
  let raf = 0
  let lastWheelAt = -Infinity
  // Position and modifiers of the last wheel event.
  let at: ReportCoords = { col: 0, row: 0, x: 0, y: 0 }
  let mods: { ctrl: boolean; alt: boolean; shift: boolean } = { ctrl: false, alt: false, shift: false }

  const flush = (): void => {
    raf = 0
    // Mouse reporting may have turned off since (a TUI exited, a reconnect).
    if (!coreMouse.areMouseEventsActive) {
      pending = 0
      return
    }
    const emit = Math.min(Math.abs(pending), MAX_REPORTS_PER_FLUSH)
    const action = pending < 0 ? MOUSE_ACTION_UP : MOUSE_ACTION_DOWN
    pending -= Math.sign(pending) * emit
    for (let i = 0; i < emit; i++) {
      coreMouse.triggerMouseEvent({ ...at, button: MOUSE_BUTTON_WHEEL, action, ...mods })
    }
    if (pending !== 0) raf = requestAnimationFrame(flush)
  }

  term.attachCustomWheelEventHandler((ev: WheelEvent): boolean => {
    // Without mouse reporting, leave the event to stock xterm.
    if (!coreMouse.areMouseEventsActive) return true
    const msSincePrevious = ev.timeStamp - lastWheelAt
    lastWheelAt = ev.timeStamp
    // consumeWheelEvent handles sensitivity and carries fractional lines.
    const lines = coreMouse.consumeWheelEvent(ev, render.dimensions.device.cell.height, browser.dpr)
    if (lines === 0) return false
    const pos = mouse.getMouseReportCoords(ev, screen)
    if (!pos) return false
    at = pos
    mods = { ctrl: ev.ctrlKey, alt: ev.altKey, shift: ev.shiftKey }
    const reports = isWheelNotch(ev, msSincePrevious) ? REPORTS_PER_NOTCH : 1
    pending = clampBacklog(pending + (lines < 0 ? -reports : reports))
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
