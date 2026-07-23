import { describe, it, expect } from 'vitest'
import {
  addColumn,
  addTab,
  computeColumns,
  dropTargetAt,
  focusPaneTarget,
  groupIndexOf,
  isWorkspace,
  moveColumn,
  moveTabInStrip,
  moveTargetToColumn,
  moveTargetToGroup,
  paneTargets,
  removeTarget,
  singleColumn,
  withActive,
  type Workspace,
} from '#lib/layout'

const rect = { x: 0, y: 0, w: 1000, h: 600 }

/** Two equal columns, each a single pane. */
const two = (): Workspace => addColumn(singleColumn('agent'), 'shell:a')

describe('singleColumn', () => {
  it('is one column of one active tab', () => {
    expect(singleColumn('agent')).toEqual([{ tabs: ['agent'], active: 'agent' }])
  })
})

describe('paneTargets', () => {
  it('lists every tab left-to-right, empty for null', () => {
    expect(paneTargets(null)).toEqual([])
    expect(paneTargets(singleColumn('agent'))).toEqual(['agent'])
    const ws = addTab(addColumn(singleColumn('agent'), 'shell:a'), 0, 'shell:b')
    expect(paneTargets(ws)).toEqual(['agent', 'shell:b', 'shell:a'])
  })
})

describe('groupIndexOf', () => {
  it('finds the column holding a target, else -1', () => {
    const ws = two()
    expect(groupIndexOf(ws, 'agent')).toBe(0)
    expect(groupIndexOf(ws, 'shell:a')).toBe(1)
    expect(groupIndexOf(ws, 'nope')).toBe(-1)
    expect(groupIndexOf(null, 'agent')).toBe(-1)
  })
})

describe('addColumn', () => {
  it('fills a null base and appends new columns', () => {
    expect(addColumn(null, 'agent')).toEqual(singleColumn('agent'))
    expect(paneTargets(two())).toEqual(['agent', 'shell:a'])
  })

  it('no-ops when the target is already present anywhere', () => {
    const ws = addTab(singleColumn('agent'), 0, 'shell:a')
    expect(addColumn(ws, 'shell:a')).toBe(ws)
  })
})

describe('addTab', () => {
  it('adds a tab to a column and makes it active', () => {
    const ws = addTab(singleColumn('agent'), 0, 'shell:a')
    expect(ws).toEqual([{ tabs: ['agent', 'shell:a'], active: 'shell:a' }])
  })

  it('no-ops on an out-of-range index or an existing target', () => {
    const ws = singleColumn('agent')
    expect(addTab(ws, 3, 'shell:a')).toBe(ws)
    expect(addTab(ws, 0, 'agent')).toBe(ws)
  })
})

describe('removeTarget', () => {
  it('drops a tab, keeping the column while others remain', () => {
    const ws = addTab(singleColumn('agent'), 0, 'shell:a')
    expect(removeTarget(ws, 'shell:a')).toEqual([{ tabs: ['agent'], active: 'agent' }])
  })

  it('removes the column when its last tab goes', () => {
    expect(removeTarget(two(), 'shell:a')).toEqual([{ tabs: ['agent'], active: 'agent' }])
  })

  it('repairs the active tab (same position, clamped) when the active one goes', () => {
    let ws = addTab(singleColumn('agent'), 0, 'shell:a')
    ws = addTab(ws, 0, 'shell:b') // tabs: [agent, shell:a, shell:b], active shell:b
    expect(removeTarget(ws, 'shell:b')).toEqual([{ tabs: ['agent', 'shell:a'], active: 'shell:a' }])
    // removing a non-active tab keeps the active one
    const ws2 = withActive(ws, 'agent')
    expect(removeTarget(ws2, 'shell:b')).toEqual([{ tabs: ['agent', 'shell:a'], active: 'agent' }])
  })

  it('returns the same reference for an unknown target, and [] for null', () => {
    const ws = two()
    expect(removeTarget(ws, 'nope')).toBe(ws)
    expect(removeTarget(null, 'x')).toEqual([])
  })
})

describe('moveTargetToGroup', () => {
  it('pulls a pane out and appends it as the active tab of the destination', () => {
    const moved = moveTargetToGroup(two(), 'shell:a', 0)
    expect(moved).toEqual([{ tabs: ['agent', 'shell:a'], active: 'shell:a' }])
  })

  it('no-ops when src is missing or already a tab of the destination', () => {
    const ws = two()
    expect(moveTargetToGroup(ws, 'nope', 0)).toBe(ws)
    expect(moveTargetToGroup(ws, 'agent', 0)).toBe(ws)
  })
})

