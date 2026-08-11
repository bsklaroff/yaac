import type { Terminal } from '@xterm/xterm'

/**
 * Touch scrolling: make a one-finger swipe over the terminal scroll it.
 *
 * Nothing else in the stack does. xterm has no touch handling at all — its
 * viewport is a transform-scrolled element with painted scrollbars, not a
 * native overflow scroller — and a browser synthesizes no wheel event from a
 * touch pan, so the wheel path (see wheel-pacing) never fires either. On a
 * phone that leaves a terminal pane with no way to see anything that has
 * scrolled off, which is most of what an agent prints.
 *
 * The gesture is translated into the same wheel reports the mouse path sends,
 * because scrolling an attached pane is a remote operation: tmux runs with
 * `mouse on`, so the scrollback lives in the pod and a report is what moves
 * it (into copy-mode, or into whatever the TUI in the pane does with a wheel).
 * When nothing is reporting — a pane app that turned the mouse off, or a
 * graceful detach that reset the mode on its way out — the same travel scrolls
 * xterm's own viewport instead.
 *
 * Unlike the wheel path this needs no pacing. A wheel gesture outruns the
 * round trip because a trackpad's momentum keeps emitting events after the
 * fingers stop; a drag *is* the finger, and one report per five cell-heights
 * of travel is a rate no hand can push past a couple per frame. Reports go
 * out as the finger moves, and stop when it stops.
 *
 * Reaches into private xterm internals; the unit tests canary the names.
 * Returns a disposer, or null if the internals have moved (touch then does
 * nothing, as before this patch).
 *
 * Call after `term.open()`.
 */

/** Lines tmux scrolls per wheel report (`send -X -N 5 scroll-up`, its default
 *  copy-mode binding). Converting travel at this rate makes the content track
 *  the finger about 1:1, which is what a drag is expected to do. */
const LINES_PER_REPORT = 5

/** Travel before a touch is a scroll rather than a tap. Below it the gesture
 *  is left alone, so the browser still synthesizes the click that
 *  patchClickForwarding hands to the TUI. */
const TOUCH_SLOP_PX = 8

/** How many scroll reports a run of finger travel has earned, and the travel
 *  left over to carry into the next move. Pure for testing.
 *
 *  `travelPx` is signed with the screen: positive is a finger moving *down*,
 *  which pulls earlier content into view, so the reports come back negative —
 *  the same sign the wheel path uses for scrolling back. */
export function reportsForTravel(
  travelPx: number,
  pxPerReport: number,
): { reports: number; rest: number } {
  if (pxPerReport <= 0) return { reports: 0, rest: travelPx }
  const steps = Math.trunc(travelPx / pxPerReport)
  // `|| 0` normalizes the -0 the negation produces on an empty run.
  return { reports: -steps || 0, rest: travelPx - steps * pxPerReport }
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
}

/** The private xterm internals the patch below reaches into. */
type TerminalInternals = Terminal & {
  _core?: {
    // The outer wrapper xterm binds its own input listeners to, and the inner
    // screen element report coordinates are measured against — the same pair
    // patchClickForwarding uses.
    element?: HTMLElement
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
    }
    _renderService?: {
      dimensions?: { css?: { cell?: { height?: number } } }
    }
  }
}

// xterm's CoreMouseButton / CoreMouseAction values (const enums, inlined at
// build time and not exported for us to import): the wheel "button" is 4,
// a wheel-up is UP (0) and a wheel-down is DOWN (1).
const MOUSE_BUTTON_WHEEL = 4
const MOUSE_ACTION_UP = 0
const MOUSE_ACTION_DOWN = 1

