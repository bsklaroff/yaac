/**
 * Tiling layout tree for a session's terminal workspace. A layout is a
 * binary tree: leaves are terminal panes (identified by their /pty/attach
 * target — unique per session), splits divide space horizontally ('row':
 * panes side by side) or vertically ('col': stacked).
 *
 * All operations are pure — callers store the returned tree.
 */

export type SplitDir = 'row' | 'col'

export type LayoutNode =
  | { type: 'leaf'; target: string }
  | { type: 'split'; dir: SplitDir; ratio: number; a: LayoutNode; b: LayoutNode }

export type DropEdge = 'left' | 'right' | 'top' | 'bottom' | 'center'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface PaneRect {
  target: string
  rect: Rect
}

export interface DividerRect {
  /** Path to the split node from the root: '' = root, then 'a'/'b' steps. */
  path: string
  dir: SplitDir
  /** The divider's own hit area (the gap between the two child rects). */
  rect: Rect
  /** The split node's full box — drags compute the new ratio against it. */
  box: Rect
}

export function leaf(target: string): LayoutNode {
  return { type: 'leaf', target }
}

/** Structural validation for trees from untrusted storage (localStorage). */
export function isLayoutNode(v: unknown): v is LayoutNode {
  if (!v || typeof v !== 'object') return false
  const n = v as Record<string, unknown>
  if (n.type === 'leaf') return typeof n.target === 'string' && n.target.length > 0
  if (n.type === 'split') {
    return (n.dir === 'row' || n.dir === 'col')
      && typeof n.ratio === 'number' && n.ratio > 0 && n.ratio < 1
      && isLayoutNode(n.a) && isLayoutNode(n.b)
  }
  return false
}

/** All pane targets in the tree, left-to-right. */
export function leafTargets(node: LayoutNode | null): string[] {
  if (!node) return []
  if (node.type === 'leaf') return [node.target]
  return [...leafTargets(node.a), ...leafTargets(node.b)]
}

const clampRatio = (r: number): number => Math.min(0.9, Math.max(0.1, r))

/**
 * Split the leaf showing `ontoTarget` in two, placing `newTarget` after
 * (right/below) or before it. Returns the tree unchanged if `ontoTarget`
 * isn't present or `newTarget` already is.
 */
export function splitLeaf(
  node: LayoutNode,
  ontoTarget: string,
  newTarget: string,
  dir: SplitDir,
  after = true,
): LayoutNode {
  if (leafTargets(node).includes(newTarget)) return node
  const walk = (n: LayoutNode): LayoutNode => {
    if (n.type === 'leaf') {
      if (n.target !== ontoTarget) return n
      const fresh = leaf(newTarget)
      return { type: 'split', dir, ratio: 0.5, a: after ? n : fresh, b: after ? fresh : n }
    }
    return { ...n, a: walk(n.a), b: walk(n.b) }
  }
  return walk(node)
}

/** Remove the leaf showing `target`; its sibling takes the split's place.
 *  Removing the only leaf yields null (an empty workspace). */
export function removeLeaf(node: LayoutNode, target: string): LayoutNode | null {
  if (node.type === 'leaf') return node.target === target ? null : node
  const a = removeLeaf(node.a, target)
  const b = removeLeaf(node.b, target)
  if (a === node.a && b === node.b) return node
  if (!a) return b
  if (!b) return a
  return { ...node, a, b }
}

/** Swap the positions of two leaves. */
export function swapLeaves(node: LayoutNode, t1: string, t2: string): LayoutNode {
  if (t1 === t2) return node
  const walk = (n: LayoutNode): LayoutNode => {
    if (n.type === 'leaf') {
      if (n.target === t1) return leaf(t2)
      if (n.target === t2) return leaf(t1)
      return n
    }
    return { ...n, a: walk(n.a), b: walk(n.b) }
  }
  return walk(node)
}

