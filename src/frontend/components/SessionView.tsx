import { useEffect, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Menu } from '@base-ui/react/menu'
import { useUiStore } from '@/frontend/store'
import { SessionTerminal } from '@/frontend/components/SessionTerminal'
import { SessionActionsMenu } from '@/frontend/components/SessionActionsMenu'
import { CreatingPlaceholder } from '@/frontend/components/CreatingPlaceholder'
import { AddIcon, BlockedIcon, CloseIcon, SidebarIcon, SplitDownIcon, SplitRightIcon, TOOL_LABEL } from '@/frontend/lib/icons'
import { getSessionTerminals, closeSessionTerminal, nextShellName } from '@/frontend/lib/terminalsApi'
import {
  computeLayout,
  dropEdgeFor,
  dropHighlightRect,
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
import type { DaemonSnapshot, SessionTerminalEntry } from '@/shared/types'

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

type AddPick = { kind: 'existing'; target: string } | { kind: 'new-shell' }

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
  if (target.startsWith('shell:')) return target.slice('shell:'.length)
  const entry = terminals?.find((t) => t.target === target)
  return entry?.name ?? 'window'
}

export function SessionView({ snapshot }: { snapshot: DaemonSnapshot | undefined }): JSX.Element {
  const selectedSessionId = useUiStore((s) => s.selectedSessionId)
  const terminalNonces = useUiStore((s) => s.terminalNonces)
  const layouts = useUiStore((s) => s.layouts)
  const setSessionLayout = useUiStore((s) => s.setSessionLayout)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const creating = useUiStore((s) => s.creating)
  const queryClient = useQueryClient()
  const sessions = snapshot?.sessions ?? []
  const session = sessions.find((s) => s.sessionId === selectedSessionId)
  const sid = session?.sessionId ?? null

  // The session's workspace tree: missing key = the default single agent
  // pane; null = explicitly emptied.
  const layout: LayoutNode | null = sid ? (sid in layouts ? layouts[sid] : leaf('agent')) : null

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

  /** Open a terminal: split `onto` (or the largest pane; or fill an empty
   *  workspace). New shells get the next free name and exist lazily on
   *  first attach. */
  const openTerminal = (pick: AddPick, onto?: { target: string; dir: SplitDir }): void => {
    if (!sid) return
    const target = pick.kind === 'existing' ? pick.target : `shell:${nextShellName(terminals ?? [])}`
    if (pick.kind === 'new-shell') setTimeout(refetchTerminals, 1000)
    if (!layout) {
      setSessionLayout(sid, leaf(target))
      return
    }
    if (leafTargets(layout).includes(target)) return
    let anchor = onto?.target
    if (!anchor) {
      const largest = [...panes].sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h)[0]
      anchor = largest?.target ?? leafTargets(layout)[0]
    }
    setSessionLayout(sid, splitLeaf(layout, anchor, target, onto?.dir ?? 'row'))
  }

  /** Close a pane. Scratch shells are also killed (they're disposable);
   *  agent/window panes just leave the workspace. */
  const closePane = (target: string): void => {
    if (!sid || !layout) return
    setSessionLayout(sid, removeLeaf(layout, target))
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

  // Items offered by the add-terminal menus: anything not already open.
  const openTargets = new Set(layout ? leafTargets(layout) : [])
  const addItems: { target: string; name: string }[] = [
    ...(!openTargets.has('agent') && session ? [{ target: 'agent', name: 'Agent' }] : []),
    ...(terminals ?? [])
      .filter((t) => !openTargets.has(t.target))
      .map((t) => ({ target: t.target, name: t.name })),
  ]

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
      {creating ? (
        <header className="flex h-8 shrink-0 items-center gap-2.5 px-2 text-xs">
          <button
            onClick={toggleSidebar}
            title="Toggle sidebar"
            aria-label="Toggle sidebar"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-faint transition
              hover:bg-surface-2 hover:text-text-dim"
          >
            <SidebarIcon size={14} />
          </button>
          <span className="min-w-0 flex-1 truncate font-medium text-text-dim">New session</span>
          <span className="shrink-0 text-[11px] text-text-faint">{TOOL_LABEL[creating.tool]}</span>
        </header>
      ) : session ? (
        <header className="flex h-8 shrink-0 items-center gap-2.5 px-2 text-xs">
          <button
            onClick={toggleSidebar}
            title="Toggle sidebar"
            aria-label="Toggle sidebar"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-faint transition
              hover:bg-surface-2 hover:text-text-dim"
          >
            <SidebarIcon size={14} />
          </button>
          <span className="min-w-0 flex-1 truncate font-medium text-text">
            {session.title || session.prompt || 'New session'}
          </span>
          <AddTerminalMenu
            items={addItems}
            onPick={(pick) => openTerminal(pick)}
            trigger={
              <Menu.Trigger
                title="Add terminal"
                aria-label="Add terminal"
                className="flex h-6 w-6 items-center justify-center rounded text-text-dim transition
                  hover:bg-surface-2 hover:text-text data-[popup-open]:bg-surface-2 data-[popup-open]:text-text"
              >
                <AddIcon size={14} />
              </Menu.Trigger>
            }
          />
          <span className="shrink-0 text-[11px] text-text-faint">{TOOL_LABEL[session.tool]}</span>
          {session.blockedHosts.length > 0 && (
            <span
              className="flex shrink-0 items-center gap-0.5 text-xs text-[#d65858]"
              title={session.blockedHosts.join('\n')}
            >
              <BlockedIcon size={12} />
              {session.blockedHosts.length}
            </span>
          )}
          <SessionActionsMenu sessionId={session.sessionId} currentTitle={session.title ?? ''} />
        </header>
      ) : (
        <header className="flex h-8 shrink-0 items-center px-2">
          <button
            onClick={toggleSidebar}
            title="Toggle sidebar"
            aria-label="Toggle sidebar"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-faint transition
              hover:bg-surface-2 hover:text-text-dim"
          >
            <SidebarIcon size={14} />
          </button>
        </header>
      )}

      <div ref={wsRef} className="relative min-h-0 flex-1">
        {!session && !creating && (
          <div className="flex h-full items-center justify-center text-text-faint">No sessions yet</div>
        )}

        {/* Pane cards (chrome) for the selected session. */}
        {session && panes.map(({ target, rect }) => (
          <section
            key={target}
            style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
            className={clsx(
              'absolute flex flex-col overflow-hidden rounded-lg border border-white/[0.06] bg-surface',
              'shadow-[0_8px_24px_rgba(0,0,0,0.45)]',
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
                <AddTerminalMenu
                  items={addItems}
                  onPick={(pick) => openTerminal(pick, { target, dir: 'row' })}
                  trigger={
                    <Menu.Trigger
                      title="Split right"
                      aria-label={`Split ${paneName(target, terminals)} right`}
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
                      aria-label={`Split ${paneName(target, terminals)} down`}
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
                  aria-label={`Close ${paneName(target, terminals)}`}
                  className="flex h-5 w-5 items-center justify-center rounded text-text-faint transition
                    hover:bg-surface-2 hover:text-text"
                >
                  <CloseIcon size={11} />
                </button>
              </span>
            </div>
          </section>
        ))}

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
          const pane = id === sid ? panes.find((p) => p.target === target) : undefined
          const style = pane
            ? {
                left: pane.rect.x + PAD,
                top: pane.rect.y + HEADER_H,
                width: pane.rect.w - PAD * 2,
                height: pane.rect.h - HEADER_H - PAD,
              }
            : undefined
          return (
            <div
              key={key}
              style={style}
              className={clsx('absolute', !style && 'invisible left-0 top-0 h-full w-full')}
            >
              <div className="h-full w-full overflow-hidden rounded-md bg-bg px-2.5 py-1.5">
                <SessionTerminal key={`${key}:${terminalNonces[id] ?? 0}`} sessionId={id} target={target} />
              </div>
            </div>
          )
        })}

        {/* Split dividers (drag to resize). */}
        {session && dividers.map((d) => (
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
