import { useEffect, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Menu } from '@base-ui/react/menu'
import { layoutOf, shortcutsSuspended, useUiStore } from '#lib/store'
import { WorkspaceTerminal } from '#components/WorkspaceTerminal'
import { WorkspacePreview } from '#components/WorkspacePreview'
import { WorkspaceChanges } from '#components/WorkspaceChanges'
import { WorkspaceChat } from '#components/WorkspaceChat'
import { WorkspaceFiles } from '#components/WorkspaceFiles'
import { WorkspaceFile } from '#components/WorkspaceFile'
import { isPreviewTarget, previewLabel } from '#lib/preview'
import { isChangesTarget } from '#lib/changesApi'
import {
  discardFileSavers, fileKey, fileTabLabels, fileTargetPath, flushFileSavers, isFileTarget, isFilesTarget,
} from '#lib/files'
import { acpTargetSession, isAcpTarget } from '@yaac/shared/acp'
import { defaultPaneTarget, isSpecialPane, paneStillLive, syncPaneLayout } from '#lib/panes'
import { agentLabel } from '#lib/agentLabel'
import { isElectron } from '#lib/platform'
import { goBackScreen } from '#lib/mobileHistory'
import { useIsMobile } from '#lib/viewport'
import { WorkspaceTitle } from '#components/WorkspaceTitle'
import { CreatingPlaceholder } from '#components/CreatingPlaceholder'
import { TerminalKeyBar } from '#components/TerminalKeyBar'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import {
  AddIcon, ChangesIcon, CloseIcon, FilesIcon, MoreIcon, NavBackIcon, PreviewIcon, SidebarIcon, TabsIcon,
  TerminalIcon, TilesIcon, TOOL_LABEL,
} from '#lib/icons'
import { EmptyState } from '#components/ui/EmptyState'
import { NewWorkspaceButton } from '#components/NewWorkspaceButton'
import { BlockedHostsBadge } from '#components/BlockedHostsBadge'
import { UnforwardedPortsBadge } from '#components/UnforwardedPortsBadge'
import { GitAuthFailureBadge } from '#components/GitAuthFailureBadge'
import { GitStatusBar } from '#components/GitStatusBar'
import { ForwardedPortLinks, portLinkHref, portLinkLabel } from '#components/ForwardedPortLinks'
import { getWorkspaceTerminals, createShellTerminal, killWorkspaceTerminal } from '#lib/terminalsApi'
import { claimChord, cycleDeltaFor, matchShortcut, resolveCycleTarget } from '#lib/shortcuts'
import {
  addColumn,
  computeColumns,
  dropTargetAt,
  focusPaneTarget,
  moveColumn,
  moveTabInStrip,
  moveTargetToColumn,
  moveTargetToGroup,
  paneTargets,
  removeTarget,
  type ColumnRect,
  type DropTarget,
  type PaneLayout,
} from '#lib/layout'
import type {
  ProvisioningWorkspaceEntry,
  ServerSnapshot,
  WorkspaceTerminalEntry,
  WorkspaceListEntry,
} from '@yaac/shared/types'

/** Gap between column cards. */
const GAP = 8
/** Pane card header (tab strip) height. */
const HEADER_H = 28
/** The same strip on mobile, tall enough for a finger. */
const MOBILE_HEADER_H = 38
/** Pane card inner padding around the terminal block. */
const PAD = 3
/** Pointer must travel this far before a tab-drag becomes a move. */
const DRAG_THRESHOLD = 5
/** Most workspaces attached in the background after a page load. Each costs
 *  a server-side PTY, so a large install shouldn't open dozens at once;
 *  the rest attach when first viewed. */
const EAGER_ATTACH_MAX = 12
/** The same limit on a phone, where each live stream costs mobile data. */
const MOBILE_EAGER_ATTACH_MAX = 2

interface DragState {
  src: string
  startX: number
  startY: number
  active: boolean
  over?: DropTarget
}

/**
 * A pane's tab label. An agent pane is named for its tool and model
 * ("Claude · Opus 5"): `agent` is the primary tui window (lowest ordinal),
 * and `acp:<id>` names its conversation. A file pane uses `fileLabels`
 * (see `fileTabLabels`), else its path. `workspace` is omitted only by
 * callers that name terminals.
 */
function paneName(
  target: string,
  terminals: WorkspaceTerminalEntry[] | undefined,
  previewPort?: number,
  workspace?: WorkspaceListEntry,
  fileLabels?: Record<string, string>,
): string {
  if (isPreviewTarget(target)) return previewLabel(previewPort)
  if (isChangesTarget(target)) return 'Changes'
  if (isFilesTarget(target)) return 'Files'
  if (isFileTarget(target)) return fileLabels?.[fileTargetPath(target)] ?? fileTargetPath(target)
  if (target === 'agent' || isAcpTarget(target)) {
    const sessions = workspace?.agentSessions ?? []
    const session = isAcpTarget(target)
      ? sessions.find((a) => a.agentSessionId === acpTargetSession(target))
      : [...sessions].sort((a, b) => a.ordinal - b.ordinal).find((a) => a.mode !== 'acp')
    return workspace === undefined ? 'Agent' : agentLabel(workspace.tool, session)
  }
  const entry = terminals?.find((t) => t.target === target)
  return entry?.name ?? 'window'
}

