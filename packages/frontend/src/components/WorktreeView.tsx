import { useEffect, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Menu } from '@base-ui/react/menu'
import { useUiStore } from '#store'
import { WorktreeTerminal } from '#components/WorktreeTerminal'
import { WorktreePreview } from '#components/WorktreePreview'
import { WorktreeChanges } from '#components/WorktreeChanges'
import { WorktreeChat } from '#components/WorktreeChat'
import { isPreviewTarget, previewLabel } from '#lib/preview'
import { isChangesTarget } from '#lib/changesApi'
import { acpTarget, acpTargetSession, isAcpTarget } from '@yaac/shared/acp'
import { isElectron } from '#lib/platform'
import { goBackScreen } from '#lib/mobileHistory'
import { useIsMobile } from '#lib/viewport'
import { WorktreeTitle } from '#components/WorktreeTitle'
import { CreatingPlaceholder } from '#components/CreatingPlaceholder'
import { TerminalKeyBar } from '#components/TerminalKeyBar'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import {
  AddIcon, ChangesIcon, CloseIcon, MoreIcon, NavBackIcon, PreviewIcon, SidebarIcon, TabsIcon,
  TerminalIcon, TilesIcon, TOOL_LABEL,
} from '#lib/icons'
import { EmptyState } from '#components/ui/EmptyState'
import { NewWorktreeButton } from '#components/NewWorktreeButton'
import { BlockedHostsBadge } from '#components/BlockedHostsBadge'
import { UnforwardedPortsBadge } from '#components/UnforwardedPortsBadge'
import { GitAuthFailureBadge } from '#components/GitAuthFailureBadge'
import { ForwardedPortLinks, portLinkHref, portLinkLabel } from '#components/ForwardedPortLinks'
import { getWorktreeTerminals, createShellTerminal, killWorktreeTerminal } from '#lib/terminalsApi'
import { cycleDeltaFor, matchShortcut, resolveCycleTarget } from '#lib/shortcuts'
import {
  addColumn,
  addTab,
  computeColumns,
  dropTargetAt,
  focusPaneTarget,
  moveColumn,
  moveTabInStrip,
  moveTargetToColumn,
  moveTargetToGroup,
  paneTargets,
  removeTarget,
  singleColumn,
  type ColumnRect,
  type DropTarget,
  type Workspace,
} from '#lib/layout'
import type {
  ProvisioningWorktreeEntry,
  ServerSnapshot,
  WorktreeTerminalEntry,
  WorktreeListEntry,
} from '@yaac/shared/types'

/** Gap between column cards. */
const GAP = 8
/** Pane card header (tab strip) height. */
const HEADER_H = 28
/** The same strip on touch, where a tab has to be a finger-sized target. */
const MOBILE_HEADER_H = 38
/** Pane card inner padding around the terminal block. */
const PAD = 3
/** Pointer must travel this far before a tab-drag becomes a move. */
const DRAG_THRESHOLD = 5
/** Most worktrees eagerly attached (hidden) after a page load — each costs a
 *  kubectl-exec PTY on the server, so a large install shouldn't fan out
 *  dozens at once. Worktrees past the cap attach on first view, as before. */
const EAGER_ATTACH_MAX = 12
/** The same budget on a phone. Twelve pre-attached PTYs, each a live stream,
 *  is a desktop-on-LAN number; on a metered radio the instant switch-back
 *  isn't worth it beyond the worktree the user is actually in. */
const MOBILE_EAGER_ATTACH_MAX = 2

interface DragState {
  src: string
  startX: number
  startY: number
  active: boolean
  over?: DropTarget
}

function paneName(
  target: string,
  terminals: WorktreeTerminalEntry[] | undefined,
  previewPort?: number,
): string {
  if (target === 'agent') return 'Agent'
  if (isPreviewTarget(target)) return previewLabel(previewPort)
  if (isChangesTarget(target)) return 'Changes'
  if (isAcpTarget(target)) return 'Agent'
  const entry = terminals?.find((t) => t.target === target)
  return entry?.name ?? 'window'
}

/**
 * Special (non-terminal) panes: kept out of the tmux-window sync, closed
 * without a kill-confirm.
 *
 * An ACP conversation is special in the same way even though it *does* have a
 * tmux window behind it — the window runs acpd, not a TUI, so attaching a PTY
 * to it would show a supervisor's log instead of the conversation. It is
 * addressed by conversation id (`acp:<id>`), which the snapshot carries, not
 * by window id like a terminal.
 */
function isSpecialPane(target: string): boolean {
  return isPreviewTarget(target) || isChangesTarget(target) || isAcpTarget(target)
}

