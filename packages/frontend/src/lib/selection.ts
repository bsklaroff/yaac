import type { Terminal } from '@xterm/xterm'
import { MOUSE_ACTION_DOWN, MOUSE_ACTION_UP, MOUSE_BUTTON_LEFT, xtermCore } from './xterm-internals'

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
 * path its built-in reporting takes. Returns a disposer. Call after
 * `term.open()`.
 */
export function patchClickForwarding(term: Terminal): () => void {
  const { element: el, screenElement: screen, _mouseService: mouse, coreMouseService: coreMouse } = xtermCore(term)

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
    const pos = mouse.getMouseReportCoords(down, screen)
    if (!pos) return
    const at = { ...pos, button: MOUSE_BUTTON_LEFT }
    coreMouse.triggerMouseEvent({ ...at, action: MOUSE_ACTION_DOWN })
    coreMouse.triggerMouseEvent({ ...at, action: MOUSE_ACTION_UP })
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
 * macOS): a plain drag selects locally, so copy works without a modifier,
 * and Alt+drag (Option on macOS) is reported to the app, for TUIs that want
 * the mouse. Call after `term.open()`.
 */
export function patchForcedSelection(term: Terminal): void {
  xtermCore(term)._selectionService.shouldForceSelection = (e) => !e.altKey
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
 * Call after `term.open()`.
 */
export function patchKeepSelection(term: Terminal): void {
  const { _selectionService: svc, coreService } = xtermCore(term)
  const clear = svc.clearSelection.bind(svc)
  const disable = svc.disable.bind(svc)
  const trigger = coreService.triggerDataEvent.bind(coreService)
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
}
