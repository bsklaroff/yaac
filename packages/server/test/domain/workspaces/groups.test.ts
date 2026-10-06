import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#db/client'
import { createWorkspaceGroup, listWorkspaceGroupRows } from '#db/group-store'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { listWorkspaceGroups, resolveGroup } from '#domain/workspaces/groups'
import { ServerError } from '@yaac/shared/errors'

const OTHER = '795f3202-b17c-46bc-8d4b-771d8c6c9eaf'

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'

describe('workspace groups (domain)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  describe('listWorkspaceGroups', () => {
    it('projects every group of a project onto the wire, unfiltered', async () => {
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'sid-1' })
      const founded = await createWorkspaceGroup(PROJ, 'release train', 'sid-1')
      const empty = await createWorkspaceGroup(PROJ, 'later', null)
      await createWorkspaceGroup(OTHER, 'theirs', null)

      const groups = await listWorkspaceGroups(PROJ)

      // The client decides what to hide, so empty unpinned groups are listed.
      expect(groups.map((g) => g.groupId).sort())
        .toEqual([founded.groupId, empty.groupId].sort())
      expect(groups.find((g) => g.groupId === founded.groupId)).toMatchObject({
        projectId: PROJ, name: 'release train', pinned: false,
      })
      // UTC 'YYYY-MM-DD HH:MM:SS'; groups display in this order.
      expect(groups[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)

      expect((await listWorkspaceGroups()).map((g) => g.projectId).sort())
        .toEqual([OTHER, PROJ, PROJ].sort())
    })
  })

  describe('resolveGroup', () => {
    it('takes an id exactly, and a name however it was typed', async () => {
      const group = await createWorkspaceGroup(PROJ, 'Release Train', null)

      expect(await resolveGroup(PROJ, group.groupId))
        .toEqual({ groupId: group.groupId, name: 'Release Train' })
      expect(await resolveGroup(PROJ, 'Release Train'))
        .toEqual({ groupId: group.groupId, name: 'Release Train' })
      // Names match after whitespace normalization and case folding. The
      // stored name is returned either way.
      expect(await resolveGroup(PROJ, '  release   train '))
        .toEqual({ groupId: group.groupId, name: 'Release Train' })
    })

    it('refuses an unknown name rather than inventing one', async () => {
      await createWorkspaceGroup(PROJ, 'release', null)
      // Another project's group does not count.
      await createWorkspaceGroup(OTHER, 'staging', null)

      await expect(resolveGroup(PROJ, 'staging')).rejects.toThrow(ServerError)
      await expect(resolveGroup(PROJ, 'staging')).rejects.toThrow(/No such workspace group/)
    })

    it('refuses an ambiguous name instead of guessing which was meant', async () => {
      // Names are not unique, and filing into the wrong group is silent.
      const first = await createWorkspaceGroup(PROJ, 'release', null)
      const second = await createWorkspaceGroup(PROJ, 'release', null)

      await expect(resolveGroup(PROJ, 'release')).rejects.toThrow(/names 2 groups/)
      // An id, which the error suggests, is never ambiguous.
      expect((await resolveGroup(PROJ, second.groupId)).groupId).toBe(second.groupId)
      expect((await resolveGroup(PROJ, first.groupId)).groupId).toBe(first.groupId)
    })

    it('creates the group when the caller is naming one, and only then', async () => {
      const fresh = await resolveGroup(PROJ, 'fresh', { create: true })

      const rows = await listWorkspaceGroupRows(PROJ)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ groupId: fresh.groupId, name: 'fresh', pinned: true })

      // Naming it again resolves to the existing group.
      expect(await resolveGroup(PROJ, 'fresh', { create: true })).toEqual(fresh)
      expect(await listWorkspaceGroupRows(PROJ)).toHaveLength(1)

      // Also with extra whitespace: the lookup must normalize before
      // comparing, or this would create a duplicate.
      const spaced = await resolveGroup(PROJ, ' fresh  ', { create: true })
      expect(spaced).toEqual(fresh)
      expect(await listWorkspaceGroupRows(PROJ)).toHaveLength(1)

      // A new name is stored normalized.
      const spacedNew = await resolveGroup(PROJ, 'release  train', { create: true })
      expect(spacedNew.name).toBe('release train')

      // A blank name would create a group nothing could name.
      await expect(resolveGroup(PROJ, '   ', { create: true })).rejects.toThrow(ServerError)
      expect(await listWorkspaceGroupRows(PROJ)).toHaveLength(2)
    })
  })
})