export function WorkspaceView({
  snapshot,
  provisioning,
}: {
  snapshot: ServerSnapshot | undefined
  provisioning: ProvisioningWorkspaceEntry[]
}): JSX.Element {
  const selectedWorkspaceId = useUiStore((s) => s.selectedWorkspaceId)
  const focusNonce = useUiStore((s) => s.focusNonce)
  const terminalNonces = useUiStore((s) => s.terminalNonces)
  const layouts = useUiStore((s) => s.layouts)
  const setWorkspaceLayout = useUiStore((s) => s.setWorkspaceLayout)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const sidebarOpen = useUiStore((s) => s.sidebarOpen)
  const activeProjectSlug = useUiStore((s) => s.activeProjectSlug)
  const viewMode = useUiStore((s) => s.viewMode)
  const setViewMode = useUiStore((s) => s.setViewMode)
  const activeTabs = useUiStore((s) => s.activeTabs)
  const focusTerminal = useUiStore((s) => s.focusTerminal)
  const previewPortMap = useUiStore((s) => s.previewPort)
  const setPreviewPort = useUiStore((s) => s.setPreviewPort)
  const openPreview = useUiStore((s) => s.openPreview)
  const openChanges = useUiStore((s) => s.openChanges)
  const openFiles = useUiStore((s) => s.openFiles)
  const dirtyFiles = useUiStore((s) => s.dirtyFiles)
  // On a phone this pane is its own screen, with a back button, an overflow
  // menu and no tiles mode (docs/mobile-layout.md).
  const isMobile = useIsMobile()
  // A number, not a class: pane rects are computed below the tab strip.
  const headerH = isMobile ? MOBILE_HEADER_H : HEADER_H
  const queryClient = useQueryClient()
  const workspaces = snapshot?.workspaces ?? []
  const workspace = workspaces.find((s) => s.workspaceId === selectedWorkspaceId)
  const sid = workspace?.workspaceId ?? null
  // Project-wide, but shown here since it breaks git in this workspace too.
  const gitAuthFailures = (workspace && snapshot?.gitAuthFailures?.[workspace.projectSlug]) || []

  // Forwarded ports open in the embedded preview in the desktop app, and as
  // external-link chips in a browser.
  const embedPreview = isElectron()
  const previewPorts = workspace?.forwardedPorts ?? []
  const chipPorts = embedPreview ? [] : previewPorts
  const previewPortForWorkspace = sid ? previewPortMap[sid] : undefined

  // Show the provisioning placeholder only when its row is selected and the
  // workspace isn't listed yet.
  const creatingHere = workspace ? null : provisioning.find((p) => p.workspaceId === selectedWorkspaceId) ?? null

  const layout: PaneLayout = sid ? layoutOf(layouts, sid, defaultPaneTarget(workspace)) : []

  // The workspace's non-agent terminals, which decide which panes exist and
  // their names.
  const { data: terminals } = useQuery({
    queryKey: ['terminals', sid],
    queryFn: () => getWorkspaceTerminals(sid ?? ''),
    enabled: !!workspace,
    refetchInterval: 10_000,
    staleTime: 5_000,
  })

  // Pane area size; columns are absolutely positioned from it.
  const wsRef = useRef<HTMLDivElement>(null)
  const [wsSize, setWsSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = wsRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setWsSize({ w: el.clientWidth, h: el.clientHeight })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Keep the layout's panes in line with the workspace's windows and
  // conversations.
  useEffect(() => {
    if (!sid || !workspace || !terminals) return
    const next = syncPaneLayout(layout, workspace, terminals.map((t) => t.target))
    if (next !== layout) setWorkspaceLayout(sid, next)
  }, [sid, workspace, terminals, layout, setWorkspaceLayout])

  // Tabs mode shows all panes as one tab strip; the column layout is kept so
  // switching back to tiles restores it.
  const targets = paneTargets(layout)
  const activeTab = sid
    ? (activeTabs[sid] && targets.includes(activeTabs[sid]) ? activeTabs[sid] : targets[0])
    : undefined
  // Tiles is turned off on mobile at render only, so a phone doesn't
  // overwrite the desktop preference in the store.
  const tiled = viewMode === 'tiles' && !isMobile
  // Only this pane gets a focusKey, so bumping focusNonce focuses it and no
  // hidden pane.
  const focusTarget = sid ? focusPaneTarget(targets, activeTabs[sid], tiled) : null
  // Equal-width columns, each showing its active tab; other tabs stay
  // mounted but hidden.
  const cols = computeColumns(layout, { x: 0, y: 0, w: wsSize.w, h: wsSize.h }, GAP)
  const colsRef = useRef<ColumnRect[]>(cols)
  colsRef.current = cols
  // Each column's visible pane rect, for positioning and the drop highlight.
  const activePaneRect = new Map(cols.map((c) => [c.group.active, c.rect]))

  // Keep-alive: every pane ever shown stays mounted (hidden) so switching
  // back is instant. Explicitly closed panes are dropped.
  const [opened, setOpened] = useState<string[]>([])
  useEffect(() => {
    if (!sid) return
    const keys = paneTargets(layout).map((t) => `${sid}|${t}`)
    setOpened((prev) => {
      const fresh = keys.filter((k) => !prev.includes(k))
      return fresh.length ? [...prev, ...fresh] : prev
    })
  }, [sid, layout])

  /** The workspace a `<id>|<target>` key belongs to, if this snapshot has it. */
  const keyWorkspace = (key: string): WorkspaceListEntry | undefined =>
    workspaces.find((s) => s.workspaceId === key.slice(0, key.indexOf('|')))
  const keyTarget = (key: string): string => key.slice(key.indexOf('|') + 1)

  // Permanently drop a pane its workspace no longer has. Filtering `mounted`
  // alone isn't enough: an ACP workspace's early `agent` key would come back
  // while the workspace stops (it then reports no conversations) and attach
  // a PTY to a workspace being torn down. Workspaces missing from this
  // snapshot are left alone.
  useEffect(() => {
    setOpened((prev) => {
      const next = prev.filter((key) => {
        const wt = keyWorkspace(key)
        return wt === undefined || paneStillLive(wt, keyTarget(key))
      })
      return next.length === prev.length ? prev : next
    })
  }, [workspaces])

  // Likewise drop a file pane that left its layout (renamed or deleted).
  useEffect(() => {
    setOpened((prev) => {
      const next = prev.filter((key) => {
        const target = keyTarget(key)
        if (!isFileTarget(target)) return true
        const id = key.slice(0, key.indexOf('|'))
        return paneTargets(layoutOf(layouts, id)).includes(target)
      })
      return next.length === prev.length ? prev : next
    })
  }, [layouts])

  // The panes to render now; the prune effects above make removals permanent.
  const mounted = opened.filter((key) => {
    const wt = keyWorkspace(key)
    return wt !== undefined && paneStillLive(wt, keyTarget(key))
  })

  // Last shown rect per mounted pane. Hidden panes keep it, so showing them
  // again needs no resize.
  const lastRects = useRef(new Map<string, { left: number; top: number; width: number; height: number }>())
  for (const k of [...lastRects.current.keys()]) {
    if (!mounted.includes(k)) lastRects.current.delete(k)
  }

  // Eager attach: after a page load, mount each live workspace's default
  // pane (`defaultPaneTarget`) hidden, so it attaches in the background and
  // the first click shows it instantly. Only the default pane, since it
  // exists for every workspace and persisted window ids may be stale. Its
  // rect is set to the tabs-mode rect so it attaches at the size it will be
  // shown at. Limited by EAGER_ATTACH_MAX.
  const eagerKeys = workspaces
    .filter((s) => !s.stopping)
    .slice(0, isMobile ? MOBILE_EAGER_ATTACH_MAX : EAGER_ATTACH_MAX)
    .map((s) => `${s.workspaceId}|${defaultPaneTarget(s)}`)
    .join(',')
  useEffect(() => {
    if (wsSize.w <= 0 || wsSize.h <= 0 || eagerKeys === '') return
    const keys = eagerKeys.split(',')
    const rect = {
      left: PAD,
      top: headerH,
      width: wsSize.w - PAD * 2,
      height: wsSize.h - headerH - PAD,
    }
    for (const k of keys) {
      if (!lastRects.current.has(k)) lastRects.current.set(k, rect)
    }
    setOpened((prev) => {
      const fresh = keys.filter((k) => !prev.includes(k))
      return fresh.length ? [...prev, ...fresh] : prev
    })
  }, [eagerKeys, wsSize.w, wsSize.h, headerH])

  const refetchTerminals = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['terminals', sid] })
  }

  /** Create a scratch-shell window and open it as a new column, without
   *  waiting for the next terminals poll. */
  const openShell = (): void => {
    if (!sid) return
    void createShellTerminal(sid)
      .then((entry) => {
        queryClient.setQueryData<WorkspaceTerminalEntry[]>(
          ['terminals', sid],
          (old) => old ? [...old.filter((t) => t.target !== entry.target), entry] : [entry],
        )
        const state = useUiStore.getState()
        state.setWorkspaceLayout(sid, addColumn(layoutOf(state.layouts, sid), entry.target))
        state.focusTerminal(sid, entry.target)
      })
      .catch((e: unknown) => console.error('new shell failed', e))
  }

  // The pane's × or the kill shortcut asks before killing a tmux window.
  const [confirmKill, setConfirmKill] = useState<{ target: string; name: string } | null>(null)
  // A file pane whose unsaved text could not be saved on close.
  const [confirmDiscard, setConfirmDiscard] = useState<{ target: string; name: string } | null>(null)

  // Pane-scoped shortcuts (see SHORTCUTS in #lib/shortcuts); Shell handles
  // the project-scoped ones. Captured on window so a chord is consumed
  // before xterm could send it to the PTY. The ref gives the listener the
  // current render's state.
  const shortcutCtx = useRef({ sid, targets, activeTab, terminals, openShell, previewPorts, isMobile })
  shortcutCtx.current = { sid, targets, activeTab, terminals, openShell, previewPorts, isMobile }
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const ctx = shortcutCtx.current
      if (!ctx.sid) return
      const state = useUiStore.getState()
      // A rebind being recorded, or the create dialog open.
      if (shortcutsSuspended(state)) return
      const id = matchShortcut(state.bindings, e)
      switch (id) {
        case 'new-shell':
          claimChord(e)
          ctx.openShell()
          return
        case 'kill-terminal': {
          // The agent pane can't be killed.
          if (!ctx.activeTab || ctx.activeTab === 'agent') return
          claimChord(e)
          // A special pane just closes, without confirmation.
          if (isSpecialPane(ctx.activeTab)) {
            closePaneRef.current(ctx.activeTab)
            return
          }
          setConfirmKill({ target: ctx.activeTab, name: paneName(ctx.activeTab, ctx.terminals) })
          return
        }
        case 'open-files':
          // Open the explorer with its filter focused, for quick-open.
          claimChord(e)
          state.openFiles(ctx.sid)
          state.setFilesFindPending(true)
          return
        case 'open-changes':
          claimChord(e)
          state.openChanges(ctx.sid)
          return
        case 'open-preview':
          // Nothing to preview without a forwarded port.
          if (ctx.previewPorts.length === 0) return
          claimChord(e)
          state.openPreview(ctx.sid)
          return
        case 'view-tabs':
        case 'view-tiles':
          // On mobile the chord would do nothing visible but still overwrite
          // the saved desktop preference.
          if (ctx.isMobile) return
          claimChord(e)
          state.setViewMode(id === 'view-tabs' ? 'tabs' : 'tiles')
          return
        case 'move-terminal-left':
        case 'move-terminal-right': {
          // Move the active pane's column (tiles) or tab (tabs), then keep it
          // focused.
          if (!ctx.activeTab) return
          claimChord(e)
          const dir = id === 'move-terminal-right' ? 1 : -1
          const cur = layoutOf(state.layouts, ctx.sid)
          const moved = state.viewMode === 'tiles'
            ? moveColumn(cur, ctx.activeTab, dir)
            : moveTabInStrip(cur, ctx.activeTab, dir)
          if (moved === cur) return
          state.setWorkspaceLayout(ctx.sid, moved)
          state.focusTerminal(ctx.sid, ctx.activeTab)
          return
        }
        case 'prev-terminal':
        case 'next-terminal': {
          const delta = cycleDeltaFor(id)
          if (delta === null) return
          const next = resolveCycleTarget(ctx.targets, ctx.activeTab, delta)
          if (!next) return
          claimChord(e)
          useUiStore.getState().focusTerminal(ctx.sid, next)
          return
        }
        default:
          return
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [])

  const killPane = (target: string): void => {
    if (!sid) return
    // Remove the cached window too, so the layout sync doesn't re-add it
    // mid-kill. If the kill fails, the next poll brings the pane back.
    queryClient.setQueryData<WorkspaceTerminalEntry[]>(
      ['terminals', sid],
      (old) => old?.filter((t) => t.target !== target),
    )
    setWorkspaceLayout(sid, removeTarget(layout, target))
    setOpened((prev) => prev.filter((k) => k !== `${sid}|${target}`))
    void killWorkspaceTerminal(sid, target)
      .catch((e: unknown) => console.error('kill terminal failed', e))
      .finally(refetchTerminals)
  }

  // Close a special pane without confirmation. A file pane saves first and
  // asks only if the save fails.
  const dropPane = (id: string, target: string): void => {
    if (isFileTarget(target)) discardFileSavers([fileKey(id, fileTargetPath(target))])
    const st = useUiStore.getState()
    st.setWorkspaceLayout(id, removeTarget(layoutOf(st.layouts, id), target))
    setOpened((prev) => prev.filter((k) => k !== `${id}|${target}`))
  }
  const closePane = (target: string): void => {
    if (!sid) return
    if (!isFileTarget(target)) {
      dropPane(sid, target)
      return
    }
    const id = sid
    void flushFileSavers([fileKey(id, fileTargetPath(target))]).then((landed) => {
      if (landed) dropPane(id, target)
      else setConfirmDiscard({ target, name: fileTargetPath(target) })
    })
  }
  const closePaneRef = useRef(closePane)
  closePaneRef.current = closePane

  // --- tab drag (rearrange columns / merge into tabs) ---
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  dragRef.current = drag

  // A tab is a drag handle and a click target: a press that stays within
  // DRAG_THRESHOLD selects it; a drag moves the pane (see dropTargetAt).
  const onTabDown = (e: ReactPointerEvent, src: string, onSelect: () => void): void => {
    e.preventDefault()
    if (!sid) return
    const ws = wsRef.current
    if (!ws) return
    const wsRect = ws.getBoundingClientRect()
    // Set the ref too; the move handler may fire before the next render.
    const init: DragState = { src, startX: e.clientX, startY: e.clientY, active: false }
    dragRef.current = init
    setDrag(init)

    const onMove = (ev: globalThis.PointerEvent): void => {
      const d = dragRef.current
      if (!d) return
      const dist = Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY)
      const active = d.active || dist > DRAG_THRESHOLD
      if (!active) return
      const px = ev.clientX - wsRect.left
      const over = dropTargetAt(colsRef.current, px)
      const next: DragState = { ...d, active, over }
      dragRef.current = next
      setDrag(next)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const d = dragRef.current
      setDrag(null)
      if (!d) return
      if (!d.active) { onSelect(); return }
      if (!d.over) return
      const cur = useUiStore.getState()
      const node = layoutOf(cur.layouts, sid)
      const moved = d.over.kind === 'tab'
        ? moveTargetToGroup(node, d.src, d.over.group)
        : moveTargetToColumn(node, d.src, d.over.index)
      cur.setWorkspaceLayout(sid, moved)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // While dragging: a box over the target column, or a bar where a new
  // column would open.
  const dropHighlight: { rect: { x: number; y: number; w: number; h: number }; bar: boolean } | null =
    drag?.active && drag.over
      ? (() => {
          const over = drag.over
          if (over.kind === 'tab') {
            const col = cols[over.group]
            return col ? { rect: col.rect, bar: false } : null
          }
          const i = over.index
          const barW = 3
          let cx: number
          if (cols.length === 0) cx = wsSize.w / 2
          else if (i <= 0) cx = cols[0].rect.x - GAP / 2
          else if (i >= cols.length) {
            const last = cols[cols.length - 1].rect
            cx = last.x + last.w + GAP / 2
          } else cx = cols[i].rect.x - GAP / 2
          return { rect: { x: cx - barW / 2, y: 0, w: barW, h: wsSize.h }, bar: true }
        })()
      : null

  const fileLabels = fileTabLabels(targets.filter(isFileTarget).map(fileTargetPath))
  const tabName = (t: string): string => paneName(t, terminals, previewPortForWorkspace, workspace, fileLabels)

  /** A tab in a column strip (tiles) or the single tab bar (tabs). */
  const renderTab = (
    t: string,
    opts: { isActive: boolean; onSelect: () => void; draggable: boolean },
  ): JSX.Element => {
    const dirty = sid !== null && isFileTarget(t) && dirtyFiles[fileKey(sid, fileTargetPath(t))] === true
    return (
      <span key={t} className="group/tab relative flex items-center">
        <button
          onPointerDown={opts.draggable ? (e) => onTabDown(e, t, opts.onSelect) : undefined}
          onClick={opts.draggable ? undefined : opts.onSelect}
          className={clsx(
            'rounded px-2 py-0.5 text-[11px] transition',
            // Finger-sized on mobile, where this strip is the only pane switcher.
            'max-md:h-8 max-md:rounded-md max-md:px-3 max-md:text-xs',
            opts.draggable && 'cursor-grab select-none active:cursor-grabbing',
            t !== 'agent' && 'pr-5 max-md:pr-7',
            drag?.active && drag.src === t && 'opacity-60',
            opts.isActive
              ? 'bg-surface-3 font-medium text-text'
              : 'text-text-faint hover:text-text-dim',
          )}
        >
          {tabName(t)}
        </button>
        {isSpecialPane(t) ? (
          // A file with unsaved text shows a dot in place of the × until hovered.
          <button
            onClick={() => closePane(t)}
            title={dirty ? 'Unsaved changes — close' : 'Close pane'}
            aria-label={`Close ${tabName(t)}`}
            className={clsx('absolute right-0.5 flex h-4 w-4 items-center justify-center rounded',
              'text-text-faint transition hover:text-text group-hover/tab:opacity-100',
              'max-md:h-6 max-md:w-6 max-md:opacity-100', !dirty && 'opacity-0')}
          >
            {dirty && <span className="text-[9px] group-hover/tab:hidden">●</span>}
            <CloseIcon size={10} className={clsx(dirty && 'hidden group-hover/tab:block')} />
          </button>
        ) : t !== 'agent' && (
          <button
            onClick={() => setConfirmKill({ target: t, name: paneName(t, terminals) })}
            title={`Kill ${paneName(t, terminals)}`}
            aria-label={`Kill ${paneName(t, terminals)}`}
            className="absolute right-0.5 flex h-4 w-4 items-center justify-center rounded
              text-text-faint opacity-0 transition hover:text-text group-hover/tab:opacity-100
              max-md:h-6 max-md:w-6 max-md:opacity-100"
          >
            <CloseIcon size={10} />
          </button>
        )}
      </span>
    )
  }

  /** The header's leading button: back to the workspace list on mobile, or
   *  the show-sidebar toggle on desktop while the sidebar is hidden. */
  const leading: ReactNode = isMobile ? (
    <button
      onClick={goBackScreen}
      title="Back to workspaces"
      aria-label="Back to workspaces"
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-dim
        transition active:bg-surface-2"
    >
      <NavBackIcon size={18} />
    </button>
  ) : !sidebarOpen ? (
    <button
      onClick={toggleSidebar}
      title="Show sidebar"
      aria-label="Show sidebar"
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-faint transition
        hover:bg-surface-2 hover:text-text-dim"
    >
      <SidebarIcon size={14} />
    </button>
  ) : null

  // On mobile the warning badges (git auth, blocked hosts, unforwarded ports)
  // stay in the bar and other controls move to an overflow menu.
  const headerClass = isMobile
    ? 'flex h-12 shrink-0 items-center gap-1 border-b border-hairline pl-1 pr-1.5 text-xs'
    : 'flex h-8 shrink-0 items-center gap-2.5 px-2 text-xs'

  // The mobile key bar, only over a terminal pane.
  const keyBarTarget = isMobile && workspace && activeTab && !isSpecialPane(activeTab) ? activeTab : null

  return (
    <main className="flex h-full min-w-0 flex-col">
      {/* The workspace bar. */}
      {creatingHere ? (
        <header className={headerClass}>
          {leading}
          <span className="titlebar-drag min-w-0 flex-1 truncate font-medium text-text-dim">
            {creatingHere.kind === 'restart' ? 'Restarting workspace' : 'New workspace'}
          </span>
        </header>
      ) : workspace ? (
        <header className={headerClass}>
          {leading}
          <WorkspaceTitle
            workspaceId={workspace.workspaceId}
            title={workspace.title ?? ''}
            prompt={workspace.prompt ?? ''}
          />
          {!isMobile && (
            <button
              onClick={() => setViewMode(tiled ? 'tabs' : 'tiles')}
              title={tiled ? 'Switch to tabs' : 'Switch to tiles'}
              className="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px]
                text-text-dim transition hover:bg-surface-2 hover:text-text"
            >
              {tiled ? <TabsIcon size={13} /> : <TilesIcon size={13} />}
              <span className="max-lg:sr-only">{tiled ? 'Tab view' : 'Tile view'}</span>
            </button>
          )}
          {!isMobile && (
            <>
              <button
                onClick={openShell}
                title="New shell"
                className="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px]
                  text-text-dim transition hover:bg-surface-2 hover:text-text"
              >
                <AddIcon size={13} />
                <span className="max-lg:sr-only">New Shell</span>
              </button>
              <button
                onClick={() => openChanges(workspace.workspaceId)}
                title="Review changes"
                aria-label="Review changes"
                className="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px]
                  text-text-dim transition hover:bg-surface-2 hover:text-text"
              >
                <ChangesIcon size={13} />
                Changes
              </button>
              <button
                onClick={() => openFiles(workspace.workspaceId)}
                title="Browse files"
                aria-label="Browse files"
                className="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px]
                  text-text-dim transition hover:bg-surface-2 hover:text-text"
              >
                <FilesIcon size={13} />
                Files
              </button>
              {embedPreview && previewPorts.length > 0 && (
                <button
                  onClick={() => openPreview(workspace.workspaceId, previewPorts[0].containerPort)}
                  title={`Open preview (${previewPorts.map(portLinkLabel).join(', ')})`}
                  aria-label="Open preview"
                  className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[11px]
                    text-text-dim transition hover:bg-surface-2 hover:text-text"
                >
                  <PreviewIcon size={11} />
                  Preview
                </button>
              )}
              {chipPorts.length > 0 && (
                <ForwardedPortLinks ports={chipPorts} iconSize={11} className="hover:bg-surface-2" />
              )}
            </>
          )}
          {workspace.unforwardedPorts.length > 0 && (
            <UnforwardedPortsBadge
              ports={workspace.unforwardedPorts}
              workspaceId={workspace.workspaceId}
              exposeHost={snapshot?.forwardBindHost ?? '127.0.0.1'}
              iconSize={11}
              className="hover:bg-surface-3"
            />
          )}
          {gitAuthFailures.length > 0 && (
            <GitAuthFailureBadge
              projectSlug={workspace.projectSlug}
              failures={gitAuthFailures}
              iconSize={12}
              className="hover:bg-[#d65858]/25"
            />
          )}
          {workspace.blockedHosts.length > 0 && (
            <BlockedHostsBadge hosts={workspace.blockedHosts} workspaceId={workspace.workspaceId} iconSize={12} className="hover:bg-[#d65858]/25" />
          )}
          {isMobile && (
            <PaneOverflowMenu
              tool={workspace.tool}
              chipPorts={chipPorts}
              previewPorts={embedPreview ? previewPorts : []}
              onNewShell={openShell}
              onOpenChanges={() => openChanges(workspace.workspaceId)}
              onOpenFiles={() => openFiles(workspace.workspaceId)}
              onOpenPreview={(p) => openPreview(workspace.workspaceId, p)}
            />
          )}
        </header>
      ) : (
        <header className={clsx(headerClass, 'titlebar-drag')}>
          {leading && <div className="no-drag">{leading}</div>}
        </header>
      )}

      {workspace && <GitStatusBar key={workspace.workspaceId} workspaceId={workspace.workspaceId} />}

      {/* `isolate` keeps the z-30 provisioning overlay below from painting
          over portaled dropdowns such as "+ New workspace". */}
      <div ref={wsRef} className="relative isolate min-h-0 flex-1">
        {!workspace && !creatingHere && (
          <EmptyState
            className="h-full"
            icon={TerminalIcon}
            title="No workspaces yet"
            description="Start a coding-agent workspace and it opens right here."
            action={activeProjectSlug
              ? <NewWorkspaceButton projectSlug={activeProjectSlug} variant="cta" />
              : undefined}
          />
        )}

        {/* Tiles mode: one card per column, with its tab strip. The panes
            below are positioned into the card bodies. */}
        {workspace && tiled && cols.map(({ group, rect }, gi) => (
          <section
            key={gi}
            style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
            className="absolute flex flex-col overflow-hidden rounded-lg border border-hairline
              bg-surface shadow-[0_8px_24px_var(--shadow-color)]"
          >
            <div style={{ height: headerH }} className="flex shrink-0 items-center gap-0.5 px-1.5">
              {group.tabs.map((t) => renderTab(t, {
                isActive: group.active === t,
                onSelect: () => focusTerminal(workspace.workspaceId, t),
                draggable: true,
              }))}
            </div>
          </section>
        ))}

        {/* Tabs mode: one card whose strip lists every pane. */}
        {workspace && !tiled && targets.length > 0 && (
          // Full-bleed on mobile, without rounding, border or shadow.
          <section className="absolute inset-0 flex flex-col overflow-hidden rounded-lg border
            border-hairline bg-surface shadow-[0_8px_24px_var(--shadow-color)]
            max-md:rounded-none max-md:border-0 max-md:shadow-none">
            <div
              style={{ height: headerH }}
              className="flex shrink-0 items-center gap-0.5 overflow-x-auto px-1.5"
            >
              {targets.map((t) => renderTab(t, {
                isActive: activeTab === t,
                onSelect: () => focusTerminal(workspace.workspaceId, t),
                draggable: false,
              }))}
            </div>
          </section>
        )}

        {/* Mounted panes, positioned into their pane bodies. */}
        {mounted.map((key) => {
          const sep = key.indexOf('|')
          const id = key.slice(0, sep)
          const target = key.slice(sep + 1)
          const preview = isPreviewTarget(target)
          const changes = isChangesTarget(target)
          const explorer = isFilesTarget(target)
          const file = isFileTarget(target)
          const chat = acpTargetSession(target)
          // Panes unmounted when off-screen, since they poll the workspace.
          // Chat panes stay mounted (re-attaching replays the conversation),
          // and so do file panes (unmounting loses undo history, cursor and
          // unsaved text).
          const ephemeral = preview || changes || explorer
          // In tiles mode, a column's active tab is on-screen in its body.
          const colRect = id === sid && tiled ? activePaneRect.get(target) : undefined
          // Hidden panes never change size, since a resize round-trips to
          // tmux and would flash a stale frame when shown. In tabs mode all
          // of the selected workspace's tabs share one rect; other hidden
          // panes keep the last rect they were shown at.
          const tabsRect = {
            left: PAD,
            top: headerH,
            width: wsSize.w - PAD * 2,
            height: wsSize.h - headerH - PAD,
          }
          const onScreen = colRect != null || (id === sid && !tiled && target === activeTab)
          const style = colRect
            ? {
                left: colRect.x + PAD,
                top: colRect.y + headerH,
                width: colRect.w - PAD * 2,
                height: colRect.h - headerH - PAD,
              }
            : id === sid && !tiled && (ephemeral ? target === activeTab : targets.includes(target))
              ? tabsRect
              : ephemeral
                ? undefined
                : lastRects.current.get(key)
          if (!ephemeral && style) lastRects.current.set(key, style)
          // Ephemeral panes only have a `style` for the selected workspace,
          // so previewPorts and previewPortForWorkspace apply to them.
          if (ephemeral && !style) return null
          return (
            <div
              key={key}
              style={style}
              // Track focus from clicks too, so the cycle shortcut starts
              // from the pane the user is in.
              onFocusCapture={() => useUiStore.getState().setActiveTab(id, target)}
              className={clsx('absolute', !onScreen && 'invisible', !style && 'left-0 top-0 h-full w-full')}
            >
              {preview ? (
                <div className="h-full w-full overflow-hidden rounded-md">
                  <WorkspacePreview
                    workspaceId={id}
                    ports={previewPorts}
                    currentPort={previewPortForWorkspace}
                    onSwitchPort={(p) => setPreviewPort(id, p)}
                  />
                </div>
              ) : chat !== undefined ? (
                <div className="h-full w-full overflow-hidden rounded-md">
                  <WorkspaceChat workspaceId={id} agentSessionId={chat} visible={onScreen} />
                </div>
              ) : file ? (
                <div className="h-full w-full overflow-hidden rounded-md">
                  <WorkspaceFile
                    workspaceId={id}
                    path={fileTargetPath(target)}
                    visible={onScreen}
                    onClose={() => dropPane(id, target)}
                  />
                </div>
              ) : explorer ? (
                <div className="h-full w-full overflow-hidden rounded-md">
                  <WorkspaceFiles workspaceId={id} />
                </div>
              ) : changes ? (
                <div className="h-full w-full overflow-hidden rounded-md">
                  {(() => {
                    const cs = workspaces.find((s) => s.workspaceId === id)
                    return (
                      <WorkspaceChanges
                        workspaceId={id}
                        projectSlug={cs?.projectSlug ?? ''}
                        baseBranch={cs?.baseBranch}
                        focusKey={id === sid && target === focusTarget ? focusNonce : undefined}
                      />
                    )
                  })()}
                </div>
              ) : (
                <div className="h-full w-full overflow-hidden rounded-md bg-bg px-2.5 py-1.5">
                  <WorkspaceTerminal
                    key={`${key}:${terminalNonces[id] ?? 0}`}
                    workspaceId={id}
                    target={target}
                    visible={onScreen}
                    focusKey={id === sid && target === focusTarget ? focusNonce : undefined}
                  />
                </div>
              )}
            </div>
          )
        })}

        {/* Drop highlight while dragging a pane. */}
        {dropHighlight && (
          <div
            style={{
              left: dropHighlight.rect.x,
              top: dropHighlight.rect.y,
              width: dropHighlight.rect.w,
              height: dropHighlight.rect.h,
            }}
            className={clsx(
              'pointer-events-none absolute z-20',
              dropHighlight.bar
                ? 'rounded-full bg-accent'
                : 'rounded-lg border border-accent/60 bg-accent/15',
            )}
          />
        )}

        {/* Provisioning overlay, covering the pane area until ready. */}
        {creatingHere && (
          <div className="absolute inset-0 z-30 bg-shell">
            <CreatingPlaceholder creating={creatingHere} />
          </div>
        )}
      </div>

      {/* Outside the measured pane area rather than over it, so the
          terminal shrinks to make room. */}
      {keyBarTarget && sid && <TerminalKeyBar workspaceId={sid} target={keyBarTarget} />}

      <ConfirmDialog
        open={!!confirmDiscard}
        onOpenChange={(next) => { if (!next) setConfirmDiscard(null) }}
        title={`Discard unsaved changes to “${confirmDiscard?.name ?? ''}”?`}
        description="They could not be saved: the file changed or was deleted on disk, or saving is failing."
        confirmLabel="Discard"
        onConfirm={() => {
          if (confirmDiscard && sid) dropPane(sid, confirmDiscard.target)
          setConfirmDiscard(null)
        }}
      />
      <ConfirmDialog
        open={!!confirmKill}
        onOpenChange={(next) => { if (!next) setConfirmKill(null) }}
        title={`Kill terminal “${confirmKill?.name ?? ''}”?`}
        description="This kills the tmux window and whatever is running in it."
        confirmLabel="Kill"
        onConfirm={() => {
          if (confirmKill) killPane(confirmKill.target)
          setConfirmKill(null)
        }}
      />
    </main>
  )
}

