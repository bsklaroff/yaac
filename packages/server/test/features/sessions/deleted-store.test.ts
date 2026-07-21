import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getDb, closeDb } from '#platform/db/client'
import { deletedSessions } from '#platform/db/schema'
import {
  recordSessionDeleted,
  recordDeathSeen,
  listDeletedInfo,
  clearSessionDeleted,
} from '#features/sessions/deleted-store'

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

    const proj = await listDeletedInfo('proj')
    expect([...proj.keys()].sort()).toEqual(['sid-1', 'sid-2'])
    expect(proj.get('sid-1')?.deletedAt).toBeInstanceOf(Date)

    const other = await listDeletedInfo('other')
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
    expect((await listDeletedInfo('proj')).get('sid-1')?.deletedAt.getTime()).toBe(0)
    await recordSessionDeleted('proj', 'sid-1')
    expect((await listDeletedInfo('proj')).get('sid-1')!.deletedAt.getTime()).toBeGreaterThan(0)
  })

  it('round-trips a death cause', async () => {
    await recordSessionDeleted('proj', 'sid-1', {
      reason: 'oom',
      detail: 'exit code 137',
    })
    const row = (await listDeletedInfo('proj')).get('sid-1')
    expect(row?.deathReason).toBe('oom')
    expect(row?.deathDetail).toBe('exit code 137')
  })

  it('a causeless record leaves the death columns unset', async () => {
    await recordSessionDeleted('proj', 'sid-1')
    const row = (await listDeletedInfo('proj')).get('sid-1')
    expect(row?.deathReason).toBeUndefined()
    expect(row?.deathDetail).toBeUndefined()
  })

  it('a causeless re-record clears a previous death cause', async () => {
    await recordSessionDeleted('proj', 'sid-1', { reason: 'crashed', detail: 'exit code 1' })
    await recordSessionDeleted('proj', 'sid-1')
    const row = (await listDeletedInfo('proj')).get('sid-1')
    expect(row?.deathReason).toBeUndefined()
    expect(row?.deathDetail).toBeUndefined()
  })

  it('a caused re-record overwrites a previous cause', async () => {
    await recordSessionDeleted('proj', 'sid-1', { reason: 'crashed', detail: 'exit code 1' })
    await recordSessionDeleted('proj', 'sid-1', { reason: 'oom' })
    const row = (await listDeletedInfo('proj')).get('sid-1')
    expect(row?.deathReason).toBe('oom')
    expect(row?.deathDetail).toBeUndefined()
  })

  it('a fresh record is unseen; recordDeathSeen marks it seen', async () => {
    await recordSessionDeleted('proj', 'sid-1', { reason: 'oom' })
    expect((await listDeletedInfo('proj')).get('sid-1')?.seen).toBe(false)
    await recordDeathSeen('proj', 'sid-1')
    expect((await listDeletedInfo('proj')).get('sid-1')?.seen).toBe(true)
  })

  it('a re-record resets seen so a re-died reused id re-flags', async () => {
    await recordSessionDeleted('proj', 'sid-1', { reason: 'oom' })
    await recordDeathSeen('proj', 'sid-1')
    expect((await listDeletedInfo('proj')).get('sid-1')?.seen).toBe(true)
    // Session restarted and died again → re-record must clear the seen mark.
    await recordSessionDeleted('proj', 'sid-1', { reason: 'crashed' })
    expect((await listDeletedInfo('proj')).get('sid-1')?.seen).toBe(false)
  })

  it('recordDeathSeen is a no-op for a session with no row', async () => {
    await expect(recordDeathSeen('proj', 'ghost')).resolves.toBeUndefined()
    expect((await listDeletedInfo('proj')).size).toBe(0)
  })

  it('clearSessionDeleted removes only the targeted row', async () => {
    await recordSessionDeleted('proj', 'sid-1')
    await recordSessionDeleted('proj', 'sid-2')
    await clearSessionDeleted('proj', 'sid-1')
    expect([...(await listDeletedInfo('proj')).keys()]).toEqual(['sid-2'])
  })

  it('listDeletedInfo returns an empty map for an unknown project', async () => {
    expect((await listDeletedInfo('nope')).size).toBe(0)
  })
})
