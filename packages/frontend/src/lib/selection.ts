import type { Terminal } from '@xterm/xterm'

/** Just the field the decision needs — keeps this pure and trivial to unit
 *  test without synthesizing a full MouseEvent. */
export type SelectionMouse = Pick<MouseEvent, 'altKey'>

/**
 * Whether a mousedown should start a local xterm text selection instead of
 * being reported to tmux (which runs with `mouse on`).
 *
 * Plain drag selects, so copy/paste just works with no modifier. Holding Alt
 * (Option on macOS) is the escape hatch that hands the click/drag to tmux
 * for the rare TUI that wants the mouse.
 */
export function forceLocalSelection(e: SelectionMouse): boolean {
  return !e.altKey
}

/** A cell the pty should be told a mouse event happened at (xterm's
 *  ICoreMouseEvent: zero-based col/row plus pixel x/y, a CoreMouseButton and a
 *  CoreMouseAction). */
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
    // The outer wrapper xterm binds all its own mouse listeners to (so a click
    // anywhere in the terminal, padding included, reaches ours too) and the
    // inner screen element mouse-report coordinates are measured against — the
    // same two elements xterm's built-in reporting uses.
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

// xterm's CoreMouseButton / CoreMouseAction values. They're const enums, so
// they're inlined at build time and not exported for us to import: the primary
// button is 0, a press is DOWN (1) and a release is UP (0).
const MOUSE_BUTTON_LEFT = 0
const MOUSE_ACTION_UP = 0
const MOUSE_ACTION_DOWN = 1

/**
 * Forward a plain (unmodified) left-click to the pty as a press+release mouse
 * report, so a single click lands on a TUI's clickable widgets with no
 * modifier — while a plain *drag* still selects text locally (copy/paste is
 * unchanged, since patchForcedSelection keeps drag = select) and Alt+drag still
 * hands the whole gesture to tmux.
 *
 * A mousedown can only do one of {start a local selection, report to the pty},
 * and the choice is made before we know whether the gesture will be a click or
 * a drag. So we let it start a selection as usual and, on mouseup, forward a
 * click only when nothing got selected. term.hasSelection() draws the line: a
 * bare click leaves the selection empty (selectionEnd stays undefined), whereas
 * a drag or a double/triple-click word/line select leaves a real selection —
 * those are copies and we never forward them. (A double-click still forwards
 * the single click that precedes it; TUI widgets are single-click, so this is
 * harmless.)
 *
 * The replay goes through xterm's own CoreMouseService (honoring the protocol
 * and encoding tmux negotiated) and MouseService coordinate mapping — the exact
 * path its built-in reporting takes. Reaches into private fields like the
 * patches above; returns a disposer to unbind the listeners, or null if the
 * internals have moved (clicks then need Alt again, as before this patch).
 *
 * Call after `term.open()`.
 */
export function patchClickForwarding(term: Terminal): (() => void) | null {
  const core = (term as TerminalInternals)._core
  // Listen on the wrapper xterm itself uses so a click anywhere in the terminal
  // reaches us; measure coordinates against the inner screen element, as
  // getMouseReportCoords expects.
  const el = core?.element
  const screen = core?.screenElement
  const mouse = core?._mouseService
  const coreMouse = core?.coreMouseService
  if (!el || !screen || !mouse?.getMouseReportCoords || !coreMouse?.triggerMouseEvent) return null
  // Both read `this` (char/render/buffer services), so keep them bound to their
  // owning service rather than calling the bare references.
  const getCoords = mouse.getMouseReportCoords.bind(mouse)
  const trigger = coreMouse.triggerMouseEvent.bind(coreMouse)

  // The press that might resolve to a forwardable click. Cleared the instant
  // the gesture disqualifies itself (non-primary button or Alt held).
  let pending: MouseEvent | null = null

  const onDown = (e: MouseEvent): void => {
    // Only a plain primary press is a candidate. Alt is the explicit
    // hand-to-tmux modifier: xterm already reports that gesture itself
    // (shouldForceSelection is false under Alt), so forwarding would double it.
    pending = e.button === 0 && !e.altKey ? e : null
  }

  const onUp = (): void => {
    const down = pending
    pending = null
    if (!down) return
    // A drag or a word/line select produced a real selection — that's a copy,
    // not a click. Leave it be.
    if (term.hasSelection()) return
    // Nothing to click if the app isn't tracking the mouse.
    if (!coreMouse.areMouseEventsActive) return
    // Replay the press location as a full press+release so the TUI sees an
    // ordinary click. triggerMouseEvent mutates its argument (1-based coord
    // fixup), so hand it a fresh object each call.
    const pos = getCoords(down, screen)
    if (!pos) return
    const at = { col: pos.col, row: pos.row, x: pos.x, y: pos.y, button: MOUSE_BUTTON_LEFT }
    trigger({ ...at, action: MOUSE_ACTION_DOWN })
    trigger({ ...at, action: MOUSE_ACTION_UP })
  }

  el.addEventListener('mousedown', onDown)
  // A click can release a pixel or two off the press cell, outside the terminal
  // element; listen on the document so it still resolves.
  el.ownerDocument.addEventListener('mouseup', onUp)
  return () => {
    el.removeEventListener('mousedown', onDown)
    el.ownerDocument.removeEventListener('mouseup', onUp)
  }
}

/**
 * Replace xterm's forced-selection rule (Shift+drag, or Option+drag on
 * macOS) with forceLocalSelection, inverting the default: plain drag selects
 * locally, Alt+drag is reported to tmux. xterm has no public hook for this
 * (only custom key and wheel handlers), so this reaches into the private
 * selection service — the single method both mouse gates (report-to-pty and
 * start-selection) consult on every mousedown. The dependency is pinned to
 * an exact version, and the unit tests canary the private names; if the
 * internals ever move this returns false and drags report to tmux again.
 *
 * Call after `term.open()` — the selection service doesn't exist before it.
 */
export function patchForcedSelection(term: Terminal): boolean {
  const svc = (term as TerminalInternals)._core?._selectionService
  if (!svc?.shouldForceSelection) return false
  svc.shouldForceSelection = forceLocalSelection
  return true
}

/**
 * Keep the mouse selection alive until the user replaces it with a new one
 * (or the buffer resizes/resets). Stock xterm clears it far more eagerly,
 * through two paths that both misfire under tmux:
 *
 *  1. An onUserInput listener the SelectionService registers in its
 *     constructor clears on every byte sent to the pty — and "user input"
 *     is not just keystrokes: when the pane TUI tracks mouse motion (mode
 *     1003, which tmux forwards to us), merely moving the mouse sends
 *     reports and wipes the selection. The listener's disposable is
 *     discarded and its emitter is shared with the write buffer, so it
 *     can't be unhooked; instead wrap coreService.triggerDataEvent — the
 *     one funnel all input (keys, mouse reports, paste) passes through —
 *     and drop clearSelection calls made synchronously inside it.
 *
 *  2. Every DECSET of a mouse protocol fires onProtocolChange — even a
 *     redundant re-assert of the current mode, which tmux and TUIs emit on
 *     redraw/focus churn — and its handler calls SelectionService.disable(),
 *     which clears. Wrap disable() to keep its bookkeeping but drop its
 *     clear the same way.
 *
 * Clears from mouse selection actions, vertical resize and reset() still
 * pass through.
 *
 * Call after `term.open()`. Returns false if the internals have moved
 * (selection then clears eagerly again, as stock).
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