/**
 * The pane a worktree opens with. A `tui` worktree attaches a PTY to its agent
 * window; an `acp` one opens its first conversation's chat pane. Falls back to
 * the terminal when a fresh ACP worktree has not reported a conversation yet
 * (its id is minted by the agent, seconds after the pod is up) — the window
 * sync swaps in the chat pane as soon as it appears.
 */
function defaultPaneTarget(worktree: WorktreeListEntry | undefined): string {
  const acp = worktree?.agentSessions.find((a) => a.mode === 'acp' && a.active)
  return acp ? acpTarget(acp.agentSessionId) : 'agent'
}

export function WorktreeView({
  snapshot,
  provisioning,
}: {
  snapshot: ServerSnapshot | undefined
  provisioning: ProvisioningWorktreeEntry[]
}): JSX.Element {
  const selectedWorktreeId = useUiStore((s) => s.selectedWorktreeId)
  const focusNonce = useUiStore((s) => s.focusNonce)
  const terminalNonces = useUiStore((s) => s.terminalNonces)
  const layouts = useUiStore((s) => s.layouts)
  const setWorktreeLayout = useUiStore((s) => s.setWorktreeLayout)
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
  // On a phone this pane is a screen of its own: back replaces the sidebar
  // toggle, the header's control cluster folds into an overflow menu, and
  // tiles mode is off the table (docs/mobile-layout.md).
  const isMobile = useIsMobile()
  // The tab strip is part of the pane's pixel math (every terminal's rect is
  // measured below it), so its height is a number here rather than a class.
  const headerH = isMobile ? MOBILE_HEADER_H : HEADER_H
  const queryClient = useQueryClient()
  const worktrees = snapshot?.worktrees ?? []
  const worktree = worktrees.find((s) => s.worktreeId === selectedWorktreeId)
  const sid = worktree?.worktreeId ?? null
  // Project-wide flag; shown in the header because a rejected credential
  // fails git fetch/push inside this worktree too.
  const gitAuthFailures = (worktree && snapshot?.gitAuthFailures?.[worktree.projectSlug]) || []

  // Forwarded (portForward-config) ports drive the embedded preview in the
  // desktop app; in a browser build there's no embedded webview, so they fall
  // back to external-tab chips instead.
  const embedPreview = isElectron()
  const previewPorts = worktree?.forwardedPorts ?? []
  const chipPorts = embedPreview ? [] : previewPorts
  const previewPortForWorktree = sid ? previewPortMap[sid] : undefined

  // The provisioning placeholder owns the main pane only when its row is the
  // selected one (and no real worktree of that id exists yet) — so it never
  // hijacks a worktree you're viewing; you click the row to see its status.
  const creatingHere = worktree ? null : provisioning.find((p) => p.worktreeId === selectedWorktreeId) ?? null

  // The worktree's workspace: missing key = the default single agent column;
  // null = explicitly emptied.
  const layout: Workspace | null = sid
    ? (sid in layouts ? layouts[sid] : singleColumn(defaultPaneTarget(worktree)))
    : null

  // The container's terminals beyond the agent (initCommands windows and
  // scratch shells) — drives which panes exist, and their names.
  const { data: terminals } = useQuery({
    queryKey: ['terminals', sid],
    queryFn: () => getWorktreeTerminals(sid ?? ''),
    enabled: !!worktree,
    refetchInterval: 10_000,
    staleTime: 5_000,
  })

  // Workspace pixel size (columns are absolutely positioned from it).
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

  // A pane per live tmux window: the layout follows the container's window
  // list, so init windows and scratch shells show up by default (splitting
  // the largest pane; the user's arrangement is otherwise kept) and killed
  // windows drop out — including kills from another client, and stale
  // targets restored from localStorage after a worktree restart reassigned
  // the window ids. The size fallbacks only matter before the first
  // measure; the split heuristic just needs an aspect ratio.
  useEffect(() => {
    if (!sid || !worktree || !terminals) return
    const cur: Workspace | null = sid in layouts ? layouts[sid] : singleColumn(defaultPaneTarget(worktree))
    // An ACP worktree's conversations are panes too, but they come off the
    // snapshot rather than the window list: the tmux window behind one runs
    // acpd, and its name says nothing about which conversation it holds.
    const acpPanes = worktree.agentSessions
      .filter((a) => a.mode === 'acp' && a.active)
      .map((a) => acpTarget(a.agentSessionId))
    const isAcp = acpPanes.length > 0
    // With chat panes present the raw agent window is acpd's log, not
    // something to attach a terminal to — drop it from the live set.
    const live = [...(isAcp ? [] : ['agent']), ...acpPanes, ...terminals.map((t) => t.target)]
    const liveSet = new Set(live)
    let next: Workspace | null = cur
    for (const t of paneTargets(next)) {
      // Preview/changes panes aren't tmux windows — they're owned by their own
      // open/close logic, so this window-driven sync must leave them be. An
      // ACP pane IS in the live set when its conversation is active, so it is
      // checked like a window and removed when the conversation ends.
      if (liveSet.has(t)) continue
      if (isAcpTarget(t) || !isSpecialPane(t)) next = removeTarget(next, t)
    }
    for (const t of live) {
      // New windows (init commands, scratch shells) show up as their own
      // equal-width column; the user's arrangement is otherwise kept.
      next = addColumn(next, t)
    }
    if (next !== cur) setWorktreeLayout(sid, next)
  }, [sid, worktree, terminals, layouts, setWorktreeLayout])

  // Tabs mode renders all the workspace's panes as one tabbed window; the
  // workspace stays canonical so toggling back to tiles restores the columns.
  const targets = paneTargets(layout)
  const activeTab = sid
    ? (activeTabs[sid] && targets.includes(activeTabs[sid]) ? activeTabs[sid] : targets[0])
    : undefined
  // Forced off on mobile at render, never written back to the store: a user
  // who prefers tiles on their desktop must not have that preference rewritten
  // by opening the same server on a phone.
  const tiled = viewMode === 'tiles' && !isMobile
  // The pane to drop focus into when this worktree is selected/opened or a
  // shortcut switches terminals — only that one terminal gets a live
  // focusKey, so a bumped focusNonce focuses it without disturbing any
  // other (kept-alive, off-screen) terminal. Fed the raw stored tab:
  // focusPaneTarget validates it and prefers the agent pane in tiles mode
  // when nothing was made active yet.
  const focusTarget = sid ? focusPaneTarget(targets, activeTabs[sid], tiled) : null
  // Equal-width columns; each column shows its active tab. Off-screen tabs are
  // the other tabs of a column (kept alive, hidden). No dividers — widths are
  // always equal.
  const cols = computeColumns(layout, { x: 0, y: 0, w: wsSize.w, h: wsSize.h }, GAP)
  const colsRef = useRef<ColumnRect[]>(cols)
  colsRef.current = cols
  // The visible pane rect per column (its active tab) — drives keep-alive
  // positioning and the drop highlight.
  const activePaneRect = new Map(cols.map((c) => [c.group.active, c.rect]))

  // Keep-alive: every worktree|target ever shown stays mounted (hidden) so
  // switching back is instant. Panes closed explicitly are dropped.
  const [opened, setOpened] = useState<string[]>([])
  useEffect(() => {
    if (!sid || !layout) return
    const keys = paneTargets(layout).map((t) => `${sid}|${t}`)
    setOpened((prev) => {
      const fresh = keys.filter((k) => !prev.includes(k))
      return fresh.length ? [...prev, ...fresh] : prev
    })
  }, [sid, layout])

  const liveIds = new Set(worktrees.map((s) => s.worktreeId))
  const mounted = opened.filter((key) => liveIds.has(key.slice(0, key.indexOf('|'))))

  // Last shown rect per kept-alive terminal — hidden panes freeze here so
  // re-showing them is resize-free (see the style computation below). Render-
  // time cache writes are idempotent, so this is safe under re-renders.
  const lastRects = useRef(new Map<string, { left: number; top: number; width: number; height: number }>())
  for (const k of [...lastRects.current.keys()]) {
    if (!mounted.includes(k)) lastRects.current.delete(k)
  }

  // Eager attach: after a reload the keep-alive set starts empty, so every
  // worktree's first click paid the attach chain plus the settle-gate
  // "Connecting…" mask. Instead, mount every live worktree's agent pane
  // (hidden) as soon as the workspace is measured — they attach and settle
  // off-screen, and a sidebar click becomes the same pure visibility flip
  // as switching back to an already-viewed worktree. Agent only: it's the
  // tab a fresh page reveals (activeTabs don't persist), it exists for
  // every worktree, and it avoids trusting persisted layouts whose window
  // ids may be stale. Each pane's rect is pre-seeded to the tabs-mode rect
  // so the hidden terminal attaches at exactly the size a click reveals —
  // no resize round trip at reveal. Capped so a large install doesn't fan
  // out dozens of kubectl PTYs at once; uncovered worktrees just keep the
  // old click-to-attach behavior.
  const eagerIdsKey = worktrees
    .filter((s) => !s.stopping)
    .slice(0, isMobile ? MOBILE_EAGER_ATTACH_MAX : EAGER_ATTACH_MAX)
    .map((s) => s.worktreeId)
    .join(',')
  useEffect(() => {
    if (wsSize.w <= 0 || wsSize.h <= 0 || eagerIdsKey === '') return
    const keys = eagerIdsKey.split(',').map((id) => `${id}|agent`)
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
  }, [eagerIdsKey, wsSize.w, wsSize.h, headerH])

  const refetchTerminals = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['terminals', sid] })
  }

  /** Create a scratch-shell window and open its pane — as a tab of the column
   *  at `onto.groupIdx`, or as a new column. The server returns the new window
   *  id up front, so the pane opens without waiting for the next terminals
   *  poll. */
  const openShell = (onto?: { groupIdx: number }): void => {
    if (!sid) return
    void createShellTerminal(sid)
      .then((entry) => {
        queryClient.setQueryData<WorktreeTerminalEntry[]>(
          ['terminals', sid],
          (old) => old ? [...old.filter((t) => t.target !== entry.target), entry] : [entry],
        )
        const state = useUiStore.getState()
        const cur = sid in state.layouts ? state.layouts[sid] : singleColumn('agent')
        let next = onto && cur ? addTab(cur, onto.groupIdx, entry.target) : addColumn(cur, entry.target)
        // The column may have gone away between the click and the shell
        // resolving (out-of-range addTab is a no-op) — fall back to a column
        // so the shell always appears.
        if (!paneTargets(next).includes(entry.target)) next = addColumn(cur, entry.target)
        state.setWorktreeLayout(sid, next)
        state.focusTerminal(sid, entry.target)
      })
      .catch((e: unknown) => console.error('new shell failed', e))
  }

  // Pane (x) / Alt+W → confirm → kill the tmux window (and whatever runs
  // in it).
  const [confirmKill, setConfirmKill] = useState<{ target: string; name: string } | null>(null)

  // Workspace shortcuts (all rebindable — these are the defaults): Alt+H/Alt+L
  // cycle terminals left/right and Alt+Shift+H/Alt+Shift+L move the active one
  // (its window in tiles mode) — the webapp-level replacement for tmux's prefix
  // bindings (webapp panes run with `prefix None`) — Alt+S opens a new scratch
  // shell, Alt+C opens the changes pane (Alt+F opens it and focuses its find
  // box), Alt+P opens the preview pane, Alt+,/Alt+. switch the tabbed/window
  // view, and Alt+W kills the active terminal through the same confirm dialog
  // as the pane × (Alt+N, new worktree, and Alt+K/Alt+J, worktree cycle, live in
  // App's Workspace, which owns project scope). Captured on window so the chord
  // is swallowed before xterm's textarea handler could forward it to the PTY;
  // the ref keeps the single listener reading the current render's state.
  const shortcutCtx = useRef({ sid, targets, activeTab, terminals, openShell, previewPorts, isMobile })
  shortcutCtx.current = { sid, targets, activeTab, terminals, openShell, previewPorts, isMobile }
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const ctx = shortcutCtx.current
      if (!ctx.sid) return
      const state = useUiStore.getState()
      // The settings pane is capturing a rebind — leave the keypress alone.
      if (state.recordingShortcut) return
      // Only the terminal-scoped commands are handled here; project-scoped ones
      // belong to App's listener, so their ids fall through the switch.
      const id = matchShortcut(state.bindings, e)
      switch (id) {
        case 'new-shell':
          e.preventDefault()
          e.stopPropagation()
          ctx.openShell()
          return
        case 'kill-terminal': {
          // The agent pane isn't killable — leave the chord alone then.
          if (!ctx.activeTab || ctx.activeTab === 'agent') return
          e.preventDefault()
          e.stopPropagation()
          // A preview/changes pane just closes (no tmux window, no confirm).
          if (isSpecialPane(ctx.activeTab)) {
            const st = useUiStore.getState()
            const cur = ctx.sid in st.layouts ? st.layouts[ctx.sid] : null
            if (cur) st.setWorktreeLayout(ctx.sid, removeTarget(cur, ctx.activeTab))
            return
          }
          setConfirmKill({ target: ctx.activeTab, name: paneName(ctx.activeTab, ctx.terminals) })
          return
        }
        case 'find-changes':
          // Open (or surface) the changes pane, then ask its find box to take
          // focus — WorktreeChanges consumes the pending flag once mounted.
          e.preventDefault()
          e.stopPropagation()
          state.openChanges(ctx.sid)
          state.setChangesFindPending(true)
          return
        case 'open-changes':
          e.preventDefault()
          e.stopPropagation()
          state.openChanges(ctx.sid)
          return
        case 'open-preview':
          // Nothing to preview without a forwarded port — leave the chord alone.
          if (ctx.previewPorts.length === 0) return
          // Open/focus the preview pane; the store seeds the shown port lazily
          // (the first forwarded port until the toolbar dropdown picks another).
          e.preventDefault()
          e.stopPropagation()
          state.openPreview(ctx.sid)
          return
        case 'view-tabs':
        case 'view-tiles':
          // Mobile forces tabs at render, so the chord would have no visible
          // effect — but it would still persist the mode, silently rewriting a
          // desktop tiles preference from a phone-width viewport with a
          // hardware keyboard attached. Leave the chord alone there, the same
          // way the header's toggle button is `!isMobile`-gated.
          if (ctx.isMobile) return
          e.preventDefault()
          e.stopPropagation()
          state.setViewMode(id === 'view-tabs' ? 'tabs' : 'tiles')
          return
        case 'move-terminal-left':
        case 'move-terminal-right': {
          // Reorder the active pane with wraparound: its whole window in tiles
          // mode, its slot in the flat strip in tabs mode. Then re-focus it so
          // it stays the visible/active pane after the shuffle.
          if (!ctx.activeTab) return
          e.preventDefault()
          e.stopPropagation()
          const dir = id === 'move-terminal-right' ? 1 : -1
          const cur = ctx.sid in state.layouts ? state.layouts[ctx.sid] : singleColumn('agent')
          if (!cur) return
          const moved = state.viewMode === 'tiles'
            ? moveColumn(cur, ctx.activeTab, dir)
            : moveTabInStrip(cur, ctx.activeTab, dir)
          if (moved === cur) return
          state.setWorktreeLayout(ctx.sid, moved)
          state.focusTerminal(ctx.sid, ctx.activeTab)
          return
        }
        case 'prev-terminal':
        case 'next-terminal': {
          const delta = cycleDeltaFor(id)
          if (delta === null) return
          const next = resolveCycleTarget(ctx.targets, ctx.activeTab, delta)
          if (!next) return
          e.preventDefault()
          e.stopPropagation()
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
    if (!sid || !layout) return
    // Drop the cache entry alongside the pane so the layout-sync effect
    // doesn't re-add the window while the kill is in flight. A failed kill
    // self-heals: the next terminals poll lists the window again and the
    // sync reopens its pane.
    queryClient.setQueryData<WorktreeTerminalEntry[]>(
      ['terminals', sid],
      (old) => old?.filter((t) => t.target !== target),
    )
    setWorktreeLayout(sid, removeTarget(layout, target))
    setOpened((prev) => prev.filter((k) => k !== `${sid}|${target}`))
    void killWorktreeTerminal(sid, target)
      .catch((e: unknown) => console.error('kill terminal failed', e))
      .finally(refetchTerminals)
  }

  // Close a special (preview/changes) pane: just drop the leaf — there's no
  // tmux window to kill, and no confirm (both are cheap to reopen).
  const closePane = (target: string): void => {
    if (!sid || !layout) return
    setWorktreeLayout(sid, removeTarget(layout, target))
    setOpened((prev) => prev.filter((k) => k !== `${sid}|${target}`))
  }

  // --- tab drag (rearrange columns / merge into tabs) ---
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  dragRef.current = drag

  // A tab is both a drag handle and a click target: a press that never crosses
  // the threshold selects the tab (onSelect), one that does moves the pane —
  // onto another column's central band it becomes a tab there, into a gap /
  // outer third it becomes a new column at that index.
  const onTabDown = (e: ReactPointerEvent, src: string, onSelect: () => void): void => {
    e.preventDefault()
    if (!sid) return
    const ws = wsRef.current
    if (!ws) return
    const wsRect = ws.getBoundingClientRect()
    // Write the ref directly too: the move handler may fire before React
    // re-renders (which is when the ref would otherwise sync).
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
      const node = sid in cur.layouts ? cur.layouts[sid] : singleColumn('agent')
      if (!node) return
      const moved = d.over.kind === 'tab'
        ? moveTargetToGroup(node, d.src, d.over.group)
        : moveTargetToColumn(node, d.src, d.over.index)
      cur.setWorktreeLayout(sid, moved)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // While dragging: a filled box over the column the pane would tab into, or a
  // thin insertion bar where a new column would open.
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

  /** A tab in a column strip (tiles) or the single tab bar (tabs). Draggable
   *  tabs double as click targets — see onTabDown. */
  const renderTab = (
    t: string,
    opts: { isActive: boolean; onSelect: () => void; draggable: boolean },
  ): JSX.Element => (
    <span key={t} className="group/tab relative flex items-center">
      <button
        onPointerDown={opts.draggable ? (e) => onTabDown(e, t, opts.onSelect) : undefined}
        onClick={opts.draggable ? undefined : opts.onSelect}
        className={clsx(
          'rounded px-2 py-0.5 text-[11px] transition',
          // Finger-sized on touch — with tiles mode off, this strip is the
          // only way to move between a worktree's panes.
          'max-md:h-8 max-md:rounded-md max-md:px-3 max-md:text-xs',
          opts.draggable && 'cursor-grab select-none active:cursor-grabbing',
          t !== 'agent' && 'pr-5 max-md:pr-7',
          drag?.active && drag.src === t && 'opacity-60',
          opts.isActive
            ? 'bg-surface-3 font-medium text-text'
            : 'text-text-faint hover:text-text-dim',
        )}
      >
        {paneName(t, terminals, previewPortForWorktree)}
      </button>
      {isSpecialPane(t) ? (
        <button
          onClick={() => closePane(t)}
          title="Close pane"
          aria-label={`Close ${paneName(t, terminals, previewPortForWorktree)}`}
          className="absolute right-0.5 flex h-4 w-4 items-center justify-center rounded
            text-text-faint opacity-0 transition hover:text-text group-hover/tab:opacity-100
            max-md:h-6 max-md:w-6 max-md:opacity-100"
        >
          <CloseIcon size={10} />
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

  /** The header's leading affordance. On a phone this pane is a screen of its
   *  own, so it is the back chevron to the worktree list; on desktop it is the
   *  show-sidebar toggle, and only while the sidebar is hidden — when it's
   *  open, its toggle lives in the sidebar header next to +. */
  const leading: ReactNode = isMobile ? (
    <button
      onClick={goBackScreen}
      title="Back to worktrees"
      aria-label="Back to worktrees"
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

  // Desktop lays eleven controls across the worktree bar; a phone has room for
  // the title and about three. The alarm chits (git auth, blocked hosts,
  // unforwarded ports) stay in the bar — they mean something is wrong and
  // shouldn't be buried — and the rest folds into this menu.
  const headerClass = isMobile
    ? 'flex h-12 shrink-0 items-center gap-1 border-b border-hairline pl-1 pr-1.5 text-xs'
    : 'flex h-8 shrink-0 items-center gap-2.5 px-2 text-xs'

  // The terminal accessory keys: only on a phone, only over a real terminal
  // pane. A preview, a diff or an ACP chat pane has nothing to send Esc to.
  const keyBarTarget = isMobile && worktree && activeTab && !isSpecialPane(activeTab) ? activeTab : null

  return (
    <main className="flex h-full min-w-0 flex-col">
      {/* Slim worktree bar on the base layer — the panes are the cards. */}
      {creatingHere ? (
        <header className={headerClass}>
          {leading}
          <span className="titlebar-drag min-w-0 flex-1 truncate font-medium text-text-dim">
            {creatingHere.kind === 'restart' ? 'Restarting worktree' : 'New worktree'}
          </span>
          <span className="shrink-0 text-[11px] text-text-faint">{TOOL_LABEL[creatingHere.tool]}</span>
        </header>
      ) : worktree ? (
        <header className={headerClass}>
          {leading}
          <WorktreeTitle
            worktreeId={worktree.worktreeId}
            title={worktree.title ?? ''}
            prompt={worktree.prompt ?? ''}
          />
          {!isMobile && (
            <button
              onClick={() => setViewMode(tiled ? 'tabs' : 'tiles')}
              title={tiled ? 'Switch to tabs' : 'Switch to tiles'}
              aria-label={tiled ? 'Switch to tabs' : 'Switch to tiles'}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-dim transition
                hover:bg-surface-2 hover:text-text"
            >
              {tiled ? <TabsIcon size={13} /> : <TilesIcon size={13} />}
            </button>
          )}
          {!isMobile && (
            <>
              <button
                onClick={() => openShell()}
                title="New shell"
                aria-label="New shell"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-dim transition
                  hover:bg-surface-2 hover:text-text"
              >
                <AddIcon size={14} />
              </button>
              <button
                onClick={() => openChanges(worktree.worktreeId)}
                title="Review changes"
                aria-label="Review changes"
                className="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px]
                  text-text-dim transition hover:bg-surface-2 hover:text-text"
              >
                <ChangesIcon size={13} />
                Changes
              </button>
              {embedPreview && previewPorts.length > 0 && (
                <button
                  onClick={() => openPreview(worktree.worktreeId, previewPorts[0].containerPort)}
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
          {worktree.unforwardedPorts.length > 0 && (
            <UnforwardedPortsBadge
              ports={worktree.unforwardedPorts}
              worktreeId={worktree.worktreeId}
              exposeHost={snapshot?.forwardBindHost ?? '127.0.0.1'}
              iconSize={11}
              className="hover:bg-surface-3"
            />
          )}
          {gitAuthFailures.length > 0 && (
            <GitAuthFailureBadge
              failures={gitAuthFailures}
              iconSize={12}
              className="hover:bg-[#d65858]/25"
            />
          )}
          {worktree.blockedHosts.length > 0 && (
            <BlockedHostsBadge hosts={worktree.blockedHosts} worktreeId={worktree.worktreeId} iconSize={12} className="hover:bg-[#d65858]/25" />
          )}
          {isMobile ? (
            <PaneOverflowMenu
              tool={worktree.tool}
              chipPorts={chipPorts}
              previewPorts={embedPreview ? previewPorts : []}
              onNewShell={() => openShell()}
              onOpenChanges={() => openChanges(worktree.worktreeId)}
              onOpenPreview={(p) => openPreview(worktree.worktreeId, p)}
            />
          ) : (
            /* Tool name sits at the far right, past any chits that appear. */
            <span className="shrink-0 text-[11px] text-text-faint">{TOOL_LABEL[worktree.tool]}</span>
          )}
        </header>
      ) : (
        <header className={clsx(headerClass, 'titlebar-drag')}>
          {leading && <div className="no-drag">{leading}</div>}
        </header>
      )}

      {/* `isolate`: the provisioning overlay below is z-30, and without an
          isolating stacking context here it escapes into the root context and
          paints over portaled dropdowns (e.g. "+ New worktree"). Isolating
          confines its z-index so those popups render above it. */}
      <div ref={wsRef} className="relative isolate min-h-0 flex-1">
        {!worktree && !creatingHere && (
          <EmptyState
            className="h-full"
            icon={TerminalIcon}
            title="No worktrees yet"
            description="Start a coding-agent worktree and it opens right here."
            action={activeProjectSlug
              ? <NewWorktreeButton projectSlug={activeProjectSlug} variant="cta" />
              : undefined}
          />
        )}

        {/* Column cards (chrome) for the selected worktree — tiles mode. Each
            column is a tabbed window; its body is filled by the kept-alive
            terminals below. */}
        {worktree && tiled && cols.map(({ group, rect }, gi) => (
          <section
            key={gi}
            style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
            className="absolute flex flex-col overflow-hidden rounded-lg border border-hairline
              bg-surface shadow-[0_8px_24px_var(--shadow-color)]"
          >
            <div style={{ height: headerH }} className="flex shrink-0 items-center gap-0.5 px-1.5">
              {group.tabs.map((t) => renderTab(t, {
                isActive: group.active === t,
                onSelect: () => focusTerminal(worktree.worktreeId, t),
                draggable: true,
              }))}
              <button
                onClick={() => openShell({ groupIdx: gi })}
                title="New shell"
                aria-label="New shell tab"
                className="flex h-5 w-5 items-center justify-center rounded text-text-faint transition
                  hover:bg-surface-2 hover:text-text"
              >
                <AddIcon size={12} />
              </button>
            </div>
          </section>
        ))}

        {/* Tabs mode: one full-bleed card; the strip switches between all the
            workspace's panes the tiles mode arranges into columns. */}
        {worktree && !tiled && targets.length > 0 && (
          // Full-bleed on a phone: the screen is the card, so the rounding,
          // border and drop shadow (which exist to lift the pane off the base
          // layer it floats on) have nothing left to lift it from.
          <section className="absolute inset-0 flex flex-col overflow-hidden rounded-lg border
            border-hairline bg-surface shadow-[0_8px_24px_var(--shadow-color)]
            max-md:rounded-none max-md:border-0 max-md:shadow-none">
            <div
              style={{ height: headerH }}
              className="flex shrink-0 items-center gap-0.5 overflow-x-auto px-1.5"
            >
              {targets.map((t) => renderTab(t, {
                isActive: activeTab === t,
                onSelect: () => focusTerminal(worktree.worktreeId, t),
                draggable: false,
              }))}
              <button
                onClick={() => openShell()}
                title="New shell"
                aria-label="New shell tab"
                className="flex h-5 w-5 items-center justify-center rounded text-text-faint transition
                  hover:bg-surface-2 hover:text-text"
              >
                <AddIcon size={12} />
              </button>
            </div>
          </section>
        )}

        {/* Kept-alive terminals, positioned into their pane bodies. */}
        {mounted.map((key) => {
          const sep = key.indexOf('|')
          const id = key.slice(0, sep)
          const target = key.slice(sep + 1)
          const preview = isPreviewTarget(target)
          const changes = isChangesTarget(target)
          const chat = acpTargetSession(target)
          const special = preview || changes || chat !== undefined
          // In tiles mode a pane is on-screen when it's the active tab of its
          // column; its rect is that column's body.
          const colRect = id === sid && tiled ? activePaneRect.get(target) : undefined
          // Hidden terminals never change size. With per-view `window-size
          // manual` a pane resize round-trips resize-window to the server, and
          // a switch that changed the pane's size flashed the stale window
          // (overflow dots on the right) until it landed. So in tabs mode every
          // terminal tab of the selected worktree shares the active tab's rect
          // (the inactive ones merely invisible), and any other kept-alive pane
          // freezes at the last rect it was shown with — switching tabs or
          // worktrees is a pure visibility flip, no resize at all. Special panes
          // still unmount off-screen (below).
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
            : id === sid && !tiled && (special ? target === activeTab : targets.includes(target))
              ? tabsRect
              : special
                ? undefined
                : lastRects.current.get(key)
          if (!special && style) lastRects.current.set(key, style)
          // Terminals stay mounted while hidden (instant switch-back, live PTY);
          // a preview/changes pane is torn down off-screen (a hidden one keeps
          // polling the pod) and cheaply re-mounts on return. Both only have a
          // `style` for the selected worktree, so previewPorts /
          // previewPortForWorktree (both for sid) apply.
          if (special && !style) return null
          return (
            <div
              key={key}
              // The wrapper (bg-bg) mirrors the xterm background exactly, so the
              // padding around the terminal is seamless — both follow the app
              // theme (dark terminal on the dark shell, light on the light one).
              // A preview fills its pane flush (its own chrome, no padding).
              style={style}
              // Keep the active-terminal record in step with focus changes
              // the DOM makes on its own (clicking into a tiled pane), so
              // the cycle shortcut steps from the pane the user is actually
              // in. Re-recording a shortcut-driven focus is a store no-op.
              onFocusCapture={() => useUiStore.getState().setActiveTab(id, target)}
              className={clsx('absolute', !onScreen && 'invisible', !style && 'left-0 top-0 h-full w-full')}
            >
              {preview ? (
                <div className="h-full w-full overflow-hidden rounded-md">
                  <WorktreePreview
                    worktreeId={id}
                    ports={previewPorts}
                    currentPort={previewPortForWorktree}
                    onSwitchPort={(p) => setPreviewPort(id, p)}
                  />
                </div>
              ) : chat !== undefined ? (
                <div className="h-full w-full overflow-hidden rounded-md">
                  <WorktreeChat worktreeId={id} agentSessionId={chat} visible={onScreen} />
                </div>
              ) : changes ? (
                <div className="h-full w-full overflow-hidden rounded-md">
                  {(() => {
                    const cs = worktrees.find((s) => s.worktreeId === id)
                    return (
                      <WorktreeChanges
                        worktreeId={id}
                        projectSlug={cs?.projectSlug ?? ''}
                        baseBranch={cs?.baseBranch}
                      />
                    )
                  })()}
                </div>
              ) : (
                <div className="h-full w-full overflow-hidden rounded-md bg-bg px-2.5 py-1.5">
                  <WorktreeTerminal
                    key={`${key}:${terminalNonces[id] ?? 0}`}
                    worktreeId={id}
                    target={target}
                    // On-screen panes render; the rest are kept-alive but
                    // hidden (a hidden tab keeps its rect, so it's the right
                    // size the instant it's shown). Drives the WebGL context.
                    visible={onScreen}
                    focusKey={id === sid && target === focusTarget ? focusNonce : undefined}
                  />
                </div>
              )}
            </div>
          )
        })}

        {/* Drop highlight while dragging a pane: a filled box to tab into a
            column, or a thin bar where a new column would open. */}
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

        {/* Provisioning overlay — covers the workspace until ready. Scoped to
            the active project so it can't cover another project's worktree. */}
        {creatingHere && (
          <div className="absolute inset-0 z-30 bg-base">
            <CreatingPlaceholder creating={creatingHere} />
          </div>
        )}
      </div>

      {/* A sibling of the measured workspace, not an overlay on it: the space
          the bar takes comes out of the terminal's height, so the PTY's row
          count follows and nothing ends up hidden behind it. */}
      {keyBarTarget && sid && <TerminalKeyBar worktreeId={sid} target={keyBarTarget} />}

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
 * The mobile worktree bar's ⋯ menu: everything the desktop bar lays out
 * horizontally and a 390px screen has no room for.
 *
 * The alarm chits (git auth, blocked hosts, unforwarded ports) deliberately
 * stay out of here and remain in the bar — they say something is wrong, and
 * burying that behind a tap defeats the point.
 */
function PaneOverflowMenu({
  tool,
  chipPorts,
  previewPorts,
  onNewShell,
  onOpenChanges,
  onOpenPreview,
}: {
  tool: WorktreeListEntry['tool']
  /** Forwarded ports as external links (browser builds — no embedded webview). */
  chipPorts: WorktreeListEntry['forwardedPorts']
  /** Forwarded ports the embedded preview pane can show (Electron only). */
  previewPorts: WorktreeListEntry['forwardedPorts']
  onNewShell: () => void
  onOpenChanges: () => void
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
            {previewPorts.length > 0 && (
              <Menu.Item className={ITEM} onClick={() => onOpenPreview(previewPorts[0].containerPort)}>
                <PreviewIcon size={14} />
                Preview
              </Menu.Item>
            )}
            {/* Opened imperatively rather than as an <a>: this is a menu item,
                and the click is a user gesture, so no popup blocker applies. */}
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

