import { useEffect, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import clsx from 'clsx'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useUiStore } from '@/frontend/store'
import { SessionTerminal } from '@/frontend/components/SessionTerminal'
import { SessionActionsMenu } from '@/frontend/components/SessionActionsMenu'
import { CreatingPlaceholder } from '@/frontend/components/CreatingPlaceholder'
import { ConfirmDialog } from '@/frontend/components/ui/ConfirmDialog'
import { AddIcon, CloseIcon, SidebarIcon, SplitDownIcon, SplitRightIcon, TabsIcon, TerminalIcon, TilesIcon, TOOL_LABEL } from '@/frontend/lib/icons'
import { EmptyState } from '@/frontend/components/ui/EmptyState'
import { NewSessionButton } from '@/frontend/components/NewSessionButton'
import { BlockedHostsBadge } from '@/frontend/components/BlockedHostsBadge'
import { GitAuthFailureBadge } from '@/frontend/components/GitAuthFailureBadge'
import { ForwardedPortLinks } from '@/frontend/components/ForwardedPortLinks'
import { getSessionTerminals, createShellTerminal, killSessionTerminal } from '@/frontend/lib/terminalsApi'
import { cycleDeltaFor, matchShortcut, resolveCycleTarget } from '@/frontend/lib/shortcuts'
import {
  addLeafToLargest,
  computeLayout,
  dropEdgeFor,
  dropHighlightRect,
  focusPaneTarget,
  leaf,
  leafTargets,
  moveLeaf,
  moveLeafToRoot,
  removeLeaf,
  setRatioAt,
  splitLeaf,
  type DropEdge,
  type LayoutNode,
  type PaneRect,
  type SplitDir,
} from '@/frontend/lib/layout'
import type { DaemonSnapshot, ProvisioningSessionEntry, SessionTerminalEntry } from '@/shared/types'

/** Gap between pane cards (the dividers live in it). */
const GAP = 8
/** Pane card header height. */
const HEADER_H = 28
/** Pane card inner padding around the terminal block. */
const PAD = 3
/** Pointer must travel this far before a header-drag becomes a move. */
const DRAG_THRESHOLD = 5
/** Dragging within this many px of a workspace edge targets the ROOT —
 *  dropping there gives the pane a full-height/width half of the whole
 *  workspace instead of splitting an individual pane. */
const ROOT_EDGE_MARGIN = 28

type DropTarget =
  | { kind: 'pane'; dest: string; edge: DropEdge }
  | { kind: 'root'; edge: Exclude<DropEdge, 'center'> }

interface DragState {
  src: string
  startX: number
  startY: number
  active: boolean
  over?: DropTarget
}

/** Root-edge hit test: the closest workspace edge within the margin. */
function rootEdgeAt(px: number, py: number, w: number, h: number): Exclude<DropEdge, 'center'> | null {
  const dists: Array<[Exclude<DropEdge, 'center'>, number]> = [
    ['left', px],
    ['right', w - px],
    ['top', py],
    ['bottom', h - py],
  ]
  dists.sort((a, b) => a[1] - b[1])
  return dists[0][1] <= ROOT_EDGE_MARGIN ? dists[0][0] : null
}

function paneName(target: string, terminals: SessionTerminalEntry[] | undefined): string {
  if (target === 'agent') return 'Agent'
  const entry = terminals?.find((t) => t.target === target)
  return entry?.name ?? 'window'
}

