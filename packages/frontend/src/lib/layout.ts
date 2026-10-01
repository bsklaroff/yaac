/**
 * The pane layout of a workspace. The layout (the `PaneLayout` type) is a
 * left-to-right list of equal-width columns; each column is a "window group"
 * of tabbed panes, identified by a target string unique within the
 * workspace. There is no vertical stacking.
 *
 * All operations are pure; callers store the returned layout.
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

/** A workspace's pane layout: left-to-right, equal-width columns. */
export type PaneLayout = WindowGroup[]

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
export function singleColumn(target: string): PaneLayout {
  return [group([target], target)]
}

/** Validate a layout read from localStorage. An empty array is valid. */
export function isPaneLayout(v: unknown): v is PaneLayout {
  if (!Array.isArray(v)) return false
  return v.every((g) => {
    if (!g || typeof g !== 'object') return false
    const n = g as Record<string, unknown>
    if (!Array.isArray(n.tabs) || n.tabs.length === 0) return false
    if (!n.tabs.every((t) => typeof t === 'string' && t.length > 0)) return false
    return typeof n.active === 'string' && n.tabs.includes(n.active)
  })
}

/** All pane targets, column by column, left to right. */
export function paneTargets(ws: PaneLayout): string[] {
  return ws.flatMap((g) => g.tabs)
}

/** Index of the column containing `target`, or -1. */
export function groupIndexOf(ws: PaneLayout, target: string): number {
  return ws.findIndex((g) => g.tabs.includes(target))
}

/** Append `target` as a new single-tab column. Unchanged if the target is
 *  already present. */
export function addColumn(ws: PaneLayout, target: string): PaneLayout {
  if (paneTargets(ws).includes(target)) return ws
  return [...ws, group([target], target)]
}

/**
 * Add `target` as the active tab of the column at `groupIdx`. Unchanged if
 * the target is already present or the index is out of range.
 */
export function addTab(ws: PaneLayout, groupIdx: number, target: string): PaneLayout {
  if (groupIdx < 0 || groupIdx >= ws.length) return ws
  if (paneTargets(ws).includes(target)) return ws
  return ws.map((g, i) => (i === groupIdx ? group([...g.tabs, target], target) : g))
}

/**
 * Remove `target` from its column. An emptied column is dropped; if the
 * removed tab was active, the tab now at its position (clamped) becomes
 * active. The result may be empty.
 */
export function removeTarget(ws: PaneLayout, target: string): PaneLayout {
  if (groupIndexOf(ws, target) === -1) return ws
  const out: PaneLayout = []
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
export function moveTargetToGroup(ws: PaneLayout, src: string, destGroupIdx: number): PaneLayout {
  const gi = groupIndexOf(ws, src)
  if (gi === -1) return ws
  if (destGroupIdx < 0 || destGroupIdx >= ws.length) return ws
  if (gi === destGroupIdx) return ws
  // Find the destination again by its first tab: removing src may drop its
  // old column and shift indices.
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
export function moveTargetToColumn(ws: PaneLayout, src: string, insertIdx: number): PaneLayout {
  const gi = groupIndexOf(ws, src)
  if (gi === -1) return ws
  const alone = ws[gi].tabs.length === 1
  if (alone && (insertIdx === gi || insertIdx === gi + 1)) return ws
  const removed = removeTarget(ws, src)
  // If src was alone, removing it drops its column and shifts later indices.
  const shift = alone && gi < insertIdx ? 1 : 0
  const at = Math.max(0, Math.min(removed.length, insertIdx - shift))
  return [...removed.slice(0, at), group([src], src), ...removed.slice(at)]
}

/**
 * Move the column holding `target` one slot left (`dir` -1) or right
 * (`dir` 1), wrapping at both ends. Used by tiles mode's "move window".
 * Returns the same reference when there's nothing to move.
 */
export function moveColumn(ws: PaneLayout, target: string, dir: 1 | -1): PaneLayout {
  const gi = groupIndexOf(ws, target)
  if (gi === -1 || ws.length < 2) return ws
  const to = (gi + dir + ws.length) % ws.length
  const without = ws.filter((_, i) => i !== gi)
  without.splice(to, 0, ws[gi])
  return without
}

/**
 * Move `target` one slot left (`dir` -1) or right (`dir` 1) in the flat pane
 * strip, wrapping at both ends. Used by tabs mode's "move tab", which shows
 * all panes as one strip. The reordered panes are poured back into columns
 * of the same sizes. Returns the same reference when there's nothing to move.
 */
export function moveTabInStrip(ws: PaneLayout, target: string, dir: 1 | -1): PaneLayout {
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

/**
 * Rewrite every target equal to `from` or under it (`from/…`) to the same
 * place under `to`, for a renamed file or folder. Returns the same reference
 * when nothing changes.
 */
export function renameTargets(ws: PaneLayout, from: string, to: string): PaneLayout {
  const rename = (t: string): string => (
    t === from ? to : t.startsWith(`${from}/`) ? `${to}${t.slice(from.length)}` : t
  )
  if (paneTargets(ws).every((t) => rename(t) === t)) return ws
  return ws.map((g) => group(g.tabs.map(rename), rename(g.active)))
}

/** Make `target` the active tab of its column. No-op if absent or already
 *  active (returns the same reference). */
export function withActive(ws: PaneLayout, target: string): PaneLayout {
  const gi = groupIndexOf(ws, target)
  if (gi === -1 || ws[gi].active === target) return ws
  return ws.map((g, i) => (i === gi ? group(g.tabs, target) : g))
}

/**
 * The pane to focus when a workspace is selected or a shortcut switches
 * panes. `activeTab` is the stored last-active pane and may be stale. Tabs
 * mode uses the active tab, else the first pane; tiles mode prefers the
 * active pane, then the agent, then the first pane. Null when there are no
 * panes.
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
export function computeColumns(ws: PaneLayout, rect: Rect, gap: number): ColumnRect[] {
  if (ws.length === 0) return []
  const n = ws.length
  const w = Math.max(0, (rect.w - gap * (n - 1)) / n)
  return ws.map((g, i) => ({
    group: g,
    rect: { x: rect.x + i * (w + gap), y: rect.y, w, h: rect.h },
  }))
}

/**
 * The drop zone at a horizontal position. The middle half of a column adds
 * the pane as a tab; the outer quarters and the gaps insert a new column.
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