/**
 * The mobile workspace bar's ⋯ menu, holding the desktop bar's controls
 * that don't fit on a phone. Warning badges stay in the bar.
 */
function PaneOverflowMenu({
  tool,
  chipPorts,
  previewPorts,
  onNewShell,
  onOpenChanges,
  onOpenFiles,
  onOpenPreview,
}: {
  tool: WorkspaceListEntry['tool']
  /** Forwarded ports shown as external links (browser only). */
  chipPorts: WorkspaceListEntry['forwardedPorts']
  /** Forwarded ports for the embedded preview pane (Electron only). */
  previewPorts: WorkspaceListEntry['forwardedPorts']
  onNewShell: () => void
  onOpenChanges: () => void
  onOpenFiles: () => void
  onOpenPreview: (containerPort: number) => void
}): JSX.Element {
  const ITEM = 'flex w-full cursor-default items-center gap-2 rounded-md px-2 py-2 text-xs '
    + 'text-text-dim outline-none data-[highlighted]:bg-surface-3 data-[highlighted]:text-text'
  return (
    <Menu.Root>
      <Menu.Trigger
        title="More"
        aria-label="More pane actions"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-dim
          transition active:bg-surface-2 data-[popup-open]:bg-surface-2"
      >
        <MoreIcon size={18} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={6}>
          <Menu.Popup className="min-w-[200px] rounded-lg border border-border bg-surface-2 p-1 text-text
            shadow-[0_12px_32px_var(--shadow-color)] outline-none transition-opacity duration-100
            data-[starting-style]:opacity-0 data-[ending-style]:opacity-0">
            <Menu.Item className={ITEM} onClick={onNewShell}>
              <AddIcon size={14} />
              New shell
            </Menu.Item>
            <Menu.Item className={ITEM} onClick={onOpenChanges}>
              <ChangesIcon size={14} />
              Review changes
            </Menu.Item>
            <Menu.Item className={ITEM} onClick={onOpenFiles}>
              <FilesIcon size={14} />
              Browse files
            </Menu.Item>
            {previewPorts.length > 0 && (
              <Menu.Item className={ITEM} onClick={() => onOpenPreview(previewPorts[0].containerPort)}>
                <PreviewIcon size={14} />
                Preview
              </Menu.Item>
            )}
            {/* window.open from a click, which popup blockers allow. */}
            {chipPorts.map((p) => (
              <Menu.Item
                key={`${p.hostPort}:${p.containerPort}`}
                className={ITEM}
                onClick={() => window.open(portLinkHref(window.location.hostname, p), '_blank', 'noopener')}
              >
                <PreviewIcon size={14} />
                <span className="font-mono">{portLinkLabel(p)}</span>
              </Menu.Item>
            ))}
            <div className="px-2 pb-1 pt-1.5 text-[11px] text-text-faint">{TOOL_LABEL[tool]}</div>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

