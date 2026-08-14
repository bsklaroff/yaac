// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { sidebarLayout, sidebarRowIds } from '#components/Sidebar'
import type {
  ProvisioningWorktreeEntry,
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

/** A provisioning row: a create in flight, or a worktree being restarted. */
const prov = (
  worktreeId: string,
  at: number,
  extra: Partial<ProvisioningWorktreeEntry> = {},
): ProvisioningWorktreeEntry => ({
  worktreeId,
  projectSlug: 'p',
  tool: 'claude',
  kind: 'restart',
  message: 'Starting…',
  createdAt: `2026-01-01 00:00:${String(at).padStart(2, '0')}`,
  ...extra,
})

/** { top: [provisioning ids], default: [ids],
 *    <group name>: [its provisioning ids + member ids + ghost ids] } */
const shape = (
  worktrees: WorktreeListEntry[],
  groups: WorktreeGroupSummary[],
  stoppedRows: StoppedWorktreeEntry[] = [],
  provisioning: ProvisioningWorktreeEntry[] = [],
): Record<string, string[]> => {
  const layout = sidebarLayout(worktrees, groups, stoppedRows, provisioning)
  return {
    ...(provisioning.length > 0 ? { top: layout.provisioning.map((p) => p.worktreeId) } : {}),
    default: layout.defaultList.map((w) => w.worktreeId),
    ...Object.fromEntries(layout.groups.map((s) => [
      s.group.name,
      [
        ...s.provisioning.map((p) => p.worktreeId),
        ...s.members.map((w) => w.worktreeId),
        ...s.ghosts.map((d) => d.worktreeId),
      ],
    ])),
  }
}

describe('sidebarLayout', () => {
  it('lists ungrouped worktrees newest-first, whatever their status', () => {
    expect(shape([
      entry('c', 3),
      entry('a', 1, { status: 'waiting' }),
      entry('b', 2),
    ], [])).toEqual({ default: ['c', 'b', 'a'] })
  })

  it('keeps a stopping worktree in place rather than bucketing it', () => {
    // Both the server-marked kind and (via sidebarRowIds) a mid-flight
    // optimistic delete: the row greys out where it sits.
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

    expect(layout.defaultList.map((w) => w.worktreeId)).toEqual(['loose'])
    expect(layout.groups.map((s) => s.group.groupId)).toEqual(['late', 'early'])
    expect(layout.groups[1]?.members.map((w) => w.worktreeId))
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

  it('files a provisioning row into its group, above the live rows', () => {
    const g = group('g', 10)
    // Restarting a stopped member: the ghost row is already gone (the caller
    // de-dupes it against the provisioning ids) and the restarting row takes
    // its place inside the section — not at the top of the sidebar.
    expect(shape(
      [entry('live', 2, { groupId: 'g' })],
      [g],
      [],
      [prov('coming-back', 9, { groupId: 'g' }), prov('fresh', 9)],
    )).toEqual({ top: ['fresh'], default: [], g: ['coming-back', 'live'] })
  })

  it('shows an unpinned group whose only row is provisioning', () => {
    // The last live member is mid-restart, so the section has nothing else to
    // stand on — and it must not blink out from under the row.
    const g = group('g', 10)
    expect(shape([], [g], [], [prov('coming-back', 9, { groupId: 'g' })]))
      .toEqual({ top: [], default: [], g: ['coming-back'] })
  })

  it('leaves a provisioning row naming an unknown group at the top', () => {
    expect(shape([], [], [], [prov('orphan', 9, { groupId: 'gone' })]))
      .toEqual({ top: ['orphan'], default: [] })
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
      [prov('prov-1', 9), prov('prov-grouped', 9, { groupId: 'g' })],
      [
        entry('grouped', 4, { groupId: 'g' }),
        entry('loose-new', 3),
        entry('loose-old', 2),
      ],
      [group('g', 10)],
      [],
    )
    // A grouped provisioning row cycles with its section, not with the rows at
    // the top — the same place it is drawn.
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
