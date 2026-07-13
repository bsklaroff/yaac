import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getDb, closeDb } from '#lib/db/client'
import { deletedSessions } from '#lib/db/schema'
import {
  recordSessionDeleted,
  listDeletedAt,
  clearSessionDeleted,
} from '#lib/session/deleted-store'

describe('deleted-session store', () => {
  let tmpDir: string

  // One PGlite per file: share a data dir and wipe the table between tests.
  beforeAll(async () => {
    tmpDir = await createTempDataDir()
  })

  afterAll(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  beforeEach(async () => {
    const db = await getDb()
    await db.delete(deletedSessions)
  })

  it('records a deletion time and lists it per project', async () => {
    await recordSessionDeleted('proj', 'sid-1')
    await recordSessionDeleted('proj', 'sid-2')
    await recordSessionDeleted('other', 'sid-1')

    const proj = await listDeletedAt('proj')
    expect([...proj.keys()].sort()).toEqual(['sid-1', 'sid-2'])
    expect(proj.get('sid-1')).toBeInstanceOf(Date)

    const other = await listDeletedAt('other')
    expect([...other.keys()]).toEqual(['sid-1'])
  })

  it('re-recording the same session bumps its deletion time', async () => {
    await recordSessionDeleted('proj', 'sid-1')
    // Backdate the row directly, then re-record: the upsert must overwrite.
    const db = await getDb()
    await db.update(deletedSessions).set({ deletedAt: new Date(0) }).where(and(
      eq(deletedSessions.projectSlug, 'proj'),
      eq(deletedSessions.sessionId, 'sid-1'),
    ))
    expect((await listDeletedAt('proj')).get('sid-1')?.getTime()).toBe(0)
    await recordSessionDeleted('proj', 'sid-1')
    expect((await listDeletedAt('proj')).get('sid-1')!.getTime()).toBeGreaterThan(0)
  })

  it('clearSessionDeleted removes only the targeted row', async () => {
    await recordSessionDeleted('proj', 'sid-1')
    await recordSessionDeleted('proj', 'sid-2')
    await clearSessionDeleted('proj', 'sid-1')
    expect([...(await listDeletedAt('proj')).keys()]).toEqual(['sid-2'])
  })

  it('listDeletedAt returns an empty map for an unknown project', async () => {
    expect((await listDeletedAt('nope')).size).toBe(0)
  })
})
