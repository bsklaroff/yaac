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
