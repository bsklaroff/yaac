// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { sidebarLayout, sidebarRowIds } from '#components/Sidebar'
import { groupDisplay, searchRows } from '#components/WorkspaceList'
import { stoppedSectionCount } from '#lib/useStoppedWorkspaces'
import type {
  HeldWorkspaceEntry,
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
  unseenDeaths: 0,
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

  it('files members into their group and orders the groups newest-first', () => {
    const late = group('late', 20)
    const early = group('early', 10)
    const layout = sidebarLayout([
      entry('in-late', 1, { groupId: 'late' }),
      entry('loose', 2),
      entry('in-early-new', 4, { groupId: 'early' }),
      entry('in-early-old', 3, { groupId: 'early' }),
    ], [late, early])

    expect(layout.defaultList.map((w) => w.workspaceId)).toEqual(['loose'])
    expect(layout.groups.map((s) => s.group.groupId)).toEqual(['late', 'early'])
    expect(layout.groups[1]?.members.map((w) => w.workspaceId))
      .toEqual(['in-early-new', 'in-early-old'])
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

  it('files a provisioning row into its group, above the live rows', () => {
    const g = group('g', 10)
    // Restarting a stopped member: the restarting row takes its place inside
    // the section rather than at the top of the sidebar.
    expect(shape(
      [entry('live', 2, { groupId: 'g' })],
      [g],
      [prov('coming-back', 9, { groupId: 'g' }), prov('fresh', 9)],
    )).toEqual({ top: ['fresh'], default: [], g: ['coming-back', 'live'] })
  })

  it('shows an unpinned group whose only row is provisioning', () => {
    // The last live member is mid-restart. The section has no other rows but
    // must not disappear from under this one.
    const g = group('g', 10)
    expect(shape([], [g], [prov('coming-back', 9, { groupId: 'g' })]))
      .toEqual({ top: [], default: [], g: ['coming-back'] })
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

/** A queued workspace waiting on `parent`: a workspace, or another queued
 *  entry when `chained` is set. */
const queued = (
  id: string,
  parent: string,
  extra: Partial<QueuedWorkspaceEntry> & { chained?: boolean } = {},
): QueuedWorkspaceEntry => {
  const { chained, ...rest } = extra
  return {
    id,
    projectId: 'p',
    ...(chained === true ? { parentQueuedId: parent } : { parentWorkspaceId: parent }),
    prompt: id,
    tool: 'claude',
    model: 'm',
    mode: 'tui',
    permissionMode: 'bypass',
    branch: 'main',
    createdAt: '2026-01-01 00:00:00',
    ...rest,
  }
}

const held = (workspaceId: string, groupId?: string): HeldWorkspaceEntry => ({
  workspaceId,
  projectId: 'p',
  tool: 'claude',
  stoppedAt: '2026-01-01 00:00:05',
  ...(groupId !== undefined ? { groupId } : {}),
})

describe('sidebarLayout with queued workspaces', () => {
  it('nests each entry under what it waits on, chains included', () => {
    const layout = sidebarLayout([entry('a', 1)], [], [prov('p', 2)], [
      queued('q1', 'a'),
      queued('q2', 'q1', { chained: true }),
      queued('q3', 'p'),
    ])
    expect(layout.queuedChildren.get('a')?.map((e) => e.id)).toEqual(['q1'])
    expect(layout.queuedChildren.get('q1')?.map((e) => e.id)).toEqual(['q2'])
    expect(layout.queuedChildren.get('p')?.map((e) => e.id)).toEqual(['q3'])
    expect(layout.orphans).toEqual([])
  })

  it('holds a stopped parent in its place, the default list included', () => {
    const g = group('g', 10)
    const layout = sidebarLayout([], [g], [],
      [queued('q1', 'loose'), queued('q2', 'grouped')],
      [held('loose'), held('grouped', 'g')])
    expect(layout.defaultHeld.map((d) => d.workspaceId)).toEqual(['loose'])
    // The group shows for its held member alone.
    expect(layout.groups.map((s) => s.held.map((d) => d.workspaceId))).toEqual([['grouped']])
    expect(layout.orphans).toEqual([])
  })

  it('draws a held parent once, as its live or restarting row', () => {
    // Every list the group header sums: provisioning, members, held.
    const counted = (layout: ReturnType<typeof sidebarLayout>): string[][][] => layout.groups.map((s) =>
      [s.provisioning, s.members, s.held].map((l) => l.map((w) => w.workspaceId)))
    const stopping = sidebarLayout([entry('a', 1, { groupId: 'g' })], [group('g', 10)], [],
      [queued('q1', 'a')], [held('a', 'g')])
    expect(counted(stopping)).toEqual([[[], ['a'], []]])
    expect(stopping.orphans).toEqual([])
    const restarting = sidebarLayout([], [group('g', 10)], [prov('a', 1, { groupId: 'g' })],
      [queued('q1', 'a')], [held('a', 'g')])
    expect(counted(restarting)).toEqual([[['a'], [], []]])
    expect(restarting.orphans).toEqual([])
  })


  it('puts an entry with no row to nest under at the top', () => {
    const layout = sidebarLayout([entry('a', 1)], [], [], [
      queued('q1', 'nowhere', { orphaned: true }),
      queued('q2', 'q1', { chained: true }),
      queued('q3', 'not-drawn'),
    ])
    expect(layout.orphans.map((e) => e.id)).toEqual(['q1', 'q3'])
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
  const live = { provisioning: [], members: [entry('a', 1)], held: [] }
  const ghostsOnly = { provisioning: [], members: [], held: [] }
  const state = { collapsed: false, showStopped: true, searching: false }

  it('owns its ghosts only while they are on screen', () => {
    expect(groupDisplay(live, state)).toEqual({ onlyGhosts: false, expanded: true, ownsGhosts: true })
    // Collapsed, or with the toggle off, the Stopped section lists them.
    expect(groupDisplay(live, { ...state, collapsed: true }).ownsGhosts).toBe(false)
    expect(groupDisplay(live, { ...state, showStopped: false }).ownsGhosts).toBe(false)
    // A search holds the group open and hides its ghosts.
    expect(groupDisplay(live, { ...state, collapsed: true, searching: true }))
      .toEqual({ onlyGhosts: false, expanded: true, ownsGhosts: false })
  })

  it('expands a group of only ghosts with its toggle, whatever the collapse says', () => {
    expect(groupDisplay(ghostsOnly, { ...state, collapsed: true }))
      .toEqual({ onlyGhosts: true, expanded: true, ownsGhosts: true })
    expect(groupDisplay(ghostsOnly, { ...state, showStopped: false }).expanded).toBe(false)
  })
})

describe('searchRows', () => {
  it('keeps every kind of row whose title, prompt or agent matches, ignoring case', () => {
    const rows = {
      workspaces: [entry('t', 1, { title: 'Fix PARSER' }), entry('p', 2, { prompt: 'the parser' }),
        entry('x', 3, { title: 'docs', tool: 'codex' }), entry('n', 4, { title: 'nothing' })],
      provisioning: [prov('pv', 5, { kind: 'create', title: 'parser run' }), prov('other', 6, { kind: 'create' })],
      queued: [queued('q-parser', 'a'), queued('q-other', 'a')],
      held: [{ ...held('h'), title: 'Parser held' }, held('h2')],
      drafts: [],
    }
    const hit = searchRows('  Parser ', rows)
    expect(hit.workspaces.map((w) => w.workspaceId)).toEqual(['t', 'p'])
    expect(hit.provisioning.map((p) => p.workspaceId)).toEqual(['pv'])
    expect(hit.queued.map((e) => e.id)).toEqual(['q-parser'])
    expect(hit.held.map((h) => h.workspaceId)).toEqual(['h'])
    expect(searchRows('codex', rows).workspaces.map((w) => w.workspaceId)).toEqual(['x'])
    expect(searchRows('  ', rows)).toBe(rows)
  })
})

describe('stoppedSectionCount', () => {
  it('counts the project\'s stops less those drawn elsewhere', () => {
    const groups = [group('g', 1, { stoppedCount: 4 }), group('h', 2, { stoppedCount: 2 })]
    // 10 stops: g's 4 are its own ghosts; a held row and a restart outside g
    // have rows of their own; the ones inside g are already in its 4.
    expect(stoppedSectionCount({ stoppedCount: 10 }, groups, new Set(['g']),
      [held('x'), held('y', 'g')],
      [prov('r1', 1), prov('r2', 1, { groupId: 'g' }), prov('fresh', 1, { kind: 'create' })])).toBe(4)
    expect(stoppedSectionCount(undefined, [], new Set(), [], [])).toBe(0)
  })
})
