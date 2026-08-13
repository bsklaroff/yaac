// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { sidebarLayout, sidebarRowIds } from '#components/Sidebar'
import type {
  StoppedWorktreeEntry,
  WorktreeGroupSummary,
  WorktreeListEntry,
} from '@yaac/shared/types'

/** A worktree entry. `at` is the seconds field of its creation time, which is
 *  what the list orders on. */
const entry = (
  worktreeId: string,
  at: number,
  extra: Partial<WorktreeListEntry> = {},
): WorktreeListEntry => ({
  worktreeId,
  projectSlug: 'p',
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
  extra: Partial<WorktreeGroupSummary> = {},
): WorktreeGroupSummary => ({
  groupId,
  projectSlug: 'p',
  name: groupId,
  pinned: false,
  createdAt: `2026-01-01 00:00:${String(at).padStart(2, '0')}`,
  ...extra,
})

const stopped = (
  worktreeId: string,
  at: number,
  groupId?: string,
): StoppedWorktreeEntry => ({
  worktreeId,
  projectSlug: 'p',
  tool: 'claude',
  createdAt: `2026-01-01 00:00:${String(at).padStart(2, '0')}`,
  seen: false,
  agentSessions: [],
  ...(groupId !== undefined ? { groupId } : {}),
})

/** { default: [ids], <group name>: [member ids + ghost ids] } */
const shape = (
  worktrees: WorktreeListEntry[],
  groups: WorktreeGroupSummary[],
  stoppedRows: StoppedWorktreeEntry[] = [],
): Record<string, string[]> => {
  const layout = sidebarLayout(worktrees, groups, stoppedRows)
  return {
    default: layout.defaultList.map((w) => w.worktreeId),
    ...Object.fromEntries(layout.groups.map((s) => [
      s.group.name,
      [...s.members.map((w) => w.worktreeId), ...s.ghosts.map((d) => d.worktreeId)],
    ])),
  }
}

describe('sidebarLayout', () => {
  it('lists ungrouped worktrees oldest-first, whatever their status', () => {
    expect(shape([
      entry('c', 3),
      entry('a', 1, { status: 'waiting' }),
      entry('b', 2),
    ], [])).toEqual({ default: ['a', 'b', 'c'] })
  })

  it('keeps a stopping worktree in place rather than bucketing it', () => {
    // Both the server-marked kind and (via sidebarRowIds) a mid-flight
    // optimistic delete: the row greys out where it sits.
    expect(shape([
      entry('a', 1),
      entry('b', 2, { stopping: true }),
      entry('c', 3),
    ], [])).toEqual({ default: ['a', 'b', 'c'] })
  })

  it('files members into their group and orders the groups by creation', () => {
    const late = group('late', 20)
    const early = group('early', 10)
    const layout = sidebarLayout([
      entry('in-late', 1, { groupId: 'late' }),
      entry('loose', 2),
      entry('in-early-new', 4, { groupId: 'early' }),
      entry('in-early-old', 3, { groupId: 'early' }),
    ], [late, early])

    expect(layout.defaultList.map((w) => w.worktreeId)).toEqual(['loose'])
    expect(layout.groups.map((s) => s.group.groupId)).toEqual(['early', 'late'])
    expect(layout.groups[0]?.members.map((w) => w.worktreeId))
      .toEqual(['in-early-old', 'in-early-new'])
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

  it('ghosts every shown group\'s stopped members, pinned or not', () => {
    const g = group('g', 10)
    // An unpinned group with one live worktree still shows its dead ones.
    expect(shape(
      [entry('live', 2, { groupId: 'g' })],
      [g],
      [stopped('gone', 1, 'g'), stopped('elsewhere', 1), stopped('other-group', 1, 'nope')],
    )).toEqual({ default: [], g: ['live', 'gone'] })

    // Ungrouped stopped worktrees are never drawn — they live in the stopped
    // overlay — and neither are a hidden group's.
    expect(shape([], [g], [stopped('gone', 1, 'g')])).toEqual({ default: [] })
    expect(shape([], [{ ...g, pinned: true }], [stopped('gone', 1, 'g')]))
      .toEqual({ default: [], g: ['gone'] })
  })

  it('falls back to the default list for a group that no longer exists', () => {
    // What a snapshot arriving mid-delete looks like.
    expect(shape([entry('orphan', 1, { groupId: 'gone' })], [])).toEqual({ default: ['orphan'] })
    expect(sidebarLayout([], [], [stopped('a', 1, 'gone')]).groups).toEqual([])
  })
})

describe('sidebarRowIds', () => {
  it('runs provisioning, then the default list, then each shown group', () => {
    const rows = sidebarRowIds(
      [{ worktreeId: 'prov-1' }],
      [
        entry('grouped', 4, { groupId: 'g' }),
        entry('loose-new', 3),
        entry('loose-old', 2),
      ],
      [group('g', 10)],
      [],
    )
    expect(rows).toEqual(['prov-1', 'loose-old', 'loose-new', 'grouped'])
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
