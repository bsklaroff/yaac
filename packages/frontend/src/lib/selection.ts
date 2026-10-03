import type { Terminal } from '@xterm/xterm'

/** The mouse-event field the decision needs, so tests need not build a full
 *  MouseEvent. */
export type SelectionMouse = Pick<MouseEvent, 'altKey'>

/**
 * Whether a mousedown should start a local xterm text selection instead of
 * being reported to the app (when it tracks the mouse).
 *
 * A plain drag selects, so copy works without a modifier. Holding Alt
 * (Option on macOS) sends the gesture to the app instead, for TUIs that want
 * the mouse.
 */
export function forceLocalSelection(e: SelectionMouse): boolean {
  return !e.altKey
}

/** xterm's ICoreMouseEvent: a mouse event to report to the pty, with
 *  zero-based col/row, pixel x/y, a button and an action. */
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

/** The private xterm internals the patches below reach into. */
type TerminalInternals = Terminal & {
  _core?: {
    _selectionService?: {
      shouldForceSelection?: (e: MouseEvent) => boolean
      clearSelection?: () => void
      disable?: () => void
    }
    coreService?: {
      triggerDataEvent?: (data: string, wasUserInput?: boolean) => void
    }
    // `element` is the wrapper xterm binds its mouse listeners to;
    // `screenElement` is what mouse-report coordinates are measured against.
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
  }
}

// xterm's CoreMouseButton / CoreMouseAction values, which are const enums
// and not exported.
const MOUSE_BUTTON_LEFT = 0
const MOUSE_ACTION_UP = 0
const MOUSE_ACTION_DOWN = 1

/**
 * Forward a plain left-click to the pty as a press+release mouse report, so
 * clicks reach a TUI's widgets without a modifier, while a plain drag still
 * selects text locally.
 *
 * A mousedown must either start a selection or report to the pty before it
 * is known whether the gesture is a click or a drag. So the mousedown starts
 * a selection as usual, and on mouseup a click is forwarded only if nothing
 * was selected. (A double-click forwards the single click before it, which
 * is harmless for TUI widgets.)
 *
 * The replay uses xterm's own CoreMouseService and MouseService, the same
 * path its built-in reporting takes. Uses private internals; returns a
 * disposer, or null if the internals have changed (clicks then need Alt).
 *
 * Call after `term.open()`.
 */
export function patchClickForwarding(term: Terminal): (() => void) | null {
  const core = (term as TerminalInternals)._core
  const el = core?.element
  const screen = core?.screenElement
  const mouse = core?._mouseService
  const coreMouse = core?.coreMouseService
  if (!el || !screen || !mouse?.getMouseReportCoords || !coreMouse?.triggerMouseEvent) return null
  // Both methods use `this`, so bind them.
  const getCoords = mouse.getMouseReportCoords.bind(mouse)
  const trigger = coreMouse.triggerMouseEvent.bind(coreMouse)

  // The press that may become a forwarded click.
  let pending: MouseEvent | null = null

  const onDown = (e: MouseEvent): void => {
    // Only a plain primary press. xterm already reports Alt gestures itself,
    // and Cmd- or Ctrl-click opens a link (#lib/terminal-links).
    pending = e.button === 0 && !e.altKey && !e.ctrlKey && !e.metaKey ? e : null
  }

  const onUp = (): void => {
    const down = pending
    pending = null
    if (!down) return
    // A drag or word/line select is a copy, not a click.
    if (term.hasSelection()) return
    if (!coreMouse.areMouseEventsActive) return
    // triggerMouseEvent mutates its argument, so pass a fresh object each call.
    const pos = getCoords(down, screen)
    if (!pos) return
    const at = { col: pos.col, row: pos.row, x: pos.x, y: pos.y, button: MOUSE_BUTTON_LEFT }
    trigger({ ...at, action: MOUSE_ACTION_DOWN })
    trigger({ ...at, action: MOUSE_ACTION_UP })
  }

  el.addEventListener('mousedown', onDown)
  // The release may land just outside the terminal element.
  el.ownerDocument.addEventListener('mouseup', onUp)
  return () => {
    el.removeEventListener('mousedown', onDown)
    el.ownerDocument.removeEventListener('mouseup', onUp)
  }
}

/**
 * Replace xterm's forced-selection rule (Shift+drag, or Option+drag on
 * macOS) with forceLocalSelection: plain drag selects locally and Alt+drag
 * is reported to the app. xterm has no public hook for this, so this patches the
 * private selection service. xterm is pinned to an exact version and the
 * unit tests check the private names; if they change this returns false.
 *
 * Call after `term.open()`.
 */
export function patchForcedSelection(term: Terminal): boolean {
  const svc = (term as TerminalInternals)._core?._selectionService
  if (!svc?.shouldForceSelection) return false
  svc.shouldForceSelection = forceLocalSelection
  return true
}

/**
 * Keep the mouse selection until the user makes a new one (or the buffer
 * resizes or resets). Stock xterm clears it in two ways that misfire with
 * mouse-tracking TUIs:
 *
 *  1. It clears on every byte sent to the pty. When the TUI tracks mouse
 *     motion (mode 1003), just moving the mouse sends reports and clears
 *     the selection. The listener can't be removed, so clearSelection calls
 *     made during coreService.triggerDataEvent (which all input passes
 *     through) are dropped.
 *
 *  2. Every mouse-protocol DECSET, even a redundant one that TUIs
 *     send on redraw, calls SelectionService.disable(), which clears. Its
 *     clear is dropped the same way.
 *
 * Call after `term.open()`. Returns false if the internals have changed.
 */
export function patchKeepSelection(term: Terminal): boolean {
  const internals = (term as TerminalInternals)._core
  const svc = internals?._selectionService
  const coreService = internals?.coreService
  const clear = svc?.clearSelection?.bind(svc)
  const disable = svc?.disable?.bind(svc)
  const trigger = coreService?.triggerDataEvent?.bind(coreService)
  if (!svc || !clear || !disable || !coreService || !trigger) return false
  let suppressClear = false
  const suppressDuring = (fn: () => void): void => {
    suppressClear = true
    try {
      fn()
    } finally {
      suppressClear = false
    }
  }
  svc.clearSelection = (): void => {
    if (suppressClear) return
    clear()
  }
  svc.disable = (): void => suppressDuring(disable)
  coreService.triggerDataEvent = (data: string, wasUserInput?: boolean): void =>
    suppressDuring(() => trigger(data, wasUserInput))
  return true
}
