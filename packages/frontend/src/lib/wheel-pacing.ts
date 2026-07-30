import type { Terminal } from '@xterm/xterm'

/**
 * Wheel pacing: keep a scroll gesture from queueing more remote scroll
 * steps than tmux can answer.
 *
 * Scrolling an attached pane is a remote operation — tmux runs with
 * `mouse on`, so every wheel report round-trips to the pod and comes back
 * as a redraw. Stock xterm forwards one report per browser wheel event,
 * and a trackpad flick (plus its momentum tail) emits them far faster
 * than the redraw round trip drains them: the backlog keeps the pane
 * scrolling long after the fingers stop and the terminal repaints as fast
 * as bursts arrive. The pacer re-times the same reports onto animation
 * frames — a bounded number per frame, with a bounded backlog whose
 * excess is dropped — so the pane tracks the gesture and stops when it
 * stops.
 *
 * Scroll semantics are unchanged: like stock xterm, each wheel event that
 * crosses the line threshold (xterm's own consumeWheelEvent, which owns
 * trackpad damping and fractional-delta carry) becomes exactly one
 * report; only the timing and the queue bound are new.
 */

/** Reports released per flush (one flush per animation frame). Above the
 *  browser's own wheel-event rate per frame, so pacing never slows a
 *  gesture down — it only stops backlog from outliving it. */
const MAX_REPORTS_PER_FLUSH = 2
/** Cap on queued reports; excess is dropped. Bounds how far the pane keeps
 *  scrolling after the gesture ends (tmux scrolls a few lines per report). */
const MAX_BACKLOG_REPORTS = 6

/** One pacing step, pure for testing: how many reports to emit from a
 *  `pending` backlog (signed: negative = scroll up) and what to carry. */
export function paceStep(
  pending: number,
  maxPerFlush: number = MAX_REPORTS_PER_FLUSH,
  maxBacklog: number = MAX_BACKLOG_REPORTS,
): { emit: number; carry: number } {
  const sign = pending < 0 ? -1 : 1
  const emit = sign * Math.min(Math.abs(pending), maxPerFlush)
  const rest = pending - emit
  // `|| 0` normalizes the -0 the sign multiply produces on empty rests.
  const carry = sign * Math.min(Math.abs(rest), maxBacklog) || 0
  return { emit: emit || 0, carry }
}

/** Accumulate signed report units and clamp the backlog (drop the excess —
 *  a queue deeper than the cap is a gesture that already ended). */
export function addToBacklog(
  pending: number,
  add: number,
  maxBacklog: number = MAX_BACKLOG_REPORTS,
): number {
  const next = pending + add
  const sign = next < 0 ? -1 : 1
  return sign * Math.min(Math.abs(next), maxBacklog) || 0
}

/** A cell the pty should be told a mouse event happened at (xterm's
 *  ICoreMouseEvent shape, as in patchClickForwarding). */
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

// xterm's CoreMouseButton / CoreMouseAction values (const enums, inlined at
// build time and not exported for us to import): the wheel "button" is 4,
// a wheel-up is UP (0) and a wheel-down is DOWN (1).
const MOUSE_BUTTON_WHEEL = 4
const MOUSE_ACTION_UP = 0
const MOUSE_ACTION_DOWN = 1

/**
 * Install the pacer via term.attachCustomWheelEventHandler. While tmux has
 * mouse reporting active, wheel events accumulate into the paced backlog
 * and the handler returns false (xterm sends nothing itself); when mouse
 * reporting is off (mid-reconnect), events pass through to stock handling
 * untouched. Reports replay through xterm's own CoreMouseService and
 * MouseService (honoring the negotiated protocol/encoding), the exact path
 * built-in reporting takes — same approach as patchClickForwarding.
 *
 * Reaches into private xterm internals; the unit tests canary the names.
 * Returns a disposer, or null if the internals have moved (wheel behavior
 * then reverts to stock, as before this patch).
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
  // Where and with which modifiers the reports land: the last wheel event
  // wins (the pointer doesn't move mid-gesture in any way that matters).
  let at: { col: number; row: number; x: number; y: number } | null = null
  let mods: { ctrl: boolean; alt: boolean; shift: boolean } = { ctrl: false, alt: false, shift: false }

  const flush = (): void => {
    raf = 0
    // The pane app can turn mouse reporting off between accumulation and
    // flush (a TUI exiting, a reconnect): drop the backlog, report nothing.
    if (!coreMouse.areMouseEventsActive) {
      pending = 0
      return
    }
    const { emit, carry } = paceStep(pending)
    pending = carry
    if (emit !== 0 && at) {
      const action = emit < 0 ? MOUSE_ACTION_UP : MOUSE_ACTION_DOWN
      for (let i = 0; i < Math.abs(emit); i++) {
        // triggerMouseEvent mutates its argument (1-based coord fixup), so
        // hand it a fresh object each call.
        trigger({ ...at, button: MOUSE_BUTTON_WHEEL, action, ...mods })
      }
    }
    if (pending !== 0) raf = requestAnimationFrame(flush)
  }

  term.attachCustomWheelEventHandler((ev: WheelEvent): boolean => {
    // No mouse reporting active (reconnecting, or a pane app turned it
    // off): stock xterm handling.
    if (!coreMouse.areMouseEventsActive) return true
    // Same gating as stock reporting: consumeWheelEvent owns sensitivity,
    // trackpad damping, and the fractional-line carry — an event below the
    // line threshold emits nothing now and carries its fraction forward.
    const lines = consume(ev, render.dimensions?.device?.cell?.height, browser.dpr)
    if (lines === 0) return false
    const pos = getCoords(ev, screen)
    if (!pos) return false
    at = pos
    mods = { ctrl: ev.ctrlKey, alt: ev.altKey, shift: ev.shiftKey }
    // One report per qualifying event, exactly like stock — the pacer only
    // re-times it and bounds the queue.
    pending = addToBacklog(pending, lines < 0 ? -1 : 1)
    if (raf === 0) raf = requestAnimationFrame(flush)
    return false
  })

  return (): void => {
    if (raf !== 0) cancelAnimationFrame(raf)
    pending = 0
    // attachCustomWheelEventHandler has no detach; an always-true handler
    // restores stock behavior for the terminal's remaining lifetime.
    term.attachCustomWheelEventHandler(() => true)
  }
}
