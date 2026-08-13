import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#db/client'
import {
  createWorktreeGroup,
  deleteProjectWorktreeGroups,
  deleteWorktreeGroup,
  listWorktreeGroupRows,
  renameWorktreeGroup,
  setWorktreeGroup,
  setWorktreeGroupPinned,
} from '#db/group-store'
import { getProjectWorktreeRows, recordWorktreeCreated, recordWorktreeStopped } from '#db/worktree-store'
import { onWorktreeListChanged, _resetWorktreeListChangedForTests } from '#notify'
import { ServerError } from '@yaac/shared/errors'

describe('worktree group store', () => {
  let tmpDir: string
  let pushes: number

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    _resetWorktreeListChangedForTests()
    pushes = 0
    onWorktreeListChanged(() => { pushes += 1 })
  })

  afterEach(async () => {
    _resetWorktreeListChangedForTests()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  const create = (worktreeId: string, projectSlug = 'proj'): Promise<void> =>
    recordWorktreeCreated({ projectSlug, worktreeId })

  const groupOf = async (worktreeId: string, projectSlug = 'proj'): Promise<string | undefined> =>
    (await getProjectWorktreeRows(projectSlug)).get(worktreeId)?.groupId

  describe('createWorktreeGroup', () => {
    it('files its founding worktree, and pushes a snapshot', async () => {
      await create('sid-1')
      const before = pushes

      const group = await createWorktreeGroup('proj', '  release   train ', 'sid-1')

      // Names take the same normalization a worktree title does.
      expect(group).toMatchObject({ projectSlug: 'proj', name: 'release train', pinned: false })
      expect(await groupOf('sid-1')).toBe(group.groupId)
      expect(pushes - before).toBe(1)
    })

    it('refuses a founding worktree the project does not have', async () => {
      // An empty group is unreachable — nothing lists an unpinned group with
      // no members, so nothing could ever delete it. The insert has to go back
      // with the failed stamp.
      await expect(createWorktreeGroup('proj', 'release', 'nope')).rejects.toThrow(ServerError)
      expect(await listWorktreeGroupRows('proj')).toEqual([])

      await create('sid-1', 'other')
      await expect(createWorktreeGroup('proj', 'release', 'sid-1')).rejects.toThrow(ServerError)
      expect(await listWorktreeGroupRows('proj')).toEqual([])
    })

    it('keeps each group to its own project', async () => {
      await create('sid-1')
      await create('sid-2', 'other')
      const mine = await createWorktreeGroup('proj', 'mine', 'sid-1')
      await createWorktreeGroup('other', 'theirs', 'sid-2')

      expect((await listWorktreeGroupRows('proj')).map((g) => g.name)).toEqual(['mine'])
      expect((await listWorktreeGroupRows()).map((g) => g.name).sort()).toEqual(['mine', 'theirs'])
      // The founding stamp is scoped too — a same-named worktree in another
      // project is untouched.
      expect(await groupOf('sid-1')).toBe(mine.groupId)
      expect(await groupOf('sid-2', 'proj')).toBeUndefined()
    })
  })

  describe('renameWorktreeGroup', () => {
    it('renames, and leaves a blank name alone', async () => {
      await create('sid-1')
      const group = await createWorktreeGroup('proj', 'release', 'sid-1')

      await renameWorktreeGroup('proj', group.groupId, ' shipping  soon ')
      expect((await listWorktreeGroupRows('proj'))[0]?.name).toBe('shipping soon')

      // A group is only ever identified by its name, so there is nothing for a
      // blank one to fall back to.
      await renameWorktreeGroup('proj', group.groupId, '   ')
      expect((await listWorktreeGroupRows('proj'))[0]?.name).toBe('shipping soon')
    })
  })

  describe('setWorktreeGroupPinned', () => {
    it('pins and unpins, pushing each time', async () => {
      await create('sid-1')
      const group = await createWorktreeGroup('proj', 'release', 'sid-1')
      const before = pushes

      await setWorktreeGroupPinned('proj', group.groupId, true)
      expect((await listWorktreeGroupRows('proj'))[0]?.pinned).toBe(true)

      await setWorktreeGroupPinned('proj', group.groupId, false)
      expect((await listWorktreeGroupRows('proj'))[0]?.pinned).toBe(false)
      expect(pushes - before).toBe(2)
    })
  })

  describe('deleteWorktreeGroup', () => {
    it('releases every member — running or stopped — back to the default list', async () => {
      await create('live')
      await create('dead')
      const group = await createWorktreeGroup('proj', 'release', 'live')
      await setWorktreeGroup('proj', 'dead', group.groupId)
      await recordWorktreeStopped('proj', 'dead')

      await deleteWorktreeGroup('proj', group.groupId)

      expect(await listWorktreeGroupRows('proj')).toEqual([])
      expect(await groupOf('live')).toBeUndefined()
      expect(await groupOf('dead')).toBeUndefined()
    })

    it('leaves another group and its members alone', async () => {
      await create('sid-1')
      await create('sid-2')
      const doomed = await createWorktreeGroup('proj', 'doomed', 'sid-1')
      const kept = await createWorktreeGroup('proj', 'kept', 'sid-2')

      await deleteWorktreeGroup('proj', doomed.groupId)

      expect((await listWorktreeGroupRows('proj')).map((g) => g.groupId)).toEqual([kept.groupId])
      expect(await groupOf('sid-2')).toBe(kept.groupId)
    })
  })

  describe('setWorktreeGroup', () => {
    it('moves a worktree between groups and back to the default list', async () => {
      await create('sid-1')
      const from = await createWorktreeGroup('proj', 'from', 'sid-1')
      await create('sid-2')
      const to = await createWorktreeGroup('proj', 'to', 'sid-2')

      await setWorktreeGroup('proj', 'sid-1', to.groupId)
      expect(await groupOf('sid-1')).toBe(to.groupId)

      await setWorktreeGroup('proj', 'sid-1', null)
      expect(await groupOf('sid-1')).toBeUndefined()
      // The group it left still exists — emptying one never deletes it, which
      // is what lets a hidden group come back when a member restarts.
      expect((await listWorktreeGroupRows('proj')).map((g) => g.groupId).sort())
        .toEqual([from.groupId, to.groupId].sort())
    })

    it('refuses a group the project does not have', async () => {
      await create('sid-1')
      // The sidebar acts on a snapshot, so a drop can name a group another
      // client has just deleted. That has to fail loudly rather than file the
      // worktree somewhere nothing lists.
      await expect(setWorktreeGroup('proj', 'sid-1', 'gone')).rejects.toThrow(ServerError)
      expect(await groupOf('sid-1')).toBeUndefined()

      await create('sid-2', 'other')
      const theirs = await createWorktreeGroup('other', 'theirs', 'sid-2')
      await expect(setWorktreeGroup('proj', 'sid-1', theirs.groupId)).rejects.toThrow(ServerError)
    })

    it('refuses a worktree the project does not have', async () => {
      await create('sid-1')
      const group = await createWorktreeGroup('proj', 'release', 'sid-1')
      // Both ends are checked: a move that matched no row would otherwise
      // report success having filed nothing.
      await expect(setWorktreeGroup('proj', 'nope', group.groupId)).rejects.toThrow(ServerError)
      await expect(setWorktreeGroup('proj', 'nope', null)).rejects.toThrow(ServerError)
    })

    it('pushes a snapshot on a move, so the sidebar regroups', async () => {
      await create('sid-1')
      const group = await createWorktreeGroup('proj', 'release', 'sid-1')
      const before = pushes
      await setWorktreeGroup('proj', 'sid-1', null)
      await setWorktreeGroup('proj', 'sid-1', group.groupId)
      expect(pushes - before).toBe(2)
    })
  })

  describe('deleteProjectWorktreeGroups', () => {
    it('forgets one project\'s groups and no other\'s', async () => {
      await create('sid-1')
      await create('sid-2', 'other')
      await createWorktreeGroup('proj', 'mine', 'sid-1')
      await createWorktreeGroup('other', 'theirs', 'sid-2')

      await deleteProjectWorktreeGroups('proj')

      expect(await listWorktreeGroupRows('proj')).toEqual([])
      expect((await listWorktreeGroupRows('other')).map((g) => g.name)).toEqual(['theirs'])
    })
  })
})
