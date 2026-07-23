/**
 * Workspace layout for a session's terminals. In full-window (tiles) mode the
 * workspace is a flat, left-to-right list of equal-width columns; each column
 * is a "window group" holding one or more tabbed panes (identified by their
 * /pty/attach target — unique per session). There is no vertical stacking:
 * panes sit side by side as columns, and multiple panes in one slot are tabs.
 *
 * All operations are pure — callers store the returned workspace.
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** A window group: an equal-width column holding one or more tabbed panes.
 *  `active` is the visible tab and is always a member of `tabs`. */
export interface WindowGroup {
  tabs: string[]
  active: string
}

/** A session workspace: left-to-right, equal-width columns. */
export type Workspace = WindowGroup[]

/** A column with the pixel rect it occupies. */
export interface ColumnRect {
  group: WindowGroup
  rect: Rect
}

/** Where a dragged pane would land: as a tab of column `group`, or as a new
 *  column inserted at `index` (0..columns.length). */
export type DropTarget =
  | { kind: 'tab'; group: number }
  | { kind: 'column'; index: number }

function group(tabs: string[], active: string): WindowGroup {
  return { tabs, active }
}

/** The default single-column workspace showing one pane. */
export function singleColumn(target: string): Workspace {
  return [group([target], target)]
}

/** Structural validation for workspaces from untrusted storage (localStorage).
 *  An empty array (an explicitly emptied workspace) is valid. */
export function isWorkspace(v: unknown): v is Workspace {
  if (!Array.isArray(v)) return false
  return v.every((g) => {
    if (!g || typeof g !== 'object') return false
    const n = g as Record<string, unknown>
    if (!Array.isArray(n.tabs) || n.tabs.length === 0) return false
    if (!n.tabs.every((t) => typeof t === 'string' && t.length > 0)) return false
    return typeof n.active === 'string' && n.tabs.includes(n.active)
  })
}

/** All pane targets in the workspace, left-to-right, top tab first. */
export function paneTargets(ws: Workspace | null): string[] {
  if (!ws) return []
  return ws.flatMap((g) => g.tabs)
}

/** Index of the column containing `target`, or -1. */
export function groupIndexOf(ws: Workspace | null, target: string): number {
  if (!ws) return -1
  return ws.findIndex((g) => g.tabs.includes(target))
}

/**
 * Append `target` as a new single-tab column. A workspace already containing
 * the target (in any column) is returned unchanged; a null base starts fresh.
 */
export function addColumn(ws: Workspace | null, target: string): Workspace {
  const base = ws ?? []
  if (paneTargets(base).includes(target)) return base
  return [...base, group([target], target)]
}

/**
 * Add `target` as a new (active) tab of the column at `groupIdx`. A workspace
 * already containing the target anywhere, or an out-of-range index, is
 * returned unchanged.
 */
export function addTab(ws: Workspace, groupIdx: number, target: string): Workspace {
  if (groupIdx < 0 || groupIdx >= ws.length) return ws
  if (paneTargets(ws).includes(target)) return ws
  return ws.map((g, i) => (i === groupIdx ? group([...g.tabs, target], target) : g))
}

/**
 * Remove `target` from whatever column holds it. A column emptied by the
 * removal drops out; if the removed tab was that column's active one, the tab
 * at the same position (clamped) becomes active. Returns the (possibly empty)
 * workspace.
 */
export function removeTarget(ws: Workspace | null, target: string): Workspace {
  if (!ws) return []
  if (groupIndexOf(ws, target) === -1) return ws
  const out: Workspace = []
  for (const g of ws) {
    if (!g.tabs.includes(target)) {
      out.push(g)
      continue
    }
    const idx = g.tabs.indexOf(target)
    const tabs = g.tabs.filter((t) => t !== target)
    if (tabs.length === 0) continue
    const active = g.active === target ? tabs[Math.min(idx, tabs.length - 1)] : g.active
    out.push(group(tabs, active))
  }
  return out
}

/**
 * Move the `src` pane out of its column and append it as the active tab of the
 * column at `destGroupIdx` (indexed into the current `ws`). A no-op when `src`
 * is missing or already a tab of the destination column.
 */
export function moveTargetToGroup(ws: Workspace, src: string, destGroupIdx: number): Workspace {
  const gi = groupIndexOf(ws, src)
  if (gi === -1) return ws
  if (destGroupIdx < 0 || destGroupIdx >= ws.length) return ws
  if (gi === destGroupIdx) return ws
  // Identify the destination by a stable member — removeTarget may drop src's
  // old column and shift indices, but never touches the destination column.
  const destFirst = ws[destGroupIdx].tabs[0]
  const removed = removeTarget(ws, src)
  const destIdx = groupIndexOf(removed, destFirst)
  if (destIdx === -1) return ws
  return removed.map((g, i) => (i === destIdx ? group([...g.tabs, src], src) : g))
}