/** Set a split's ratio by its path ('' = root, then 'a'/'b' steps). */
export function setRatioAt(node: LayoutNode, path: string, ratio: number): LayoutNode {
  if (node.type !== 'split') return node
  if (path === '') return { ...node, ratio: clampRatio(ratio) }
  const step = path[0]
  const rest = path.slice(1)
  if (step === 'a') return { ...node, a: setRatioAt(node.a, rest, ratio) }
  if (step === 'b') return { ...node, b: setRatioAt(node.b, rest, ratio) }
  return node
}

/**
 * Move the `src` pane onto the `dest` pane: dropping on an edge re-splits
 * dest in that direction; dropping on the center swaps the two panes.
 */
export function moveLeaf(node: LayoutNode, src: string, dest: string, edge: DropEdge): LayoutNode {
  if (src === dest) return node
  const targets = leafTargets(node)
  if (!targets.includes(src) || !targets.includes(dest)) return node
  if (edge === 'center') return swapLeaves(node, src, dest)
  const without = removeLeaf(node, src)
  if (!without) return node
  const dir: SplitDir = edge === 'left' || edge === 'right' ? 'row' : 'col'
  const after = edge === 'right' || edge === 'bottom'
  return splitLeaf(without, dest, src, dir, after)
}

/** Partition `rect` by the tree, leaving `gap` px between panes. Returns
 *  every pane's rect and every divider's hit area. */
export function computeLayout(
  node: LayoutNode | null,
  rect: Rect,
  gap: number,
): { panes: PaneRect[]; dividers: DividerRect[] } {
  const panes: PaneRect[] = []
  const dividers: DividerRect[] = []
  if (!node) return { panes, dividers }

  const walk = (n: LayoutNode, r: Rect, path: string): void => {
    if (n.type === 'leaf') {
      panes.push({ target: n.target, rect: r })
      return
    }
    if (n.dir === 'row') {
      const aw = Math.max(0, r.w * n.ratio - gap / 2)
      const bw = Math.max(0, r.w * (1 - n.ratio) - gap / 2)
      walk(n.a, { x: r.x, y: r.y, w: aw, h: r.h }, path + 'a')
      walk(n.b, { x: r.x + aw + gap, y: r.y, w: bw, h: r.h }, path + 'b')
      dividers.push({ path, dir: 'row', rect: { x: r.x + aw, y: r.y, w: gap, h: r.h }, box: r })
    } else {
      const ah = Math.max(0, r.h * n.ratio - gap / 2)
      const bh = Math.max(0, r.h * (1 - n.ratio) - gap / 2)
      walk(n.a, { x: r.x, y: r.y, w: r.w, h: ah }, path + 'a')
      walk(n.b, { x: r.x, y: r.y + ah + gap, w: r.w, h: bh }, path + 'b')
      dividers.push({ path, dir: 'col', rect: { x: r.x, y: r.y + ah, w: r.w, h: gap }, box: r })
    }
  }
  walk(node, rect, '')
  return { panes, dividers }
}

/** Which drop zone a point falls in within a pane (edge thirds, else center). */
export function dropEdgeFor(rect: Rect, px: number, py: number): DropEdge {
  const rx = rect.w > 0 ? (px - rect.x) / rect.w : 0.5
  const ry = rect.h > 0 ? (py - rect.y) / rect.h : 0.5
  const dists: Array<[DropEdge, number]> = [
    ['left', rx],
    ['right', 1 - rx],
    ['top', ry],
    ['bottom', 1 - ry],
  ]
  dists.sort((d1, d2) => d1[1] - d2[1])
  const [edge, dist] = dists[0]
  return dist > 0.34 ? 'center' : edge
}

/** The rect a drop highlight should cover for a given edge of a pane. */
export function dropHighlightRect(rect: Rect, edge: DropEdge): Rect {
  switch (edge) {
    case 'left': return { ...rect, w: rect.w / 2 }
    case 'right': return { ...rect, x: rect.x + rect.w / 2, w: rect.w / 2 }
    case 'top': return { ...rect, h: rect.h / 2 }
    case 'bottom': return { ...rect, y: rect.y + rect.h / 2, h: rect.h / 2 }
    case 'center': return rect
  }
}