describe('moveTargetToColumn', () => {
  it('pulls a tab out into its own column at the given index', () => {
    const ws = addTab(singleColumn('agent'), 0, 'shell:a') // one column, two tabs
    // insert as the first column
    expect(moveTargetToColumn(ws, 'shell:a', 0)).toEqual([
      { tabs: ['shell:a'], active: 'shell:a' },
      { tabs: ['agent'], active: 'agent' },
    ])
  })

  it('reorders a lone column, adjusting for the collapse it leaves behind', () => {
    // columns: [agent, shell:a, shell:b]; move agent to the end
    let ws = addColumn(singleColumn('agent'), 'shell:a')
    ws = addColumn(ws, 'shell:b')
    expect(paneTargets(moveTargetToColumn(ws, 'agent', 3))).toEqual(['shell:a', 'shell:b', 'agent'])
  })

  it('no-ops when a lone column is dropped onto its own position', () => {
    const ws = two()
    expect(moveTargetToColumn(ws, 'agent', 0)).toBe(ws)
    expect(moveTargetToColumn(ws, 'agent', 1)).toBe(ws)
  })
})

describe('moveColumn', () => {
  /** Three single-pane columns: agent | shell:a | shell:b. */
  const three = (): Workspace => addColumn(addColumn(singleColumn('agent'), 'shell:a'), 'shell:b')

  it('moves the column holding the target one slot, in either direction', () => {
    expect(paneTargets(moveColumn(three(), 'agent', 1))).toEqual(['shell:a', 'agent', 'shell:b'])
    expect(paneTargets(moveColumn(three(), 'shell:b', -1))).toEqual(['agent', 'shell:b', 'shell:a'])
  })

  it('wraps around at both ends', () => {
    expect(paneTargets(moveColumn(three(), 'agent', -1))).toEqual(['shell:a', 'shell:b', 'agent'])
    expect(paneTargets(moveColumn(three(), 'shell:b', 1))).toEqual(['shell:b', 'agent', 'shell:a'])
  })

  it('moves the whole column when the target is a tab within a multi-tab column', () => {
    // columns: [agent, shell:x] | [shell:b]; moving shell:x right carries agent with it
    const ws = addColumn(addTab(singleColumn('agent'), 0, 'shell:x'), 'shell:b')
    expect(moveColumn(ws, 'shell:x', 1)).toEqual([
      { tabs: ['shell:b'], active: 'shell:b' },
      { tabs: ['agent', 'shell:x'], active: 'shell:x' },
    ])
  })

  it('no-ops (same reference) with fewer than two columns or an unknown target', () => {
    const one = singleColumn('agent')
    expect(moveColumn(one, 'agent', 1)).toBe(one)
    const ws = two()
    expect(moveColumn(ws, 'nope', 1)).toBe(ws)
  })
})

describe('moveTabInStrip', () => {
  /** One column of three tabs: agent, shell:a, shell:b (shell:b active). */
  const strip = (): Workspace => addTab(addTab(singleColumn('agent'), 0, 'shell:a'), 0, 'shell:b')

  it('reorders the target within the flat strip, in either direction', () => {
    expect(paneTargets(moveTabInStrip(strip(), 'agent', 1))).toEqual(['shell:a', 'agent', 'shell:b'])
    expect(paneTargets(moveTabInStrip(strip(), 'shell:b', -1))).toEqual(['agent', 'shell:b', 'shell:a'])
  })

  it('wraps around at both ends', () => {
    expect(paneTargets(moveTabInStrip(strip(), 'agent', -1))).toEqual(['shell:a', 'shell:b', 'agent'])
    expect(paneTargets(moveTabInStrip(strip(), 'shell:b', 1))).toEqual(['shell:b', 'agent', 'shell:a'])
  })

  it('preserves the column sizes, refilling them from the reordered strip', () => {
    // columns sized [2, 1]: [agent, shell:a] | [shell:b]; move shell:a right.
    const ws = addColumn(addTab(singleColumn('agent'), 0, 'shell:a'), 'shell:b')
    const moved = moveTabInStrip(ws, 'shell:a', 1)
    // Strip agent, shell:a, shell:b → agent, shell:b, shell:a; refilled 2 then 1.
    expect(moved).toEqual([
      { tabs: ['agent', 'shell:b'], active: 'agent' },
      { tabs: ['shell:a'], active: 'shell:a' },
    ])
  })

  it('no-ops (same reference) with fewer than two panes or an unknown target', () => {
    const one = singleColumn('agent')
    expect(moveTabInStrip(one, 'agent', 1)).toBe(one)
    const ws = strip()
    expect(moveTabInStrip(ws, 'nope', 1)).toBe(ws)
  })
})