/**
 * Move the `src` pane into its own new column at `insertIdx` (an index into
 * the current column list, 0..ws.length). Pulls it out of its old column
 * first. A no-op when `src` already sits alone in a column at that position.
 */
export function moveTargetToColumn(ws: Workspace, src: string, insertIdx: number): Workspace {
  const gi = groupIndexOf(ws, src)
  if (gi === -1) return ws
  const alone = ws[gi].tabs.length === 1
  if (alone && (insertIdx === gi || insertIdx === gi + 1)) return ws
  const removed = removeTarget(ws, src)
  // Removing src collapses its old column only when it was alone; that shifts
  // every later index (including the insertion point) one to the left.
  const shift = alone && gi < insertIdx ? 1 : 0
  const at = Math.max(0, Math.min(removed.length, insertIdx - shift))
  return [...removed.slice(0, at), group([src], src), ...removed.slice(at)]
}

/**
 * Move the whole column holding `target` one slot left (`dir` -1) or right
 * (`dir` 1) among the columns, wrapping around at both ends. This is the
 * tiles-mode "move window" primitive. Returns the same reference when there's
 * nothing to move (fewer than two columns, or an unknown target).
 */
export function moveColumn(ws: Workspace, target: string, dir: 1 | -1): Workspace {
  const gi = groupIndexOf(ws, target)
  if (gi === -1 || ws.length < 2) return ws
  const to = (gi + dir + ws.length) % ws.length
  const without = ws.filter((_, i) => i !== gi)
  without.splice(to, 0, ws[gi])
  return without
}

/**
 * Move `target` one slot left (`dir` -1) or right (`dir` 1) within the flat
 * left-to-right pane strip, wrapping around at both ends — the tabs-mode "move
 * tab" primitive, where the workspace renders as one strip regardless of its
 * columns. The reordered strip is refilled back into the existing columns
 * preserving each column's size, so the column count stays stable (only which
 * panes land in which column shifts). Returns the same reference when there's
 * nothing to move (fewer than two panes, or an unknown target).
 */
export function moveTabInStrip(ws: Workspace, target: string, dir: 1 | -1): Workspace {
  const flat = paneTargets(ws)
  const from = flat.indexOf(target)
  if (from === -1 || flat.length < 2) return ws
  const to = (from + dir + flat.length) % flat.length
  const without = flat.filter((_, i) => i !== from)
  without.splice(to, 0, target)
  let i = 0
  return ws.map((g) => {
    const tabs = without.slice(i, i + g.tabs.length)
    i += g.tabs.length
    return group(tabs, tabs.includes(g.active) ? g.active : tabs[0])
  })
}

/** Make `target` the active tab of its column. No-op if absent or already
 *  active (returns the same reference). */
export function withActive(ws: Workspace | null, target: string): Workspace {
  if (!ws) return []
  const gi = groupIndexOf(ws, target)
  if (gi === -1 || ws[gi].active === target) return ws
  return ws.map((g, i) => (i === gi ? group(g.tabs, target) : g))
}

/**
 * The pane keyboard focus should land in when a session becomes selected or a
 * shortcut switches terminals. `activeTab` is the session's last-active
 * terminal as stored (possibly stale — validated here). Tabs mode shows one
 * pane at a time, so the visible tab wins; tiles mode shows every column, so
 * prefer the last-active pane, then the agent (the one you talk to), then the
 * first pane. Null when the session has no panes.
 */
export function focusPaneTarget(
  targets: string[],
  activeTab: string | undefined,
  tiled: boolean,
): string | null {
  const active = activeTab && targets.includes(activeTab) ? activeTab : undefined
  if (!tiled) return active ?? targets[0] ?? null
  if (active) return active
  if (targets.includes('agent')) return 'agent'
  return targets[0] ?? null
}

/** Partition `rect` into equal-width columns, leaving `gap` px between them. */
export function computeColumns(ws: Workspace | null, rect: Rect, gap: number): ColumnRect[] {
  if (!ws || ws.length === 0) return []
  const n = ws.length
  const w = Math.max(0, (rect.w - gap * (n - 1)) / n)
  return ws.map((g, i) => ({
    group: g,
    rect: { x: rect.x + i * (w + gap), y: rect.y, w, h: rect.h },
  }))
}

/**
 * Which drop zone a horizontal position falls in over a laid-out column list:
 * the central band of a column tabs the pane into it; the outer thirds (and
 * the gaps/edges between columns) insert it as a new column at that index.
 */
export function dropTargetAt(cols: ColumnRect[], px: number): DropTarget {
  for (let i = 0; i < cols.length; i++) {
    const r = cols[i].rect
    if (px < r.x) return { kind: 'column', index: i }
    if (px <= r.x + r.w) {
      const rel = r.w > 0 ? (px - r.x) / r.w : 0.5
      if (rel < 0.25) return { kind: 'column', index: i }
      if (rel > 0.75) return { kind: 'column', index: i + 1 }
      return { kind: 'tab', group: i }
    }
  }
  return { kind: 'column', index: cols.length }
}
