import { describe, it, expect } from 'vitest'
import {
  leaf,
  leafTargets,
  splitLeaf,
  removeLeaf,
  swapLeaves,
  setRatioAt,
  moveLeaf,
  computeLayout,
  dropEdgeFor,
  dropHighlightRect,
  type LayoutNode,
} from '@/frontend/lib/layout'

const rect = { x: 0, y: 0, w: 1000, h: 600 }

describe('leafTargets', () => {
  it('lists leaves left-to-right, empty for null', () => {
    expect(leafTargets(null)).toEqual([])
    expect(leafTargets(leaf('agent'))).toEqual(['agent'])
    const tree = splitLeaf(leaf('agent'), 'agent', 'shell:shell', 'row')
    expect(leafTargets(tree)).toEqual(['agent', 'shell:shell'])
  })
})

describe('splitLeaf', () => {
  it('replaces the target leaf with a split holding both', () => {
    const tree = splitLeaf(leaf('agent'), 'agent', 'shell:shell', 'row')
    expect(tree).toEqual({
      type: 'split', dir: 'row', ratio: 0.5,
      a: leaf('agent'), b: leaf('shell:shell'),
    })
  })

  it('supports before-placement and nested targets', () => {
    let tree: LayoutNode = splitLeaf(leaf('agent'), 'agent', 'shell:shell', 'row')
    tree = splitLeaf(tree, 'shell:shell', 'window:@1', 'col', false)
    expect(leafTargets(tree)).toEqual(['agent', 'window:@1', 'shell:shell'])
  })

  it('no-ops when the onto-target is missing or the new target exists', () => {
    const base = splitLeaf(leaf('agent'), 'agent', 'shell:shell', 'row')
    expect(splitLeaf(base, 'nope', 'window:@1', 'row')).toEqual(base)
    expect(splitLeaf(base, 'agent', 'shell:shell', 'row')).toBe(base)
  })
})

describe('removeLeaf', () => {
  it('collapses the parent split to the sibling', () => {
    const tree = splitLeaf(leaf('agent'), 'agent', 'shell:shell', 'row')
    expect(removeLeaf(tree, 'shell:shell')).toEqual(leaf('agent'))
  })

  it('returns null when removing the only leaf', () => {
    expect(removeLeaf(leaf('agent'), 'agent')).toBeNull()
  })

  it('leaves the tree alone for unknown targets', () => {
    const tree = splitLeaf(leaf('agent'), 'agent', 'shell:shell', 'row')
    expect(removeLeaf(tree, 'nope')).toBe(tree)
  })
})

describe('swapLeaves', () => {
  it('exchanges two pane positions', () => {
    let tree: LayoutNode = splitLeaf(leaf('agent'), 'agent', 'shell:shell', 'row')
    tree = swapLeaves(tree, 'agent', 'shell:shell')
    expect(leafTargets(tree)).toEqual(['shell:shell', 'agent'])
  })
})

describe('setRatioAt', () => {
  it('sets the ratio at a path and clamps it', () => {
    let tree: LayoutNode = splitLeaf(leaf('agent'), 'agent', 'shell:shell', 'row')
    tree = splitLeaf(tree, 'shell:shell', 'window:@1', 'col')
    tree = setRatioAt(tree, '', 0.7)
    tree = setRatioAt(tree, 'b', 0.05)
    expect(tree).toMatchObject({ ratio: 0.7, b: { ratio: 0.1 } })
  })
})

describe('moveLeaf', () => {
  const base = (): LayoutNode => {
    let t: LayoutNode = splitLeaf(leaf('agent'), 'agent', 'shell:shell', 'row')
    t = splitLeaf(t, 'shell:shell', 'window:@1', 'col')
    return t
  }

  it('center drop swaps', () => {
    const moved = moveLeaf(base(), 'agent', 'window:@1', 'center')
    expect(leafTargets(moved)).toEqual(['window:@1', 'shell:shell', 'agent'])
  })

  it('edge drop re-splits the destination', () => {
    const moved = moveLeaf(base(), 'window:@1', 'agent', 'left')
    expect(moved).toMatchObject({
      dir: 'row',
      a: { dir: 'row', a: leaf('window:@1'), b: leaf('agent') },
      b: leaf('shell:shell'),
    })
  })

  it('bottom drop splits as a column with src after', () => {
    const moved = moveLeaf(splitLeaf(leaf('agent'), 'agent', 'shell:shell', 'row'), 'shell:shell', 'agent', 'bottom')
    expect(moved).toEqual({
      type: 'split', dir: 'col', ratio: 0.5,
      a: leaf('agent'), b: leaf('shell:shell'),
    })
  })

  it('no-ops on self-drop or unknown panes', () => {
    const t = base()
    expect(moveLeaf(t, 'agent', 'agent', 'left')).toBe(t)
    expect(moveLeaf(t, 'nope', 'agent', 'left')).toBe(t)
  })
})

describe('computeLayout', () => {
  it('returns nothing for an empty workspace', () => {
    expect(computeLayout(null, rect, 8)).toEqual({ panes: [], dividers: [] })
  })

  it('gives a single leaf the full rect', () => {
    const { panes, dividers } = computeLayout(leaf('agent'), rect, 8)
    expect(panes).toEqual([{ target: 'agent', rect }])
    expect(dividers).toEqual([])
  })

  it('partitions a row split with a gap and a divider between', () => {
    const tree = splitLeaf(leaf('agent'), 'agent', 'shell:shell', 'row')
    const { panes, dividers } = computeLayout(tree, rect, 10)
    expect(panes[0].rect).toEqual({ x: 0, y: 0, w: 495, h: 600 })
    expect(panes[1].rect).toEqual({ x: 505, y: 0, w: 495, h: 600 })
    expect(dividers).toHaveLength(1)
    expect(dividers[0]).toMatchObject({ path: '', dir: 'row', rect: { x: 495, y: 0, w: 10, h: 600 } })
  })

  it('partitions nested col splits with paths', () => {
    let tree: LayoutNode = splitLeaf(leaf('agent'), 'agent', 'shell:shell', 'row')
    tree = splitLeaf(tree, 'shell:shell', 'window:@1', 'col')
    const { panes, dividers } = computeLayout(tree, rect, 8)
    expect(panes.map((p) => p.target)).toEqual(['agent', 'shell:shell', 'window:@1'])
    const col = dividers.find((d) => d.dir === 'col')
    expect(col?.path).toBe('b')
    // the col divider spans only the right half
    expect(col!.rect.x).toBeGreaterThan(495)
  })
})

describe('dropEdgeFor / dropHighlightRect', () => {
  const r = { x: 0, y: 0, w: 100, h: 100 }

  it('maps pointer position to edges and center', () => {
    expect(dropEdgeFor(r, 5, 50)).toBe('left')
    expect(dropEdgeFor(r, 95, 50)).toBe('right')
    expect(dropEdgeFor(r, 50, 5)).toBe('top')
    expect(dropEdgeFor(r, 50, 95)).toBe('bottom')
    expect(dropEdgeFor(r, 50, 50)).toBe('center')
  })

  it('highlights the half being dropped into (full rect for center)', () => {
    expect(dropHighlightRect(r, 'left')).toEqual({ x: 0, y: 0, w: 50, h: 100 })
    expect(dropHighlightRect(r, 'bottom')).toEqual({ x: 0, y: 50, w: 100, h: 50 })
    expect(dropHighlightRect(r, 'center')).toEqual(r)
  })
})
