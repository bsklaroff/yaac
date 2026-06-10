import { useEffect, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Menu } from '@base-ui/react/menu'
import { useUiStore } from '@/frontend/store'
import { SessionTerminal } from '@/frontend/components/SessionTerminal'
import { Pane, PaneHeader, PaneTitle, TerminalBlock } from '@/frontend/components/ui/Pane'
import {
  WorkspaceBar,
  BarIconButton,
  barIconButtonClass,
} from '@/frontend/components/ui/WorkspaceBar'
import { CreatingPlaceholder } from '@/frontend/components/CreatingPlaceholder'
import { AddIcon, BlockedIcon, CloseIcon, SidebarIcon, SplitDownIcon, SplitRightIcon, TabsIcon, TilesIcon } from '@/frontend/lib/icons'
import { getSessionTerminals, closeSessionTerminal, nextShellName } from '@/frontend/lib/terminalsApi'
import {
  computeLayout,
  dropEdgeFor,
  dropHighlightRect,
  leaf,
  leafTargets,
  moveLeaf,
  removeLeaf,
  setRatioAt,
  splitLeaf,
  type DropEdge,
  type LayoutNode,
  type PaneRect,
  type SplitDir,
} from '@/frontend/lib/layout'
import type { DaemonSnapshot, SessionTerminalEntry } from '@/shared/types'

/** Gap between pane cards (the dividers live in it). */
const GAP = 8
/** Pane card header height. */
const HEADER_H = 28
/** Pane card inner padding around the terminal block. */
const PAD = 3
/** Pointer must travel this far before a header-drag becomes a move. */
const DRAG_THRESHOLD = 5

type AddPick = { kind: 'existing'; target: string } | { kind: 'new-shell' }

interface DragState {
  src: string
  startX: number
  startY: number
  active: boolean
  over?: { dest: string; edge: DropEdge }
}

/** A non-terminal pane an embedding view contributes to the workspace —
 *  e.g. the Plan tab's rendered doc. It participates in the layout tree
 *  (split/drag/tab) like any terminal; only its body differs. */
export interface ExtraPane {
  target: string
  name: string
  render: () => ReactNode
  /** Pane-level actions (always visible): rendered in the pane header in
   *  tiles mode and at the end of the tab strip when active in tabs mode. */
  actions?: ReactNode
}

function paneName(
  target: string,
  terminals: SessionTerminalEntry[] | undefined,
  extraPanes?: ExtraPane[],
): string {
  const extra = extraPanes?.find((p) => p.target === target)
  if (extra) return extra.name
  if (target === 'agent') return 'Agent'
  if (target.startsWith('shell:')) return target.slice('shell:'.length)
  const entry = terminals?.find((t) => t.target === target)
  return entry?.name ?? 'window'
}

