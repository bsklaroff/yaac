import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#db/client'
import {
  createWorkspaceGroup,
  deleteProjectWorkspaceGroups,
  deleteWorkspaceGroup,
  listWorkspaceGroupRows,
  renameWorkspaceGroup,
  setWorkspaceGroup,
  setWorkspaceGroupPinned,
} from '#db/group-store'
import { getProjectWorkspaceRows, recordWorkspaceCreated, recordWorkspaceStopped } from '#db/workspace-store'
import { getQueuedWorkspaceRow, insertQueuedWorkspace } from '#db/queued-workspace-store'
import { insertDraftWorkspace, listDraftWorkspaceRows } from '#db/draft-workspace-store'
import { onWorkspaceListChanged, _resetWorkspaceListChangedForTests } from '#notify'
import { ServerError } from '@yaac/shared/errors'

const OTHER = '795f3202-b17c-46bc-8d4b-771d8c6c9eaf'

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'

describe('workspace group store', () => {
  let tmpDir: string
  let pushes: number

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    _resetWorkspaceListChangedForTests()
    pushes = 0
    onWorkspaceListChanged(() => { pushes += 1 })
  })

  afterEach(async () => {
    _resetWorkspaceListChangedForTests()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  const create = (workspaceId: string, projectId = PROJ): Promise<void> =>
    recordWorkspaceCreated({ projectId, workspaceId })

  const groupOf = async (workspaceId: string, projectId = PROJ): Promise<string | undefined> =>
    (await getProjectWorkspaceRows(projectId)).get(workspaceId)?.groupId

  describe('createWorkspaceGroup', () => {
    it('files its founding workspace, and pushes a snapshot', async () => {
      await create('sid-1')
      const before = pushes

      const group = await createWorkspaceGroup(PROJ, '  release   train ', 'sid-1')

      // Names take the same normalization a workspace title does.
      expect(group).toMatchObject({ projectId: PROJ, name: 'release train', pinned: false })
      expect(await groupOf('sid-1')).toBe(group.groupId)
      expect(pushes - before).toBe(1)
    })

    it('is born pinned when it is born empty, so it can be seen and removed', async () => {
      const group = await createWorkspaceGroup(PROJ, 'release', null)

      // Pinned is what lists a memberless group; an unpinned one would be
      // invisible to every surface, and so undeletable.
      expect(group).toMatchObject({ name: 'release', pinned: true })
      expect((await listWorkspaceGroupRows(PROJ)).map((g) => g.groupId)).toEqual([group.groupId])

      // And it still takes members afterwards, like any other group.
      await create('sid-1')
      await setWorkspaceGroup(PROJ, 'sid-1', group.groupId)
      expect(await groupOf('sid-1')).toBe(group.groupId)
    })

    it('refuses a founding workspace the project does not have', async () => {
      // An empty group is unreachable — nothing lists an unpinned group with
      // no members, so nothing could ever delete it. The insert has to go back
      // with the failed stamp.
      await expect(createWorkspaceGroup(PROJ, 'release', 'nope')).rejects.toThrow(ServerError)
      expect(await listWorkspaceGroupRows(PROJ)).toEqual([])

      await create('sid-1', OTHER)
      await expect(createWorkspaceGroup(PROJ, 'release', 'sid-1')).rejects.toThrow(ServerError)
      expect(await listWorkspaceGroupRows(PROJ)).toEqual([])
    })

    it('keeps each group to its own project', async () => {
      await create('sid-1')
      await create('sid-2', OTHER)
      const mine = await createWorkspaceGroup(PROJ, 'mine', 'sid-1')
      await createWorkspaceGroup(OTHER, 'theirs', 'sid-2')

      expect((await listWorkspaceGroupRows(PROJ)).map((g) => g.name)).toEqual(['mine'])
      expect((await listWorkspaceGroupRows()).map((g) => g.name).sort()).toEqual(['mine', 'theirs'])
      // The founding stamp is scoped too — a same-named workspace in another
      // project is untouched.
      expect(await groupOf('sid-1')).toBe(mine.groupId)
      expect(await groupOf('sid-2', PROJ)).toBeUndefined()
    })
  })

  describe('renameWorkspaceGroup', () => {
    it('renames, and leaves a blank name alone', async () => {
      await create('sid-1')
      const group = await createWorkspaceGroup(PROJ, 'release', 'sid-1')

      await renameWorkspaceGroup(PROJ, group.groupId, ' shipping  soon ')
      expect((await listWorkspaceGroupRows(PROJ))[0]?.name).toBe('shipping soon')

      // A group is only ever identified by its name, so there is nothing for a
      // blank one to fall back to.
      await renameWorkspaceGroup(PROJ, group.groupId, '   ')
      expect((await listWorkspaceGroupRows(PROJ))[0]?.name).toBe('shipping soon')
    })
  })

  describe('setWorkspaceGroupPinned', () => {
    it('pins and unpins, pushing each time', async () => {
      await create('sid-1')
      const group = await createWorkspaceGroup(PROJ, 'release', 'sid-1')
      const before = pushes

      await setWorkspaceGroupPinned(PROJ, group.groupId, true)
      expect((await listWorkspaceGroupRows(PROJ))[0]?.pinned).toBe(true)

      await setWorkspaceGroupPinned(PROJ, group.groupId, false)
      expect((await listWorkspaceGroupRows(PROJ))[0]?.pinned).toBe(false)
      expect(pushes - before).toBe(2)
    })
  })

  describe('deleteWorkspaceGroup', () => {
    it('releases every member — running, stopped, queued or drafted — back to the default list', async () => {
      await create('live')
      await create('dead')
      const group = await createWorkspaceGroup(PROJ, 'release', 'live')
      await setWorkspaceGroup(PROJ, 'dead', group.groupId)
      await recordWorkspaceStopped(PROJ, 'dead')
      const settings = { prompt: 'p', tool: 'claude', mode: 'tui', permissionMode: 'bypass', groupId: group.groupId } as const
      const queued = await insertQueuedWorkspace(PROJ, { parentWorkspaceId: 'live' }, {
        ...settings, model: 'opus', branch: 'main',
      })
      await insertDraftWorkspace(PROJ, settings)

      await deleteWorkspaceGroup(PROJ, group.groupId)

      expect(await listWorkspaceGroupRows(PROJ)).toEqual([])
      expect(await groupOf('live')).toBeUndefined()
      expect(await groupOf('dead')).toBeUndefined()
      expect((await getQueuedWorkspaceRow(queued.id))?.groupId).toBeUndefined()
      expect((await listDraftWorkspaceRows())[0].groupId).toBeUndefined()
    })

    it('leaves another group and its members alone', async () => {
      await create('sid-1')
      await create('sid-2')
      const doomed = await createWorkspaceGroup(PROJ, 'doomed', 'sid-1')
      const kept = await createWorkspaceGroup(PROJ, 'kept', 'sid-2')

      await deleteWorkspaceGroup(PROJ, doomed.groupId)

      expect((await listWorkspaceGroupRows(PROJ)).map((g) => g.groupId)).toEqual([kept.groupId])
      expect(await groupOf('sid-2')).toBe(kept.groupId)
    })
  })

  describe('setWorkspaceGroup', () => {
    it('moves a workspace between groups and back to the default list', async () => {
      await create('sid-1')
      const from = await createWorkspaceGroup(PROJ, 'from', 'sid-1')
      await create('sid-2')
      const to = await createWorkspaceGroup(PROJ, 'to', 'sid-2')

      await setWorkspaceGroup(PROJ, 'sid-1', to.groupId)
      expect(await groupOf('sid-1')).toBe(to.groupId)

      await setWorkspaceGroup(PROJ, 'sid-1', null)
      expect(await groupOf('sid-1')).toBeUndefined()
      // The group it left still exists — emptying one never deletes it, which
      // is what lets a hidden group come back when a member restarts.
      expect((await listWorkspaceGroupRows(PROJ)).map((g) => g.groupId).sort())
        .toEqual([from.groupId, to.groupId].sort())
    })

    it('refuses a group the project does not have', async () => {
      await create('sid-1')
      // The sidebar acts on a snapshot, so a drop can name a group another
      // client has just deleted. That has to fail loudly rather than file the
      // workspace somewhere nothing lists.
      await expect(setWorkspaceGroup(PROJ, 'sid-1', 'gone')).rejects.toThrow(ServerError)
      expect(await groupOf('sid-1')).toBeUndefined()

      await create('sid-2', OTHER)
      const theirs = await createWorkspaceGroup(OTHER, 'theirs', 'sid-2')
      await expect(setWorkspaceGroup(PROJ, 'sid-1', theirs.groupId)).rejects.toThrow(ServerError)
    })

    it('refuses a workspace the project does not have', async () => {
      await create('sid-1')
      const group = await createWorkspaceGroup(PROJ, 'release', 'sid-1')
      // Both ends are checked: a move that matched no row would otherwise
      // report success having filed nothing.
      await expect(setWorkspaceGroup(PROJ, 'nope', group.groupId)).rejects.toThrow(ServerError)
      await expect(setWorkspaceGroup(PROJ, 'nope', null)).rejects.toThrow(ServerError)
    })

    it('pushes a snapshot on a move, so the sidebar regroups', async () => {
      await create('sid-1')
      const group = await createWorkspaceGroup(PROJ, 'release', 'sid-1')
      const before = pushes
      await setWorkspaceGroup(PROJ, 'sid-1', null)
      await setWorkspaceGroup(PROJ, 'sid-1', group.groupId)
      expect(pushes - before).toBe(2)
    })
  })

  describe('deleteProjectWorkspaceGroups', () => {
    it('forgets one project\'s groups and no other\'s', async () => {
      await create('sid-1')
      await create('sid-2', OTHER)
      await createWorkspaceGroup(PROJ, 'mine', 'sid-1')
      await createWorkspaceGroup(OTHER, 'theirs', 'sid-2')

      await deleteProjectWorkspaceGroups(PROJ)

      expect(await listWorkspaceGroupRows(PROJ)).toEqual([])
      expect((await listWorkspaceGroupRows(OTHER)).map((g) => g.name)).toEqual(['theirs'])
    })
  })
})