export function SessionView({
  snapshot,
  provisioning,
}: {
  snapshot: DaemonSnapshot | undefined
  provisioning: ProvisioningSessionEntry[]
}): JSX.Element {
  const selectedSessionId = useUiStore((s) => s.selectedSessionId)
  const focusNonce = useUiStore((s) => s.focusNonce)
  const terminalNonces = useUiStore((s) => s.terminalNonces)
  const layouts = useUiStore((s) => s.layouts)
  const setSessionLayout = useUiStore((s) => s.setSessionLayout)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const sidebarOpen = useUiStore((s) => s.sidebarOpen)
  const activeProjectSlug = useUiStore((s) => s.activeProjectSlug)
  const viewMode = useUiStore((s) => s.viewMode)
  const setViewMode = useUiStore((s) => s.setViewMode)
  const activeTabs = useUiStore((s) => s.activeTabs)
  const focusTerminal = useUiStore((s) => s.focusTerminal)
  const queryClient = useQueryClient()
  const sessions = snapshot?.sessions ?? []
  const session = sessions.find((s) => s.sessionId === selectedSessionId)
  const sid = session?.sessionId ?? null
  // Project-wide flag; shown in the header because a rejected credential
  // fails git fetch/push inside this session too.
  const gitAuthFailures = (session && snapshot?.gitAuthFailures?.[session.projectSlug]) || []

  // The provisioning placeholder owns the main pane only when its row is the
  // selected one (and no real session of that id exists yet) — so it never
  // hijacks a session you're viewing; you click the row to see its status.
  const creatingHere = session ? null : provisioning.find((p) => p.sessionId === selectedSessionId) ?? null

  // The session's workspace tree: missing key = the default single agent
  // pane; null = explicitly emptied.
  const layout: LayoutNode | null = sid ? (sid in layouts ? layouts[sid] : leaf('agent')) : null

  // The container's terminals beyond the agent (initCommands windows and
  // scratch shells) — drives which panes exist, and their names.
  const { data: terminals } = useQuery({
    queryKey: ['terminals', sid],
    queryFn: () => getSessionTerminals(sid ?? ''),
    enabled: !!session,
    refetchInterval: 10_000,
    staleTime: 5_000,
  })

  // Workspace pixel size (panes are absolutely positioned from the tree).
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
  // targets restored from localStorage after a session restart reassigned
  // the window ids. The size fallbacks only matter before the first
  // measure; the split heuristic just needs an aspect ratio.
  useEffect(() => {
    if (!sid || !session || !terminals) return
    const cur: LayoutNode | null = sid in layouts ? layouts[sid] : leaf('agent')
    const live = ['agent', ...terminals.map((t) => t.target)]
    const liveSet = new Set(live)
    let next = cur
    for (const t of leafTargets(next)) {
      if (!liveSet.has(t)) next = next && removeLeaf(next, t)
    }
    for (const t of live) {
      next = addLeafToLargest(next, t, wsSize.w || 1200, wsSize.h || 800)
    }
    if (next !== cur) setSessionLayout(sid, next)
  }, [sid, session, terminals, layouts, setSessionLayout, wsSize.w, wsSize.h])

  // Tabs mode renders the same layout-tree leaves one at a time; the tree
  // stays canonical so toggling back to tiles restores the arrangement.
  const targets = leafTargets(layout)
  const activeTab = sid
    ? (activeTabs[sid] && targets.includes(activeTabs[sid]) ? activeTabs[sid] : targets[0])
    : undefined
  const tiled = viewMode === 'tiles'
  // The pane to drop focus into when this session is selected/opened or a
  // shortcut switches terminals — only that one terminal gets a live
  // focusKey, so a bumped focusNonce focuses it without disturbing any
  // other (kept-alive, off-screen) terminal. Fed the raw stored tab:
  // focusPaneTarget validates it and prefers the agent pane in tiles mode
  // when nothing was made active yet.
  const focusTarget = sid ? focusPaneTarget(targets, activeTabs[sid], tiled) : null
  const { panes, dividers } = computeLayout(layout, { x: 0, y: 0, w: wsSize.w, h: wsSize.h }, GAP)
  const panesRef = useRef<PaneRect[]>(panes)
  panesRef.current = panes

  // Keep-alive: every session|target ever shown stays mounted (hidden) so
  // switching back is instant. Panes closed explicitly are dropped.
  const [opened, setOpened] = useState<string[]>([])
  useEffect(() => {
    if (!sid || !layout) return
    const keys = leafTargets(layout).map((t) => `${sid}|${t}`)
    setOpened((prev) => {
      const fresh = keys.filter((k) => !prev.includes(k))
      return fresh.length ? [...prev, ...fresh] : prev
    })
  }, [sid, layout])

  const liveIds = new Set(sessions.map((s) => s.sessionId))
  const mounted = opened.filter((key) => liveIds.has(key.slice(0, key.indexOf('|'))))

  const refetchTerminals = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['terminals', sid] })
  }

  /** Create a scratch-shell window and open its pane — split `onto`, or
   *  the largest pane. The daemon returns the new window id up front, so
   *  the pane opens without waiting for the next terminals poll. */
  const openShell = (onto?: { target: string; dir: SplitDir }): void => {
    if (!sid) return
    void createShellTerminal(sid)
      .then((entry) => {
        queryClient.setQueryData<SessionTerminalEntry[]>(
          ['terminals', sid],
          (old) => old ? [...old.filter((t) => t.target !== entry.target), entry] : [entry],
        )
        const state = useUiStore.getState()
        const cur = sid in state.layouts ? state.layouts[sid] : leaf('agent')
        const next = onto && cur
          ? splitLeaf(cur, onto.target, entry.target, onto.dir)
          : addLeafToLargest(cur, entry.target, wsSize.w || 1200, wsSize.h || 800)
        state.setSessionLayout(sid, next)
        state.focusTerminal(sid, entry.target)
      })
      .catch((e: unknown) => console.error('new shell failed', e))
  }

  // Pane (x) / Alt+W → confirm → kill the tmux window (and whatever runs
  // in it).
  const [confirmKill, setConfirmKill] = useState<{ target: string; name: string } | null>(null)

  // Workspace shortcuts: Alt+←/Alt+→ cycle terminals left/right — the
  // webapp-level replacement for tmux's prefix bindings (webapp panes run
  // with `prefix None`) — Alt+T opens a new scratch shell, and Alt+W kills
  // the active terminal, through the same confirm dialog as the pane ×
  // (Alt+N, new session, and Alt+D, delete session, live in App's
  // Workspace, which owns project scope). Captured on window so the chord
  // is swallowed before xterm's textarea handler could forward it to the
  // PTY; the ref keeps the single listener reading the current render's
  // state.
  const shortcutCtx = useRef({ sid, targets, activeTab, terminals, openShell })
  shortcutCtx.current = { sid, targets, activeTab, terminals, openShell }
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
        case 'kill-terminal':
          // The agent pane isn't killable — leave the chord alone then.
          if (!ctx.activeTab || ctx.activeTab === 'agent') return
          e.preventDefault()
          e.stopPropagation()
          setConfirmKill({ target: ctx.activeTab, name: paneName(ctx.activeTab, ctx.terminals) })
          return
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
    queryClient.setQueryData<SessionTerminalEntry[]>(
      ['terminals', sid],
      (old) => old?.filter((t) => t.target !== target),
    )
    setSessionLayout(sid, removeLeaf(layout, target))
    setOpened((prev) => prev.filter((k) => k !== `${sid}|${target}`))
    void killSessionTerminal(sid, target)
      .catch((e: unknown) => console.error('kill terminal failed', e))
      .finally(refetchTerminals)
  }

  // --- divider drag ---
  const onDividerDown = (e: ReactPointerEvent, path: string, dir: SplitDir, box: { x: number; y: number; w: number; h: number }): void => {
    e.preventDefault()
    if (!sid) return
    const ws = wsRef.current
    if (!ws) return
    const wsRect = ws.getBoundingClientRect()
    const onMove = (ev: globalThis.PointerEvent): void => {
      const cur = useUiStore.getState()
      const node = sid in cur.layouts ? cur.layouts[sid] : leaf('agent')
      if (!node) return
      const pos = dir === 'row' ? ev.clientX - wsRect.left - box.x : ev.clientY - wsRect.top - box.y
      const total = dir === 'row' ? box.w : box.h
      if (total <= 0) return
      cur.setSessionLayout(sid, setRatioAt(node, path, pos / total))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // --- pane drag (move/rearrange) ---
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  dragRef.current = drag

  const onHeaderDown = (e: ReactPointerEvent, src: string): void => {
    // Buttons inside the header (split/close) handle their own clicks.
    if ((e.target as HTMLElement).closest('button')) return
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
      const py = ev.clientY - wsRect.top
      // Workspace edges win over pane edges: they're the only way to carve
      // out a full-height/width half when no single pane spans the axis.
      const rootEdge = rootEdgeAt(px, py, wsRect.width, wsRect.height)
      let over: DropTarget | undefined
      if (rootEdge) {
        over = { kind: 'root', edge: rootEdge }
      } else {
        const hit = panesRef.current.find((p) =>
          px >= p.rect.x && px <= p.rect.x + p.rect.w && py >= p.rect.y && py <= p.rect.y + p.rect.h)
        if (hit && hit.target !== d.src) {
          over = { kind: 'pane', dest: hit.target, edge: dropEdgeFor(hit.rect, px, py) }
        }
      }
      const next: DragState = { ...d, active, over }
      dragRef.current = next
      setDrag(next)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const d = dragRef.current
      setDrag(null)
      if (!d?.active || !d.over) return
      const cur = useUiStore.getState()
      const node = sid in cur.layouts ? cur.layouts[sid] : leaf('agent')
      if (!node) return
      const moved = d.over.kind === 'root'
        ? moveLeafToRoot(node, d.src, d.over.edge)
        : moveLeaf(node, d.src, d.over.dest, d.over.edge)
      cur.setSessionLayout(sid, moved)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const dropHighlight = drag?.active && drag.over
    ? (() => {
        const over = drag.over
        if (over.kind === 'root') {
          return dropHighlightRect({ x: 0, y: 0, w: wsSize.w, h: wsSize.h }, over.edge)
        }
        const pane = panes.find((p) => p.target === over.dest)
        return pane ? dropHighlightRect(pane.rect, over.edge) : null
      })()
    : null

  return (
    <main className="flex h-full min-w-0 flex-col">
      {/* Slim session bar on the base layer — the panes are the cards. */}
      {creatingHere ? (
        <header className="flex h-8 shrink-0 items-center gap-2.5 px-2 text-xs">
          {/* Only when the sidebar is collapsed — the reopen affordance. When
              open, its toggle lives in the sidebar header (next to +). */}
          {!sidebarOpen && (
            <button
              onClick={toggleSidebar}
              title="Show sidebar"
              aria-label="Show sidebar"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-faint transition
                hover:bg-surface-2 hover:text-text-dim"
            >
              <SidebarIcon size={14} />
            </button>
          )}
          <span className="titlebar-drag min-w-0 flex-1 truncate font-medium text-text-dim">
            {creatingHere.kind === 'restart' ? 'Restarting session' : 'New session'}
          </span>
          <span className="shrink-0 text-[11px] text-text-faint">{TOOL_LABEL[creatingHere.tool]}</span>
        </header>
      ) : session ? (
        <header className="flex h-8 shrink-0 items-center gap-2.5 px-2 text-xs">
          {/* Only when the sidebar is collapsed — the reopen affordance. When
              open, its toggle lives in the sidebar header (next to +). */}
          {!sidebarOpen && (
            <button
              onClick={toggleSidebar}
              title="Show sidebar"
              aria-label="Show sidebar"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-faint transition
                hover:bg-surface-2 hover:text-text-dim"
            >
              <SidebarIcon size={14} />
            </button>
          )}
          <span className="titlebar-drag min-w-0 flex-1 truncate font-medium text-text">
            {session.title || session.prompt || 'New session'}
          </span>
          <button
            onClick={() => setViewMode(tiled ? 'tabs' : 'tiles')}
            title={tiled ? 'Switch to tabs' : 'Switch to tiles'}
            aria-label={tiled ? 'Switch to tabs' : 'Switch to tiles'}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-dim transition
              hover:bg-surface-2 hover:text-text"
          >
            {tiled ? <TabsIcon size={13} /> : <TilesIcon size={13} />}
          </button>
          <button
            onClick={() => openShell()}
            title="New shell"
            aria-label="New shell"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-dim transition
              hover:bg-surface-2 hover:text-text"
          >
            <AddIcon size={14} />
          </button>
          <span className="shrink-0 text-[11px] text-text-faint">{TOOL_LABEL[session.tool]}</span>
          {session.forwardedPorts.length > 0 && (
            <ForwardedPortLinks ports={session.forwardedPorts} iconSize={11} className="hover:bg-surface-2" />
          )}
          {gitAuthFailures.length > 0 && (
            <GitAuthFailureBadge
              failures={gitAuthFailures}
              iconSize={12}
              className="hover:bg-[#d65858]/25"
            />
          )}
          {session.blockedHosts.length > 0 && (
            <BlockedHostsBadge hosts={session.blockedHosts} iconSize={12} className="hover:bg-[#d65858]/25" />
          )}
          <SessionActionsMenu sessionId={session.sessionId} currentTitle={session.title ?? ''} />
        </header>
      ) : (
        <header className="titlebar-drag flex h-8 shrink-0 items-center px-2">
          {/* Only when the sidebar is collapsed — the reopen affordance. When
              open, its toggle lives in the sidebar header (next to +). */}
          {!sidebarOpen && (
            <div className="no-drag">
              <button
                onClick={toggleSidebar}
                title="Show sidebar"
                aria-label="Show sidebar"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-faint transition
                  hover:bg-surface-2 hover:text-text-dim"
              >
                <SidebarIcon size={14} />
              </button>
            </div>
          )}
        </header>
      )}

      {/* `isolate`: the provisioning overlay below is z-30, and without an
          isolating stacking context here it escapes into the root context and
          paints over portaled dropdowns (e.g. "+ New session"). Isolating
          confines its z-index so those popups render above it. */}
      <div ref={wsRef} className="relative isolate min-h-0 flex-1">
        {!session && !creatingHere && (
          <EmptyState
            className="h-full"
            icon={TerminalIcon}
            title="No sessions yet"
            description="Start a coding-agent session and it opens right here."
            action={activeProjectSlug
              ? <NewSessionButton projectSlug={activeProjectSlug} variant="cta" />
              : undefined}
          />
        )}

        {/* Pane cards (chrome) for the selected session — tiles mode. */}
        {session && tiled && panes.map(({ target, rect }) => (
          <section
            key={target}
            style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
            className={clsx(
              'absolute flex flex-col overflow-hidden rounded-lg border border-hairline bg-surface',
              'shadow-[0_8px_24px_var(--shadow-color)]',
              drag?.active && drag.src === target && 'opacity-60',
            )}
          >
            <div
              onPointerDown={(e) => onHeaderDown(e, target)}
              style={{ height: HEADER_H }}
              className="group/pane flex shrink-0 cursor-grab select-none items-center gap-1.5 px-2.5 active:cursor-grabbing"
            >
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-text-dim">
                {paneName(target, terminals)}
              </span>
              <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/pane:opacity-100">
                <button
                  onClick={() => openShell({ target, dir: 'row' })}
                  title="New shell right"
                  aria-label={`New shell right of ${paneName(target, terminals)}`}
                  className="flex h-5 w-5 items-center justify-center rounded text-text-faint transition
                    hover:bg-surface-2 hover:text-text"
                >
                  <SplitRightIcon size={11} />
                </button>
                <button
                  onClick={() => openShell({ target, dir: 'col' })}
                  title="New shell below"
                  aria-label={`New shell below ${paneName(target, terminals)}`}
                  className="flex h-5 w-5 items-center justify-center rounded text-text-faint transition
                    hover:bg-surface-2 hover:text-text"
                >
                  <SplitDownIcon size={11} />
                </button>
                {target !== 'agent' && (
                  <button
                    onClick={() => setConfirmKill({ target, name: paneName(target, terminals) })}
                    title="Kill terminal"
                    aria-label={`Kill ${paneName(target, terminals)}`}
                    className="flex h-5 w-5 items-center justify-center rounded text-text-faint transition
                      hover:bg-surface-2 hover:text-text"
                  >
                    <CloseIcon size={11} />
                  </button>
                )}
              </span>
            </div>
          </section>
        ))}

        {/* Tabs mode: one full-bleed card; the strip switches between the
            same layout-tree leaves the tiles mode arranges spatially. */}
        {session && !tiled && targets.length > 0 && (
          <section className="absolute inset-0 flex flex-col overflow-hidden rounded-lg border
            border-hairline bg-surface shadow-[0_8px_24px_var(--shadow-color)]">
            <div style={{ height: HEADER_H }} className="flex shrink-0 items-center gap-0.5 px-1.5">
              {targets.map((t) => (
                <span key={t} className="group/tab relative flex items-center">
                  <button
                    onClick={() => focusTerminal(session.sessionId, t)}
                    className={clsx(
                      'rounded px-2 py-0.5 text-[11px] transition',
                      t !== 'agent' && 'pr-5',
                      activeTab === t
                        ? 'bg-surface-3 font-medium text-text'
                        : 'text-text-faint hover:text-text-dim',
                    )}
                  >
                    {paneName(t, terminals)}
                  </button>
                  {t !== 'agent' && (
                    <button
                      onClick={() => setConfirmKill({ target: t, name: paneName(t, terminals) })}
                      title={`Kill ${paneName(t, terminals)}`}
                      aria-label={`Kill ${paneName(t, terminals)}`}
                      className="absolute right-0.5 flex h-4 w-4 items-center justify-center rounded
                        text-text-faint opacity-0 transition hover:text-text group-hover/tab:opacity-100"
                    >
                      <CloseIcon size={10} />
                    </button>
                  )}
                </span>
              ))}
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
          const pane = id === sid && tiled ? panes.find((p) => p.target === target) : undefined
          const style = pane
            ? {
                left: pane.rect.x + PAD,
                top: pane.rect.y + HEADER_H,
                width: pane.rect.w - PAD * 2,
                height: pane.rect.h - HEADER_H - PAD,
              }
            : id === sid && !tiled && target === activeTab
              ? {
                  left: PAD,
                  top: HEADER_H,
                  width: wsSize.w - PAD * 2,
                  height: wsSize.h - HEADER_H - PAD,
                }
              : undefined
          return (
            <div
              key={key}
              // The wrapper (bg-bg) mirrors the xterm background exactly, so the
              // padding around the terminal is seamless — both follow the app
              // theme (dark terminal on the dark shell, light on the light one).
              style={style}
              // Keep the active-terminal record in step with focus changes
              // the DOM makes on its own (clicking into a tiled pane), so
              // the cycle shortcut steps from the pane the user is actually
              // in. Re-recording a shortcut-driven focus is a store no-op.
              onFocusCapture={() => useUiStore.getState().setActiveTab(id, target)}
              className={clsx('absolute', !style && 'invisible left-0 top-0 h-full w-full')}
            >
              <div className="h-full w-full overflow-hidden rounded-md bg-bg px-2.5 py-1.5">
                <SessionTerminal
                  key={`${key}:${terminalNonces[id] ?? 0}`}
                  sessionId={id}
                  target={target}
                  focusKey={id === sid && target === focusTarget ? focusNonce : undefined}
                />
              </div>
            </div>
          )
        })}

        {/* Split dividers (drag to resize). */}
        {session && tiled && dividers.map((d) => (
          <div
            key={d.path || 'root'}
            onPointerDown={(e) => onDividerDown(e, d.path, d.dir, d.box)}
            style={{ left: d.rect.x, top: d.rect.y, width: d.rect.w, height: d.rect.h }}
            className={clsx(
              'absolute z-10 flex items-center justify-center',
              d.dir === 'row' ? 'cursor-col-resize' : 'cursor-row-resize',
            )}
          >
            <div className={clsx(
              'rounded-full bg-hairline transition-colors hover:bg-text-faint',
              d.dir === 'row' ? 'h-8 w-1' : 'h-1 w-8',
            )} />
          </div>
        ))}

        {/* Drop highlight while dragging a pane. */}
        {dropHighlight && (
          <div
            style={{ left: dropHighlight.x, top: dropHighlight.y, width: dropHighlight.w, height: dropHighlight.h }}
            className="pointer-events-none absolute z-20 rounded-lg border border-accent/60 bg-accent/15"
          />
        )}

        {/* Provisioning overlay — covers the workspace until ready. Scoped to
            the active project so it can't cover another project's session. */}
        {creatingHere && (
          <div className="absolute inset-0 z-30 bg-base">
            <CreatingPlaceholder creating={creatingHere} />
          </div>
        )}
      </div>

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

