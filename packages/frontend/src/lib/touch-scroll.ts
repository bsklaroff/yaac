import type { Terminal } from '@xterm/xterm'

/**
 * Touch scrolling: make a one-finger swipe over the terminal scroll it.
 *
 * xterm has no touch handling, and browsers don't turn a touch pan into
 * wheel events, so without this a phone can't see anything that scrolled
 * off. The swipe is turned into the same wheel reports the mouse sends:
 * tmux runs with `mouse on` and holds the scrollback, so reports are what
 * scroll it.
 *
 * A drag tracks the finger; a flick keeps gliding after the finger lifts,
 * with decaying speed, like native scrolling. Touching the pane stops a
 * glide, and that touch is not also a tap.
 */

/** Lines tmux scrolls per wheel report (its default copy-mode binding).
 *  Converting travel at this rate makes content follow the finger ~1:1. */
const LINES_PER_REPORT = 5

/** Travel before a touch counts as a scroll. Below it the browser still
 *  generates the click that patchClickForwarding sends to the TUI. */
const TOUCH_SLOP_PX = 8

/** Release speed (px/ms) below which a gesture is a drag, not a flick. */
const MIN_FLICK_VELOCITY = 0.3
/** Cap on a glide's starting speed: about one report per frame at a typical
 *  cell height. */
const MAX_FLICK_VELOCITY = 6
/** Glide decay time constant: velocity falls to 1/e every this many ms,
 *  matching iOS's normal deceleration rate. */
const GLIDE_TAU_MS = 500
/** Velocity at which a glide is over. */
const GLIDE_STOP_VELOCITY = 0.05
/** The trailing part of a drag its release velocity is measured over. */
const VELOCITY_WINDOW_MS = 100
/** A longer gap between glide frames (a background tab, a locked phone)
 *  ends the glide rather than emitting the rest of it in one frame. */
const MAX_GLIDE_FRAME_GAP_MS = 100

/** How many scroll reports a run of finger travel has earned, and the
 *  leftover travel to carry forward.
 *
 *  Positive `travelPx` is a finger moving down, which scrolls back, so the
 *  reports are negative (the wheel path's sign for scrolling back). */
export function reportsForTravel(
  travelPx: number,
  pxPerReport: number,
): { reports: number; rest: number } {
  if (pxPerReport <= 0) return { reports: 0, rest: travelPx }
  const steps = Math.trunc(travelPx / pxPerReport)
  // `|| 0` turns -0 into 0.
  return { reports: -steps || 0, rest: travelPx - steps * pxPerReport }
}

/** xterm's ICoreMouseEvent (see selection.ts). */
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
    // The same pair patchClickForwarding uses.
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

// xterm's CoreMouseButton / CoreMouseAction values, which are const enums
// and not exported. Wheel-up is UP and wheel-down is DOWN.
const MOUSE_BUTTON_WHEEL = 4
const MOUSE_ACTION_UP = 0
const MOUSE_ACTION_DOWN = 1

/** The finger's velocity (px/ms) at `now`, from a drag's samples. Zero if
 *  the finger had stopped before lifting. */
function releaseVelocity(samples: readonly { t: number; y: number }[], now: number): number {
  const last = samples.at(-1)
  if (!last || now - last.t > VELOCITY_WINDOW_MS / 2) return 0
  const first = samples.find((s) => s.t >= last.t - VELOCITY_WINDOW_MS) ?? last
  const dt = last.t - first.t
  if (dt <= 0) return 0
  const v = (last.y - first.y) / dt
  return Math.max(-MAX_FLICK_VELOCITY, Math.min(MAX_FLICK_VELOCITY, v))
}

/**
 * Install touch scrolling. Uses private xterm internals, whose names the
 * unit tests check. Returns a disposer, or null if the internals have
 * changed. Call after `term.open()`.
 */
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
  // Both methods use `this`, so bind them.
  const getCoords = mouse.getMouseReportCoords.bind(mouse)
  const trigger = coreMouse.triggerMouseEvent.bind(coreMouse)

  /** The touch being followed; null between gestures and for multi-touch. */
  let touchId: number | null = null
  let startY = 0
  let lastY = 0
  /** Past the slop: this gesture is a scroll, not a tap. */
  let scrolling = false
  /** Travel not yet worth a report, carried forward. */
  let travel = 0
  /** Measured when the gesture starts scrolling, since cell height changes
   *  with the font and fit. */
  let pxPerReport = 0
  let warnedNoCellHeight = false
  /** Recent positions in the current direction, for the release velocity.
   *  Timed by the event's timeStamp, not by when it was handled. */
  let samples: { t: number; y: number }[] = []
  /** Sign of the drag's last nonzero move. */
  let direction = 0
  /** Where the finger last was; glide reports are sent at this position. */
  let touchAt = { clientX: 0, clientY: 0 }
  /** The running glide's animation frame, 0 when there is none. */
  let glideFrame = 0
  /** This touch stopped a glide, so lifting it is not a tap. */
  let caughtGlide = false

  const emit = (reports: number, at: { clientX: number; clientY: number }): void => {
    // Without mouse reporting there is nothing to scroll: the terminal keeps
    // no scrollback (history lives in tmux).
    if (!coreMouse.areMouseEventsActive) return
    // getMouseReportCoords reads only clientX/clientY, which a Touch has.
    const pos = getCoords(at as MouseEvent, screen)
    if (!pos) return
    const action = reports < 0 ? MOUSE_ACTION_UP : MOUSE_ACTION_DOWN
    for (let i = 0; i < Math.abs(reports); i++) {
      // triggerMouseEvent mutates its argument, so pass a fresh object.
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
      // Exact distance over this frame, so the frame rate doesn't matter.
      travel += velocity * GLIDE_TAU_MS * (1 - decay)
      velocity *= decay
      drain()
      glideFrame = Math.abs(velocity) < GLIDE_STOP_VELOCITY ? 0 : requestAnimationFrame(frame)
    }
    glideFrame = requestAnimationFrame(frame)
  }

  const onStart = (e: TouchEvent): void => {
    caughtGlide = stopGlide()
    // Ignore multi-touch.
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
      // Travel within the slop doesn't scroll.
      lastY = t.clientY
      const cell = render.dimensions?.css?.cell?.height ?? 0
      pxPerReport = cell > 0 ? cell * LINES_PER_REPORT : 0
    }
    // No cell height: xterm's internals changed below what the install
    // check can see. Do nothing, but warn once.
    if (pxPerReport === 0) {
      if (!warnedNoCellHeight) {
        warnedNoCellHeight = true
        console.warn('xterm internals changed: no cell height, touch cannot scroll the pane')
      }
      return
    }
    // Claim the gesture: no page pan, and no click at the end that
    // patchClickForwarding would send to the TUI.
    e.preventDefault()
    const dy = t.clientY - lastY
    // On a direction change, restart velocity sampling at the turn.
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
    // A touch that only stopped a glide is not a tap.
    if (caughtGlide && !scrolling && e.cancelable) e.preventDefault()
    // Only a gesture that stayed single-finger can be a flick.
    const velocity = scrolling && touchId !== null ? releaseVelocity(samples, e.timeStamp) : 0
    touchId = null
    scrolling = false
    caughtGlide = false
    // Leftover travel carries into the glide.
    if (Math.abs(velocity) >= MIN_FLICK_VELOCITY) glide(velocity)
    else travel = 0
  }

  el.addEventListener('touchstart', onStart, { passive: true })
  // Non-passive, so move and end can preventDefault.
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
