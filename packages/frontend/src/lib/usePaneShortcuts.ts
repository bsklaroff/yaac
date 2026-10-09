import { useEffect, useRef } from 'react'
import { layoutOf, shortcutsSuspended, useUiStore } from '#lib/store'
import { claimChord, cycleDeltaFor, matchShortcut, resolveCycleTarget } from '#lib/shortcuts'
import { moveColumn, moveTabInStrip } from '#lib/layout'
import { isSpecialPane } from '#lib/panes'
import { FILES_TARGET } from '#lib/files'

/** What the pane shortcuts act on: the open workspace's state this render. */
export interface PaneShortcutContext {
  sid: string | null
  targets: string[]
  activeTab: string | undefined
  /** Open the preview, or offer a choice of port; null when the workspace
   *  has no forwarded port. */
  openPreview: (() => void) | null
  isMobile: boolean
  openShell: () => void
  /** Close a special pane, which needs no confirmation. */
  closePane: (target: string) => void
  /** Ask before killing a terminal's tmux window. */
  askKill: (target: string) => void
}

/**
 * WorkspaceView's pane-scoped shortcuts (see SHORTCUTS in #lib/shortcuts);
 * Shell in App handles the project-scoped ones. Captured on window so a
 * chord is consumed before xterm could send it to the PTY.
 */
export function usePaneShortcuts(ctx: PaneShortcutContext): void {
  const latest = useRef(ctx)
  latest.current = ctx
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const c = latest.current
      if (!c.sid) return
      const state = useUiStore.getState()
      // A rebind being recorded, or the create dialog open.
      if (shortcutsSuspended(state)) return
      const id = matchShortcut(state.bindings, e)
      switch (id) {
        case 'new-shell':
          claimChord(e)
          c.openShell()
          return
        case 'kill-terminal':
          // The agent pane can't be killed.
          if (!c.activeTab || c.activeTab === 'agent') return
          claimChord(e)
          if (isSpecialPane(c.activeTab)) c.closePane(c.activeTab)
          else c.askKill(c.activeTab)
          return
        case 'open-files':
          // Open the explorer with its filter focused, for quick-open.
          claimChord(e)
          state.openFiles(c.sid)
          state.setFindPending(FILES_TARGET)
          return
        case 'open-changes':
          claimChord(e)
          state.openChanges(c.sid)
          return
        case 'open-preview':
          if (!c.openPreview) return
          claimChord(e)
          c.openPreview()
          return
        case 'view-tabs':
        case 'view-tiles':
          // On mobile the chord would do nothing visible but still overwrite
          // the saved desktop preference.
          if (c.isMobile) return
          claimChord(e)
          state.setViewMode(id === 'view-tabs' ? 'tabs' : 'tiles')
          return
        case 'move-terminal-left':
        case 'move-terminal-right': {
          // Move the active pane's column (tiles) or tab (tabs), then keep it
          // focused.
          if (!c.activeTab) return
          claimChord(e)
          const dir = id === 'move-terminal-right' ? 1 : -1
          const cur = layoutOf(state.layouts, c.sid)
          const moved = state.viewMode === 'tiles'
            ? moveColumn(cur, c.activeTab, dir)
            : moveTabInStrip(cur, c.activeTab, dir)
          if (moved === cur) return
          state.setWorkspaceLayout(c.sid, moved)
          state.focusTerminal(c.sid, c.activeTab)
          return
        }
        case 'prev-terminal':
        case 'next-terminal': {
          const delta = cycleDeltaFor(id)
          if (delta === null) return
          const next = resolveCycleTarget(c.targets, c.activeTab, delta)
          if (!next) return
          claimChord(e)
          state.focusTerminal(c.sid, next)
          return
        }
        default:
          return
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [])
}
