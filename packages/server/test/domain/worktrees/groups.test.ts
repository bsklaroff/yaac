import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#db/client'
import { createWorktreeGroup, listWorktreeGroupRows } from '#db/group-store'
import { recordWorktreeCreated } from '#db/worktree-store'
import { listWorktreeGroups, resolveGroupId } from '#domain/worktrees/groups'
import { ServerError } from '@yaac/shared/errors'

describe('worktree groups (domain)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  describe('listWorktreeGroups', () => {
    it('projects every group of a project onto the wire, unfiltered', async () => {
      await recordWorktreeCreated({ projectSlug: 'proj', worktreeId: 'sid-1' })
      const founded = await createWorktreeGroup('proj', 'release train', 'sid-1')
      const empty = await createWorktreeGroup('proj', 'later', null)
      await createWorktreeGroup('other', 'theirs', null)

      const groups = await listWorktreeGroups('proj')

      // Hidden-ness is the client's to decide, so an unpinned group with no
      // live member travels too.
      expect(groups.map((g) => g.groupId).sort())
        .toEqual([founded.groupId, empty.groupId].sort())
      expect(groups.find((g) => g.groupId === founded.groupId)).toMatchObject({
        projectSlug: 'proj', name: 'release train', pinned: false,
      })
      // 'YYYY-MM-DD HH:MM:SS' UTC — the groups' display order.
      expect(groups[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)

      expect((await listWorktreeGroups()).map((g) => g.projectSlug).sort())
        .toEqual(['other', 'proj', 'proj'])
    })
  })

  describe('resolveGroupId', () => {
    it('takes an id exactly, and a name however it was typed', async () => {
      const group = await createWorktreeGroup('proj', 'Release Train', null)

      expect(await resolveGroupId('proj', group.groupId)).toBe(group.groupId)
      expect(await resolveGroupId('proj', 'Release Train')).toBe(group.groupId)
      // Same normalization the name was stored under, plus case folding —
      // what a person retypes is rarely byte-identical.
      expect(await resolveGroupId('proj', '  release   train ')).toBe(group.groupId)
    })

    it('refuses an unknown name rather than inventing one', async () => {
      await createWorktreeGroup('proj', 'release', null)
      // Scoped to the project: another project's group is as unknown as one
      // that never existed.
      await createWorktreeGroup('other', 'staging', null)

      await expect(resolveGroupId('proj', 'staging')).rejects.toThrow(ServerError)
      await expect(resolveGroupId('proj', 'staging')).rejects.toThrow(/No such worktree group/)
    })

    it('refuses an ambiguous name instead of guessing which was meant', async () => {
      // Names are not unique — nothing stops two groups sharing one, and
      // filing a worktree into the wrong one is silent.
      const first = await createWorktreeGroup('proj', 'release', null)
      const second = await createWorktreeGroup('proj', 'release', null)

      await expect(resolveGroupId('proj', 'release')).rejects.toThrow(/names 2 groups/)
      // The escape hatch the error names: an id is never ambiguous.
      expect(await resolveGroupId('proj', second.groupId)).toBe(second.groupId)
      expect(await resolveGroupId('proj', first.groupId)).toBe(first.groupId)
    })

    it('creates the group when the caller is naming one, and only then', async () => {
      const id = await resolveGroupId('proj', 'fresh', { create: true })

      const rows = await listWorktreeGroupRows('proj')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ groupId: id, name: 'fresh', pinned: true })

      // Idempotent: naming it again resolves to the group that now exists
      // rather than making a second one with the same name.
      expect(await resolveGroupId('proj', 'fresh', { create: true })).toBe(id)
      expect(await listWorktreeGroupRows('proj')).toHaveLength(1)

      // A blank name would create a group nothing could ever name again.
      await expect(resolveGroupId('proj', '   ', { create: true })).rejects.toThrow(ServerError)
      expect(await listWorktreeGroupRows('proj')).toHaveLength(1)
    })
  })
})
