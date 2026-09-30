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
 * A drag tracks the finger; a flick glides on after it lifts, the way native
 * scrolling does on a phone. The glide is the same travel-to-reports
 * conversion driven by a decaying velocity on animation frames instead of by
 * the finger, so its rate is bounded (MAX_FLICK_VELOCITY is about one report a
 * frame) and it ends on its own within a couple of seconds. Touching the pane
 * stops it, and that touch is not also a tap.
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

/** Finger speed at release (px/ms) below which the gesture was a drag that
 *  ended where it stopped, not a flick. */
const MIN_FLICK_VELOCITY = 0.3
/** Cap on the release speed a glide starts from. About one report per frame
 *  at a typical cell height — enough to cover a long scrollback in a few
 *  flicks without queueing more redraws than tmux answers in a frame. */
const MAX_FLICK_VELOCITY = 6
/** Glide decay time constant: velocity falls to 1/e every this many ms, so a
 *  glide travels velocity × this in total. iOS's normal deceleration rate
 *  (0.998 per ms). */
const GLIDE_TAU_MS = 500
/** Velocity at which a glide is over. */
const GLIDE_STOP_VELOCITY = 0.05
/** The trailing stretch of a drag its release velocity is measured over. */
const VELOCITY_WINDOW_MS = 100
/** A gap between glide frames longer than this — a backgrounded tab, a locked
 *  phone, a long stall — ends the glide instead of integrating the gap, which
 *  would emit the whole rest of it in one frame. A native scroller doesn't
 *  resume a flick you left behind either. */
const MAX_GLIDE_FRAME_GAP_MS = 100

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

/** The finger's velocity (px/ms, screen-signed) at `now`, from the samples of
 *  a drag. Zero when the finger had stopped before lifting — a drag that ended
 *  still leaves nothing to glide. */
function releaseVelocity(samples: readonly { t: number; y: number }[], now: number): number {
  const last = samples.at(-1)
  if (!last || now - last.t > VELOCITY_WINDOW_MS / 2) return 0
  const first = samples.find((s) => s.t >= last.t - VELOCITY_WINDOW_MS) ?? last
  const dt = last.t - first.t
  if (dt <= 0) return 0
  const v = (last.y - first.y) / dt
  return Math.max(-MAX_FLICK_VELOCITY, Math.min(MAX_FLICK_VELOCITY, v))
}

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
  /** The drag's recent positions, for its release velocity — timed by when
   *  the finger was there (the event's timeStamp), not when a busy main thread
   *  got round to handling it. Only the current direction's run is kept. */
  let samples: { t: number; y: number }[] = []
  /** Sign of the drag's last nonzero move. */
  let direction = 0
  /** Where the finger last was: the cell a glide's reports land at. */
  let touchAt = { clientX: 0, clientY: 0 }
  /** The running glide's animation frame, 0 when there is none. */
  let glideFrame = 0
  /** This touch stopped a glide, so lifting it is not a tap. */
  let caughtGlide = false

  const emit = (reports: number, at: { clientX: number; clientY: number }): void => {
    // Nothing reporting — a pane app that turned the mouse off, or a graceful
    // detach, which resets the mode on its way out. There is nothing local to
    // scroll either: the terminal keeps no scrollback (WorktreeTerminal sets
    // `scrollback: 0`; history lives in tmux).
    //
    // A dropped socket is deliberately not on that list: nothing resets the
    // parser's DECSET state, so reporting stays nominally active and reports
    // go out into the closed-socket guard in WorktreeTerminal and are dropped.
    if (!coreMouse.areMouseEventsActive) return
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

  /** Turn the carried travel into whatever reports it has earned. */
  const drain = (): void => {
    const { reports, rest } = reportsForTravel(travel, pxPerReport)
    travel = rest
    if (reports !== 0) emit(reports, touchAt)
  }

  const stopGlide = (): boolean => {
    if (glideFrame === 0) return false
    cancelAnimationFrame(glideFrame)
    glideFrame = 0
    return true
  }

  const glide = (velocity: number): void => {
    let prev = performance.now()
    const frame = (): void => {
      const now = performance.now()
      if (now - prev > MAX_GLIDE_FRAME_GAP_MS) {
        glideFrame = 0
        travel = 0
        return
      }
      const decay = Math.exp(-(now - prev) / GLIDE_TAU_MS)
      prev = now
      // The exact distance the decaying velocity covers over this frame, so
      // the glide's length doesn't depend on the frame rate.
      travel += velocity * GLIDE_TAU_MS * (1 - decay)
      velocity *= decay
      drain()
      glideFrame = Math.abs(velocity) < GLIDE_STOP_VELOCITY ? 0 : requestAnimationFrame(frame)
    }
    glideFrame = requestAnimationFrame(frame)
  }

  const onStart = (e: TouchEvent): void => {
    caughtGlide = stopGlide()
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
    samples = []
    direction = 0
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
    const dy = t.clientY - lastY
    // A turn restarts the measurement at the turning point, so a flick back
    // isn't averaged with the drag it reversed.
    if (dy * direction < 0) samples = samples.slice(-1)
    if (dy !== 0) direction = Math.sign(dy)
    samples.push({ t: e.timeStamp, y: t.clientY })
    while (samples[0].t < e.timeStamp - VELOCITY_WINDOW_MS) samples.shift()
    travel += dy
    lastY = t.clientY
    touchAt = { clientX: t.clientX, clientY: t.clientY }
    drain()
  }

  const onEnd = (e: TouchEvent): void => {
    // A touch that only stopped a glide is not a tap on whatever it landed on.
    if (caughtGlide && !scrolling && e.cancelable) e.preventDefault()
    // Only a gesture that stayed one finger to the end can be a flick.
    const velocity = scrolling && touchId !== null ? releaseVelocity(samples, e.timeStamp) : 0
    touchId = null
    scrolling = false
    caughtGlide = false
    // The drag's leftover travel carries into the glide, so it continues the
    // drag's report cadence rather than restarting it.
    if (Math.abs(velocity) >= MIN_FLICK_VELOCITY) glide(velocity)
    else travel = 0
  }

  el.addEventListener('touchstart', onStart, { passive: true })
  // Non-passive: the whole gesture turns on being able to preventDefault it,
  // and a touch that stops a glide cancels its click at touchend.
  el.addEventListener('touchmove', onMove, { passive: false })
  el.addEventListener('touchend', onEnd, { passive: false })
  el.addEventListener('touchcancel', onEnd)
  return (): void => {
    stopGlide()
    el.removeEventListener('touchstart', onStart)
    el.removeEventListener('touchmove', onMove)
    el.removeEventListener('touchend', onEnd)
    el.removeEventListener('touchcancel', onEnd)
  }
}