describe('withActive', () => {
  it('makes a target the active tab of its column', () => {
    const ws = addTab(singleColumn('agent'), 0, 'shell:a')
    expect(withActive(ws, 'agent')).toEqual([{ tabs: ['agent', 'shell:a'], active: 'agent' }])
  })

  it('no-ops when the target is absent or already active', () => {
    const ws = addTab(singleColumn('agent'), 0, 'shell:a')
    expect(withActive(ws, 'shell:a')).toBe(ws)
    expect(withActive(ws, 'nope')).toBe(ws)
    expect(withActive(null, 'x')).toEqual([])
  })
})

describe('focusPaneTarget', () => {
  it('tabs mode focuses the active tab (the only visible pane)', () => {
    expect(focusPaneTarget(['agent', 'shell:a'], 'shell:a', false)).toBe('shell:a')
    expect(focusPaneTarget(['agent'], 'agent', false)).toBe('agent')
  })

  it('tabs mode falls back to the first pane for a stale or unset tab', () => {
    expect(focusPaneTarget(['agent', 'shell:a'], 'shell:gone', false)).toBe('agent')
    expect(focusPaneTarget(['agent', 'shell:a'], undefined, false)).toBe('agent')
  })

  it('tiles mode prefers the last-active pane, else the agent, else the first', () => {
    expect(focusPaneTarget(['shell:a', 'agent'], 'shell:a', true)).toBe('shell:a')
    expect(focusPaneTarget(['shell:a', 'agent'], undefined, true)).toBe('agent')
    expect(focusPaneTarget(['shell:a', 'shell:b'], undefined, true)).toBe('shell:a')
  })

  it('returns null when there is no pane to focus', () => {
    expect(focusPaneTarget([], undefined, true)).toBeNull()
    expect(focusPaneTarget([], undefined, false)).toBeNull()
  })
})

describe('computeColumns', () => {
  it('returns nothing for an empty workspace', () => {
    expect(computeColumns(null, rect, 8)).toEqual([])
    expect(computeColumns([], rect, 8)).toEqual([])
  })

  it('gives a single column the full rect', () => {
    const cols = computeColumns(singleColumn('agent'), rect, 8)
    expect(cols).toEqual([{ group: { tabs: ['agent'], active: 'agent' }, rect }])
  })

  it('splits width equally, leaving a gap between columns', () => {
    const cols = computeColumns(two(), rect, 10)
    expect(cols[0].rect).toEqual({ x: 0, y: 0, w: 495, h: 600 })
    expect(cols[1].rect).toEqual({ x: 505, y: 0, w: 495, h: 600 })
  })
})

describe('dropTargetAt', () => {
  const cols = computeColumns(two(), rect, 10) // col0: 0..495, col1: 505..1000

  it('tabs into a column when over its central band', () => {
    expect(dropTargetAt(cols, 250)).toEqual({ kind: 'tab', group: 0 })
    expect(dropTargetAt(cols, 750)).toEqual({ kind: 'tab', group: 1 })
  })

  it('inserts a new column from the outer thirds and the edges', () => {
    expect(dropTargetAt(cols, 10)).toEqual({ kind: 'column', index: 0 })   // left third of col0
    expect(dropTargetAt(cols, 480)).toEqual({ kind: 'column', index: 1 })  // right third of col0
    expect(dropTargetAt(cols, 990)).toEqual({ kind: 'column', index: 2 })  // right third of col1
  })

  it('resolves the gap between columns to an insertion index', () => {
    expect(dropTargetAt(cols, 500)).toEqual({ kind: 'column', index: 1 })
  })

  it('handles an empty column list', () => {
    expect(dropTargetAt([], 100)).toEqual({ kind: 'column', index: 0 })
  })
})

describe('isWorkspace', () => {
  it('accepts valid workspaces, including the empty one', () => {
    expect(isWorkspace([])).toBe(true)
    expect(isWorkspace(singleColumn('agent'))).toBe(true)
    expect(isWorkspace(addTab(singleColumn('agent'), 0, 'shell:a'))).toBe(true)
  })

  it('rejects malformed structures', () => {
    expect(isWorkspace(null)).toBe(false)
    expect(isWorkspace({ tabs: ['a'], active: 'a' })).toBe(false)          // not an array of groups
    expect(isWorkspace([{ tabs: [], active: 'a' }])).toBe(false)           // empty tabs
    expect(isWorkspace([{ tabs: ['a'], active: 'b' }])).toBe(false)        // active not a member
    expect(isWorkspace([{ tabs: ['a', ''], active: 'a' }])).toBe(false)    // empty tab id
    expect(isWorkspace([{ tabs: ['a'] }])).toBe(false)                     // missing active
    expect(isWorkspace([{ type: 'leaf', target: 'agent' }])).toBe(false)   // old tree shape
  })
})
