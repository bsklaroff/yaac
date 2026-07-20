import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { projectDir } from '@yaac/shared/project-paths'
import { getDb, closeDb } from '#lib/db/client'
import { schedules } from '#lib/db/schema'
import {
  addSchedule,
  listSchedules,
  markFired,
  parseCronSpec,
  removeScheduleChecked,
} from '#lib/project/schedules'
import { ServerError } from '@yaac/shared/errors'

/** Seed the minimal on-disk project addSchedule's existence check reads. */
async function seedProject(slug: string): Promise<void> {
  const dir = projectDir(slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'project.json'),
    JSON.stringify({ slug, remoteUrl: `file:///tmp/${slug}`, addedAt: new Date().toISOString() }),
  )
}

describe('schedules store', () => {
  let tmpDir: string

  // One PGlite per file: cold-init is the expensive part, so the tests
  // share a data dir and wipe the table instead of recreating it.
  beforeAll(async () => {
    tmpDir = await createTempDataDir()
    await seedProject('proj-a')
    await seedProject('proj-b')
  })

  afterAll(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  beforeEach(async () => {
    const db = await getDb()
    await db.delete(schedules)
  })

  describe('parseCronSpec', () => {
    it('accepts a standard five-field expression', () => {
      expect(() => parseCronSpec('0 9 * * 1-5')).not.toThrow()
    })

    it('throws VALIDATION for a malformed expression', () => {
      expect(() => parseCronSpec('not a cron')).toThrow(ServerError)
      try {
        parseCronSpec('99 99 * * *')
        expect.unreachable()
      } catch (err) {
        expect((err as ServerError).code).toBe('VALIDATION')
      }
    })
  })

  describe('addSchedule', () => {
    it('persists and returns the schedule with null tool and no fires', async () => {
      const entry = await addSchedule({ projectSlug: 'proj-a', spec: '0 9 * * *', prompt: 'do the thing' })
      expect(entry.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(entry.projectSlug).toBe('proj-a')
      expect(entry.spec).toBe('0 9 * * *')
      expect(entry.prompt).toBe('do the thing')
      expect(entry.tool).toBeNull()
      expect(entry.lastFiredAt).toBeNull()
      expect(new Date(entry.createdAt).getTime()).not.toBeNaN()
      expect(await listSchedules()).toEqual([entry])
    })

    it('stores an explicit tool', async () => {
      const entry = await addSchedule({ projectSlug: 'proj-a', spec: '* * * * *', prompt: 'p', tool: 'codex' })
      expect(entry.tool).toBe('codex')
    })

    it('rejects an unknown project with NOT_FOUND', async () => {
      await expect(addSchedule({ projectSlug: 'nope', spec: '* * * * *', prompt: 'p' }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    it('rejects a bad cron spec with VALIDATION', async () => {
      await expect(addSchedule({ projectSlug: 'proj-a', spec: 'bogus', prompt: 'p' }))
        .rejects.toMatchObject({ code: 'VALIDATION' })
    })

    it('rejects a blank prompt with VALIDATION', async () => {
      await expect(addSchedule({ projectSlug: 'proj-a', spec: '* * * * *', prompt: '   ' }))
        .rejects.toMatchObject({ code: 'VALIDATION' })
    })

    it('rejects an unknown tool with VALIDATION', async () => {
      await expect(addSchedule({ projectSlug: 'proj-a', spec: '* * * * *', prompt: 'p', tool: 'gemini' }))
        .rejects.toMatchObject({ code: 'VALIDATION' })
    })
  })

  describe('listSchedules', () => {
    it('filters by project and returns all without a filter', async () => {
      const a = await addSchedule({ projectSlug: 'proj-a', spec: '0 9 * * *', prompt: 'a' })
      const b = await addSchedule({ projectSlug: 'proj-b', spec: '0 10 * * *', prompt: 'b' })
      expect((await listSchedules('proj-a')).map((s) => s.id)).toEqual([a.id])
      expect((await listSchedules('proj-b')).map((s) => s.id)).toEqual([b.id])
      expect((await listSchedules()).map((s) => s.id).sort()).toEqual([a.id, b.id].sort())
      expect(await listSchedules('proj-c')).toEqual([])
    })
  })

  describe('removeScheduleChecked', () => {
    it('removes an existing schedule', async () => {
      const entry = await addSchedule({ projectSlug: 'proj-a', spec: '* * * * *', prompt: 'p' })
      await removeScheduleChecked(entry.id)
      expect(await listSchedules()).toEqual([])
    })

    it('throws NOT_FOUND for an unknown id', async () => {
      await expect(removeScheduleChecked('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })
  })

  describe('markFired', () => {
    it('persists the fire time', async () => {
      const entry = await addSchedule({ projectSlug: 'proj-a', spec: '* * * * *', prompt: 'p' })
      const at = new Date('2026-07-20T09:00:00Z')
      await markFired(entry.id, at)
      const [row] = await listSchedules('proj-a')
      expect(row.lastFiredAt).toBe(at.toISOString())
    })
  })
})
