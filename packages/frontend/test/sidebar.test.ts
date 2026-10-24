import { describe, it, expect } from 'vitest'
import { sidebarLayout, sidebarRowIds } from '#components/Sidebar'
import { groupDisplay } from '#components/WorkspaceList'
import { roomKey } from '#lib/queued'
import type {
  ProvisioningWorkspaceEntry,
  QueuedWorkspaceEntry,
  WorkspaceGroupSummary,
  WorkspaceListEntry,
} from '@yaac/shared/types'

/** A workspace entry. `at` is the seconds field of its creation time, which is
 *  what the list orders on. */
const entry = (
  workspaceId: string,
  at: number,
  extra: Partial<WorkspaceListEntry> = {},
): WorkspaceListEntry => ({
  workspaceId,
  projectId: 'p',
  tool: 'claude',
  status: 'running',
  createdAt: `2026-01-01 00:00:${String(at).padStart(2, '0')}`,
  agentSessions: [],
  blockedHosts: [],
  forwardedPorts: [],
  unforwardedPorts: [],
  ...extra,
})

const group = (
  groupId: string,
  at: number,
  extra: Partial<WorkspaceGroupSummary> = {},
): WorkspaceGroupSummary => ({
  groupId,
  projectId: 'p',
  name: groupId,
  pinned: false,
  createdAt: `2026-01-01 00:00:${String(at).padStart(2, '0')}`,
  stoppedCount: 0,
  deaths: 0, deathsSeenBy: {},
  ...extra,
})

/** A provisioning row: a create in flight, or a workspace being restarted. */
const prov = (
  workspaceId: string,
  at: number,
  extra: Partial<ProvisioningWorkspaceEntry> = {},
): ProvisioningWorkspaceEntry => ({
  workspaceId,
  projectId: 'p',
  tool: 'claude',
  kind: 'restart',
  message: 'Starting…',
  createdAt: `2026-01-01 00:00:${String(at).padStart(2, '0')}`,
  ...extra,
})

/** A queued workspace; with no parent given, it waits for room in its group. */
const queued = (id: string, extra: Partial<QueuedWorkspaceEntry> = {}): QueuedWorkspaceEntry => ({
  id,
  projectId: 'p',
  prompt: 'do it',
  tool: 'claude',
  model: 'm',
  mode: 'tui',
  permissionMode: 'bypass',
  branch: 'main',
  createdAt: '2026-01-01 00:00:00',
  ...extra,
})

/** { top: [provisioning ids], default: [ids],
 *    <group name>: [its provisioning ids + member ids] } */
const shape = (
  workspaces: WorkspaceListEntry[],
  groups: WorkspaceGroupSummary[],
  provisioning: ProvisioningWorkspaceEntry[] = [],
): Record<string, string[]> => {
  const layout = sidebarLayout(workspaces, groups, provisioning)
  return {
    ...(provisioning.length > 0 ? { top: layout.provisioning.map((p) => p.workspaceId) } : {}),
    default: layout.defaultList.map((w) => w.workspaceId),
    ...Object.fromEntries(layout.groups.map((s) => [
      s.group.name,
      [
        ...s.provisioning.map((p) => p.workspaceId),
        ...s.members.map((w) => w.workspaceId),
      ],
    ])),
  }
}

describe('sidebarLayout', () => {
  it('lists ungrouped workspaces newest-first, whatever their status', () => {
    expect(shape([
      entry('c', 3),
      entry('a', 1, { status: 'waiting' }),
      entry('b', 2),
    ], [])).toEqual({ default: ['c', 'b', 'a'] })
  })

  it('keeps a stopping workspace in place rather than bucketing it', () => {
    // Covers both the server-marked kind and an in-flight optimistic delete
    // (via sidebarRowIds): the row greys out in place.
    expect(shape([
      entry('a', 1),
      entry('b', 2, { stopping: true }),
      entry('c', 3),
    ], [])).toEqual({ default: ['c', 'b', 'a'] })
  })

  it('hides an unpinned group with no live member, and keeps a pinned one', () => {
    const loose = group('loose-group', 10)
    const pinned = group('pinned-group', 20, { pinned: true })

    // Nothing live in either: only the pinned one is drawn.
    expect(shape([], [loose, pinned])).toEqual({ default: [], 'pinned-group': [] })

    // One live member is enough to bring the unpinned one back.
    expect(shape([entry('a', 1, { groupId: 'loose-group' })], [loose, pinned]))
      .toEqual({ default: [], 'loose-group': ['a'], 'pinned-group': [] })
  })

  it('counts a waiting or stopping member as live for visibility', () => {
    const g = group('g', 10)
    expect(shape([entry('w', 1, { status: 'waiting', groupId: 'g' })], [g]))
      .toEqual({ default: [], g: ['w'] })
    expect(shape([entry('t', 1, { stopping: true, groupId: 'g' })], [g]))
      .toEqual({ default: [], g: ['t'] })
  })

  it('leaves a provisioning row naming an unknown group at the top', () => {
    expect(shape([], [], [prov('orphan', 9, { groupId: 'gone' })]))
      .toEqual({ top: ['orphan'], default: [] })
  })

  it('falls back to the default list for a group that no longer exists', () => {
    // A snapshot that arrives mid-delete.
    expect(shape([entry('orphan', 1, { groupId: 'gone' })], [])).toEqual({ default: ['orphan'] })
  })
})