export function patchTouchScroll(term: Terminal): (() => void) | null {
  const core = (term as TerminalInternals)._core
  const el = core?.element
  const screen = core?.screenElement
  const mouse = core?._mouseService
  const coreMouse = core?.coreMouseService
  const render = core?._renderService
  if (
    !el || !screen || !mouse?.getMouseReportCoords || !coreMouse?.triggerMouseEvent || !render
  ) return null
  // Both read `this` (char/render/buffer services), so keep them bound.
  const getCoords = mouse.getMouseReportCoords.bind(mouse)
  const trigger = coreMouse.triggerMouseEvent.bind(coreMouse)

  /** The touch being followed; null between gestures and for any gesture that
   *  isn't a single finger. */
  let touchId: number | null = null
  let startY = 0
  let lastY = 0
  /** Past the slop: this gesture is ours, and no longer a candidate tap. */
  let scrolling = false
  /** Travel not yet worth a report, carried so a slow drag still adds up. */
  let travel = 0
  /** Set when the gesture is claimed — cell height changes with the font and
   *  the fit, and is only measured once the terminal has rendered. */
  let pxPerReport = 0
  let warnedNoCellHeight = false

  const emit = (reports: number, at: { clientX: number; clientY: number }): void => {
    // Nothing reporting — a pane app that turned the mouse off, or a graceful
    // detach, which resets the mode on its way out. Scroll xterm's own
    // viewport, the stock behavior for that state.
    //
    // A dropped socket is deliberately not on that list: nothing resets the
    // parser's DECSET state, so reporting stays nominally active and reports
    // go out into the closed-socket guard in WorktreeTerminal and are dropped.
    // That is the right outcome anyway — the pane is alternate-screen for the
    // whole attach, so there is no local scrollback for the other branch to
    // move — but it means a reconnect shows no local scrolling either.
    if (!coreMouse.areMouseEventsActive) {
      term.scrollLines(reports * LINES_PER_REPORT)
      return
    }
    // getMouseReportCoords reads only clientX/clientY off the event, so a
    // Touch stands in for the MouseEvent its signature asks for.
    const pos = getCoords(at as MouseEvent, screen)
    if (!pos) return
    const action = reports < 0 ? MOUSE_ACTION_UP : MOUSE_ACTION_DOWN
    for (let i = 0; i < Math.abs(reports); i++) {
      // triggerMouseEvent mutates its argument (1-based coord fixup), so hand
      // it a fresh object each call.
      trigger({ ...pos, button: MOUSE_BUTTON_WHEEL, action })
    }
  }

  const onStart = (e: TouchEvent): void => {
    // Multi-touch is not ours (and with touch-action: none the browser does
    // nothing with it either).
    if (e.touches.length !== 1) {
      touchId = null
      return
    }
    const t = e.touches[0]
    touchId = t.identifier
    startY = t.clientY
    lastY = t.clientY
    scrolling = false
    travel = 0
    pxPerReport = 0
  }

  const onMove = (e: TouchEvent): void => {
    if (touchId === null) return
    if (e.touches.length !== 1 || e.touches[0].identifier !== touchId) {
      touchId = null
      return
    }
    const t = e.touches[0]
    if (!scrolling) {
      if (Math.abs(t.clientY - startY) < TOUCH_SLOP_PX) return
      scrolling = true
      // The slop is spent identifying the gesture, not scrolled with.
      lastY = t.clientY
      const cell = render.dimensions?.css?.cell?.height ?? 0
      pxPerReport = cell > 0 ? cell * LINES_PER_REPORT : 0
    }
    // A real swipe that found no cell height. The install guard can only prove
    // _renderService exists — the shape under it has moved across xterm majors
    // before — so without this the patch reports success and every gesture
    // silently no-ops, green unit suite and all. Degrading to today's behavior
    // (nothing claimed, taps still tap) is the right runtime answer; being
    // quiet about it is not.
    if (pxPerReport === 0) {
      if (!warnedNoCellHeight) {
        warnedNoCellHeight = true
        console.warn('xterm internals changed: no cell height, touch cannot scroll the pane')
      }
      return
    }
    // Claim the gesture: no page pan behind the terminal, and no compatibility
    // click at the end of it — a swipe must not also press whatever it started
    // over (patchClickForwarding would forward that to the TUI).
    e.preventDefault()
    travel += t.clientY - lastY
    lastY = t.clientY
    const { reports, rest } = reportsForTravel(travel, pxPerReport)
    travel = rest
    if (reports !== 0) emit(reports, t)
  }

  const onEnd = (): void => {
    touchId = null
    scrolling = false
    travel = 0
  }

  el.addEventListener('touchstart', onStart, { passive: true })
  // Non-passive: the whole gesture turns on being able to preventDefault it.
  el.addEventListener('touchmove', onMove, { passive: false })
  el.addEventListener('touchend', onEnd)
  el.addEventListener('touchcancel', onEnd)
  return (): void => {
    el.removeEventListener('touchstart', onStart)
    el.removeEventListener('touchmove', onMove)
    el.removeEventListener('touchend', onEnd)
    el.removeEventListener('touchcancel', onEnd)
  }
}