export function SessionView({
  snapshot,
  sessionIdOverride,
  hideBar = false,
  layoutKey,
  defaultLayout,
  extraPanes = [],
}: {
  snapshot: DaemonSnapshot | undefined
  /** Pin the workspace to a specific session instead of the sidebar
   *  selection (the Plan tab embeds the WM for its grill session). */
  sessionIdOverride?: string
  /** Omit the session bar — the embedding view brings its own. */
  hideBar?: boolean
  /** Store key for the layout tree (defaults to the session id). The Plan
   *  tab namespaces its key so its doc+agent arrangement doesn't leak into
   *  the Build tab's workspace for the same session. */
  layoutKey?: string
  /** Tree to use before the user has arranged anything (default: a single
   *  agent pane). */
  defaultLayout?: LayoutNode
  /** Non-terminal panes contributed by the embedding view. */
  extraPanes?: ExtraPane[]
}): JSX.Element {
  const selectedSessionId = useUiStore((s) => s.selectedSessionId)
  const terminalNonces = useUiStore((s) => s.terminalNonces)
  const layouts = useUiStore((s) => s.layouts)
  const setSessionLayout = useUiStore((s) => s.setSessionLayout)
  const sidebarOpen = useUiStore((s) => s.sidebarOpen)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const viewMode = useUiStore((s) => s.viewMode)
  const setViewMode = useUiStore((s) => s.setViewMode)
  const activeTabs = useUiStore((s) => s.activeTabs)
  const setActiveTab = useUiStore((s) => s.setActiveTab)
  const storeCreating = useUiStore((s) => s.creating)
  // The provisioning placeholder belongs to the Build tab's selection flow;
  // an embedded (pinned) workspace has its own spawn UI.
  const creating = sessionIdOverride ? null : storeCreating
  const queryClient = useQueryClient()
  const sessions = snapshot?.sessions ?? []
  const session = sessions.find((s) => s.sessionId === (sessionIdOverride ?? selectedSessionId))
  const sid = session?.sessionId ?? null
  const lkey = sid ? (layoutKey ?? sid) : null
  const baseLayout = defaultLayout ?? leaf('agent')
  const extraTargets = new Set(extraPanes.map((p) => p.target))

  // The session's workspace tree: missing key = the default tree; null =
  // explicitly emptied.
  const layout: LayoutNode | null = lkey ? (lkey in layouts ? layouts[lkey] : baseLayout) : null

  // The container's terminals beyond the agent (initCommands windows and
  // scratch shells) — powers the add-terminal menus and pane names.
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

  // Tabs mode renders the same layout-tree leaves one at a time; the tree
  // stays canonical so toggling back to tiles restores the arrangement.
  const targets = leafTargets(layout)
  const activeTab = sid
    ? (activeTabs[sid] && targets.includes(activeTabs[sid]) ? activeTabs[sid] : targets[0])
    : undefined
  const tiled = viewMode === 'tiles'
  const { panes, dividers } = computeLayout(layout, { x: 0, y: 0, w: wsSize.w, h: wsSize.h }, GAP)
  const panesRef = useRef<PaneRect[]>(panes)
  panesRef.current = panes

  // Keep-alive: every session|target ever shown stays mounted (hidden) so
  // switching back is instant. Panes closed explicitly are dropped. Extra
  // (non-terminal) panes have no connection to keep alive.
  const [opened, setOpened] = useState<string[]>([])
  useEffect(() => {
    if (!sid || !layout) return
    const keys = leafTargets(layout)
      .filter((t) => !extraTargets.has(t))
      .map((t) => `${sid}|${t}`)
    setOpened((prev) => {
      const fresh = keys.filter((k) => !prev.includes(k))
      return fresh.length ? [...prev, ...fresh] : prev
    })
    // (extraTargets is per-render derived state; sid+layout cover it.)
  }, [sid, layout])

  const liveIds = new Set(sessions.map((s) => s.sessionId))
  const mounted = opened.filter((key) => liveIds.has(key.slice(0, key.indexOf('|'))))

  const refetchTerminals = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['terminals', sid] })
  }

  /** Open a terminal: split `onto` (or the largest pane; or fill an empty
   *  workspace). New shells get the next free name and exist lazily on
   *  first attach. */
  const openTerminal = (pick: AddPick, onto?: { target: string; dir: SplitDir }): void => {
    if (!lkey) return
    const target = pick.kind === 'existing' ? pick.target : `shell:${nextShellName(terminals ?? [])}`
    if (pick.kind === 'new-shell') setTimeout(refetchTerminals, 1000)
    if (!layout) {
      setSessionLayout(lkey, leaf(target))
      return
    }
    if (leafTargets(layout).includes(target)) return
    let anchor = onto?.target
    if (!anchor) {
      const largest = [...panes].sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h)[0]
      anchor = largest?.target ?? leafTargets(layout)[0]
    }
    setSessionLayout(lkey, splitLeaf(layout, anchor, target, onto?.dir ?? 'row'))
  }

  /** Close a pane. Scratch shells are also killed (they're disposable);
   *  agent/window panes just leave the workspace. */
  const closePane = (target: string): void => {
    if (!sid || !lkey || !layout) return
    setSessionLayout(lkey, removeLeaf(layout, target))
    setOpened((prev) => prev.filter((k) => k !== `${sid}|${target}`))
    if (target.startsWith('shell:')) {
      void closeSessionTerminal(sid, target)
        .catch((e: unknown) => console.error('close shell failed', e))
        .finally(refetchTerminals)
    }
  }

  // --- divider drag ---
  const onDividerDown = (e: ReactPointerEvent, path: string, dir: SplitDir, box: { x: number; y: number; w: number; h: number }): void => {
    e.preventDefault()
    if (!lkey) return
    const ws = wsRef.current
    if (!ws) return
    const wsRect = ws.getBoundingClientRect()
    const onMove = (ev: globalThis.PointerEvent): void => {
      const cur = useUiStore.getState()
      const node = lkey in cur.layouts ? cur.layouts[lkey] : baseLayout
      if (!node) return
      const pos = dir === 'row' ? ev.clientX - wsRect.left - box.x : ev.clientY - wsRect.top - box.y
      const total = dir === 'row' ? box.w : box.h
      if (total <= 0) return
      cur.setSessionLayout(lkey, setRatioAt(node, path, pos / total))
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
    if (!lkey) return
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
      const hit = panesRef.current.find((p) =>
        px >= p.rect.x && px <= p.rect.x + p.rect.w && py >= p.rect.y && py <= p.rect.y + p.rect.h)
      const over = hit && hit.target !== d.src
        ? { dest: hit.target, edge: dropEdgeFor(hit.rect, px, py) }
        : undefined
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
      const node = lkey in cur.layouts ? cur.layouts[lkey] : baseLayout
      if (!node) return
      cur.setSessionLayout(lkey, moveLeaf(node, d.src, d.over.dest, d.over.edge))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Items offered by the add-terminal menus: anything not already open.
  const openTargets = new Set(layout ? leafTargets(layout) : [])
  const addItems: { target: string; name: string }[] = [
    ...extraPanes
      .filter((p) => !openTargets.has(p.target))
      .map((p) => ({ target: p.target, name: p.name })),
    ...(!openTargets.has('agent') && session ? [{ target: 'agent', name: 'Agent' }] : []),
    ...(terminals ?? [])
      .filter((t) => !openTargets.has(t.target))
      .map((t) => ({ target: t.target, name: t.name })),
  ]

  const dropHighlight = drag?.active && drag.over
    ? (() => {
        const pane = panes.find((p) => p.target === drag.over!.dest)
        return pane ? dropHighlightRect(pane.rect, drag.over.edge) : null
      })()
    : null

  return (
    <main className="flex h-full min-w-0 flex-col">
      {/* Slim session bar on the base layer — the panes are the cards. */}
      {hideBar ? null : creating ? (
        <WorkspaceBar>
          {!sidebarOpen && (
            <BarIconButton title="Open sidebar" onClick={toggleSidebar}>
              <SidebarIcon size={14} />
            </BarIconButton>
          )}
          <span className="flex-1" />
        </WorkspaceBar>
      ) : session ? (
        <WorkspaceBar>
          {!sidebarOpen && (
            <BarIconButton title="Open sidebar" onClick={toggleSidebar}>
              <SidebarIcon size={14} />
            </BarIconButton>
          )}
          {/* No title/tool here — the sidebar already names the selected
              session; the bar is just workspace controls. */}
          <span className="flex-1" />
          <BarIconButton
            tone="dim"
            title={tiled ? 'Switch to tabs' : 'Switch to tiles'}
            onClick={() => setViewMode(tiled ? 'tabs' : 'tiles')}
          >
            {tiled ? <TabsIcon size={13} /> : <TilesIcon size={13} />}
          </BarIconButton>
          <AddTerminalMenu
            items={addItems}
            onPick={(pick) => openTerminal(pick)}
            trigger={
              <Menu.Trigger
                title="Add terminal"
                aria-label="Add terminal"
                className={clsx(
                  barIconButtonClass('dim'),
                  'data-[popup-open]:bg-surface-2 data-[popup-open]:text-text',
                )}
              >
                <AddIcon size={14} />
              </Menu.Trigger>
            }
          />
          {session.blockedHosts.length > 0 && (
            <span
              className="flex shrink-0 items-center gap-0.5 text-xs text-[#d65858]"
              title={session.blockedHosts.join('\n')}
            >
              <BlockedIcon size={12} />
              {session.blockedHosts.length}
            </span>
          )}
        </WorkspaceBar>
      ) : (
        <WorkspaceBar>
          {!sidebarOpen && (
            <BarIconButton title="Open sidebar" onClick={toggleSidebar}>
              <SidebarIcon size={14} />
            </BarIconButton>
          )}
        </WorkspaceBar>
      )}

      <div ref={wsRef} className="relative min-h-0 flex-1">
        {!session && !creating && (
          <div className="flex h-full items-center justify-center text-text-faint">No sessions yet</div>
        )}

        {/* Pane cards (chrome) for the selected session — tiles mode. */}
        {session && tiled && panes.map(({ target, rect }) => (
          <Pane
            key={target}
            style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
            className={clsx('absolute', drag?.active && drag.src === target && 'opacity-60')}
          >
            <PaneHeader
              onPointerDown={(e) => onHeaderDown(e, target)}
              className="group/pane cursor-grab select-none active:cursor-grabbing"
            >
              <PaneTitle>{paneName(target, terminals, extraPanes)}</PaneTitle>
              {/* Hover-revealed WM controls sit left of the always-visible
                  pane actions, so the actions stay anchored at the edge. */}
              <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/pane:opacity-100">
                <AddTerminalMenu
                  items={addItems}
                  onPick={(pick) => openTerminal(pick, { target, dir: 'row' })}
                  trigger={
                    <Menu.Trigger
                      title="Split right"
                      aria-label={`Split ${paneName(target, terminals, extraPanes)} right`}
                      className="flex h-5 w-5 items-center justify-center rounded text-text-faint transition
                        hover:bg-surface-2 hover:text-text"
                    >
                      <SplitRightIcon size={11} />
                    </Menu.Trigger>
                  }
                />
                <AddTerminalMenu
                  items={addItems}
                  onPick={(pick) => openTerminal(pick, { target, dir: 'col' })}
                  trigger={
                    <Menu.Trigger
                      title="Split down"
                      aria-label={`Split ${paneName(target, terminals, extraPanes)} down`}
                      className="flex h-5 w-5 items-center justify-center rounded text-text-faint transition
                        hover:bg-surface-2 hover:text-text"
                    >
                      <SplitDownIcon size={11} />
                    </Menu.Trigger>
                  }
                />
                <button
                  onClick={() => closePane(target)}
                  title="Close pane"
                  aria-label={`Close ${paneName(target, terminals, extraPanes)}`}
                  className="flex h-5 w-5 items-center justify-center rounded text-text-faint transition
                    hover:bg-surface-2 hover:text-text"
                >
                  <CloseIcon size={11} />
                </button>
              </span>
              {extraPanes.find((p) => p.target === target)?.actions}
            </PaneHeader>
            {/* Non-terminal panes render their body in the card itself;
                terminal bodies are the kept-alive overlays below. */}
            {extraTargets.has(target) && (
              <div className="min-h-0 flex-1 overflow-hidden">
                {extraPanes.find((p) => p.target === target)?.render()}
              </div>
            )}
          </Pane>
        ))}

        {/* Tabs mode: one full-bleed card; the strip switches between the
            same layout-tree leaves the tiles mode arranges spatially. */}
        {session && !tiled && targets.length > 0 && (
          <Pane className="absolute inset-0">
            <PaneHeader padded={false} className="gap-0.5 px-1.5">
              {targets.map((t) => (
                <span key={t} className="group/tab relative flex items-center">
                  <button
                    onClick={() => setActiveTab(session.sessionId, t)}
                    className={clsx(
                      // font-medium on every state: weight only on the active
                      // tab changes the text width and makes the strip jump.
                      'rounded px-2 py-0.5 pr-5 text-[11px] font-medium transition',
                      activeTab === t
                        ? 'bg-surface-3 text-text'
                        : 'text-text-faint hover:text-text-dim',
                    )}
                  >
                    {paneName(t, terminals, extraPanes)}
                  </button>
                  <button
                    onClick={() => closePane(t)}
                    title={`Close ${paneName(t, terminals, extraPanes)}`}
                    aria-label={`Close ${paneName(t, terminals, extraPanes)}`}
                    className="absolute right-0.5 flex h-4 w-4 items-center justify-center rounded
                      text-text-faint opacity-0 transition hover:text-text group-hover/tab:opacity-100"
                  >
                    <CloseIcon size={10} />
                  </button>
                </span>
              ))}
              <AddTerminalMenu
                items={addItems}
                onPick={(pick) => openTerminal(pick)}
                trigger={
                  <Menu.Trigger
                    title="Add terminal"
                    aria-label="Add terminal tab"
                    className="flex h-5 w-5 items-center justify-center rounded text-text-faint transition
                      hover:bg-surface-2 hover:text-text"
                  >
                    <AddIcon size={12} />
                  </Menu.Trigger>
                }
              />
              {activeTab && (
                <span className="ml-auto flex shrink-0 items-center pr-1">
                  {extraPanes.find((p) => p.target === activeTab)?.actions}
                </span>
              )}
            </PaneHeader>
            {activeTab && extraTargets.has(activeTab) && (
              <div className="min-h-0 flex-1 overflow-hidden">
                {extraPanes.find((p) => p.target === activeTab)?.render()}
              </div>
            )}
          </Pane>
        )}

        {/* Empty workspace: offer to add the first terminal. */}
        {session && !creating && panes.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <AddTerminalMenu
              items={addItems}
              onPick={(pick) => openTerminal(pick)}
              trigger={
                <Menu.Trigger className="flex items-center gap-1.5 rounded-md bg-surface px-3 py-1.5 text-xs
                  text-text-dim transition hover:text-text">
                  <AddIcon size={13} />
                  Add terminal
                </Menu.Trigger>
              }
            />
          </div>
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
              style={style}
              className={clsx('absolute', !style && 'invisible left-0 top-0 h-full w-full')}
            >
              <TerminalBlock>
                <SessionTerminal key={`${key}:${terminalNonces[id] ?? 0}`} sessionId={id} target={target} />
              </TerminalBlock>
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
              'rounded-full bg-white/[0.06] transition-colors hover:bg-white/25',
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

        {/* Provisioning overlay — covers the workspace until ready. */}
        {creating && (
          <div className="absolute inset-0 z-30 bg-base">
            <CreatingPlaceholder creating={creating} />
          </div>
        )}
      </div>
    </main>
  )
}

/** Menu of terminals that can be opened (plus a fresh shell). */
function AddTerminalMenu({
  items,
  onPick,
  trigger,
}: {
  items: { target: string; name: string }[]
  onPick: (pick: AddPick) => void
  trigger: ReactNode
}): JSX.Element {
  const ITEM = 'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-xs outline-none ' +
    'text-text-dim data-[highlighted]:bg-surface-3 data-[highlighted]:text-text'
  return (
    <Menu.Root>
      {trigger}
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={6}>
          <Menu.Popup className="min-w-[160px] rounded-lg border border-border bg-surface-2 p-1 text-text
            shadow-[0_12px_32px_rgba(0,0,0,0.5)] outline-none transition-opacity duration-100
            data-[starting-style]:opacity-0 data-[ending-style]:opacity-0">
            {items.map((i) => (
              <Menu.Item key={i.target} className={ITEM} onClick={() => onPick({ kind: 'existing', target: i.target })}>
                {i.name}
              </Menu.Item>
            ))}
            {items.length > 0 && <Menu.Separator className="my-1 h-px bg-border" />}
            <Menu.Item className={ITEM} onClick={() => onPick({ kind: 'new-shell' })}>
              <AddIcon size={12} />
              New shell
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