describe('sidebarLayout with queued workspaces', () => {
  it('nests one with no parent in its group, which it keeps shown, else at the top', () => {
    const groups = [group('limited', 1, { workspaceLimit: 2 })]
    const waiting = queued('q1', { groupId: 'limited' })
    const lost = queued('q2', { groupId: 'deleted' })
    const after = queued('q3', { parentQueuedId: 'q1' })
    const layout = sidebarLayout([], groups, [], [waiting, lost, after])
    // No live member, unpinned, yet shown for what waits in it.
    expect(layout.groups.map((s) => [s.group.groupId, s.waiting.map((e) => e.id)])).toEqual([['limited', ['q1']]])
    expect(layout.queuedChildren.get(roomKey('limited'))).toEqual([waiting])
    expect(layout.queuedChildren.get('q1')).toEqual([after])
    expect(layout.orphans.map((e) => e.id)).toEqual(['q2'])
  })
})

describe('sidebarRowIds', () => {
  it('runs provisioning, then the default list, then each shown group', () => {
    const rows = sidebarRowIds(
      [prov('prov-1', 9), prov('prov-grouped', 9, { groupId: 'g' })],
      [
        entry('grouped', 4, { groupId: 'g' }),
        entry('loose-new', 3),
        entry('loose-old', 2),
      ],
      [group('g', 10)],
      [],
    )
    // A grouped provisioning row cycles with its section, where it is drawn,
    // not with the rows at the top.
    expect(rows).toEqual(['prov-1', 'loose-new', 'loose-old', 'prov-grouped', 'grouped'])
  })

  it('keeps a group that only holds a provisioning row in the cycle', () => {
    expect(sidebarRowIds([prov('coming-back', 9, { groupId: 'g' })], [], [group('g', 10)], []))
      .toEqual(['coming-back'])
  })

  it('skips stopping rows — server-marked or optimistically deleting', () => {
    expect(sidebarRowIds([], [entry('a', 1, { stopping: true }), entry('b', 2)], [], []))
      .toEqual(['b'])
    expect(sidebarRowIds([], [entry('a', 1), entry('b', 2)], [], ['a']))
      .toEqual(['b'])
  })

  it('skips a hidden group\'s rows and returns nothing when there is nothing', () => {
    // A pinned-but-empty group contributes no selectable row.
    expect(sidebarRowIds([], [], [group('g', 10, { pinned: true })], [])).toEqual([])
    expect(sidebarRowIds([], [], [], [])).toEqual([])
  })
})

describe('groupDisplay', () => {
  const live = { provisioning: [], members: [entry('a', 1)], held: [], waiting: [] }
  const ghostsOnly = { provisioning: [], members: [], held: [], waiting: [] }
  const state = { collapsed: false, showStopped: true, narrowed: false }

  it('owns its ghosts only while they are on screen', () => {
    expect(groupDisplay(live, state)).toEqual({ onlyGhosts: false, expanded: true, ownsGhosts: true })
    // Collapsed, or with the toggle off, the Stopped section lists them.
    expect(groupDisplay(live, { ...state, collapsed: true }).ownsGhosts).toBe(false)
    expect(groupDisplay(live, { ...state, showStopped: false }).ownsGhosts).toBe(false)
    // A search holds the group open and hides its ghosts.
    expect(groupDisplay(live, { ...state, collapsed: true, narrowed: true }))
      .toEqual({ onlyGhosts: false, expanded: true, ownsGhosts: false })
  })

  it('expands a group of only ghosts with its toggle, whatever the collapse says', () => {
    expect(groupDisplay(ghostsOnly, { ...state, collapsed: true }))
      .toEqual({ onlyGhosts: true, expanded: true, ownsGhosts: true })
    expect(groupDisplay(ghostsOnly, { ...state, showStopped: false }).expanded).toBe(false)
    // Workspaces waiting for room are rows of its own, not ghosts.
    expect(groupDisplay({ ...ghostsOnly, waiting: [queued('q', { groupId: 'g' })] }, { ...state, collapsed: true }))
      .toMatchObject({ onlyGhosts: false, expanded: false })
  })
})
