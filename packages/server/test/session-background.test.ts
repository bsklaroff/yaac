import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getDb, closeDb } from '#lib/db/client'
import { backgroundSessions } from '#lib/db/schema'
import { listBackgroundSessionIds, setSessionBackground } from '#lib/session/background'

describe('session background pins', () => {
  let tmpDir: string

  // One PGlite per file: cold-init is the expensive part, so the tests
  // share a data dir and wipe the table instead of recreating it.
  beforeAll(async () => {
    tmpDir = await createTempDataDir()
  })

  afterAll(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  beforeEach(async () => {
    const db = await getDb()
    await db.delete(backgroundSessions)
  })

  it('pin + list round-trips per project', async () => {
    await setSessionBackground('proj', 'sid-1', true)
    await setSessionBackground('proj', 'sid-2', true)
    await setSessionBackground('other', 'sid-3', true)
    expect(await listBackgroundSessionIds('proj')).toEqual(new Set(['sid-1', 'sid-2']))
    expect(await listBackgroundSessionIds('other')).toEqual(new Set(['sid-3']))
  })

  it('re-pinning an already-pinned session is a no-op', async () => {
    await setSessionBackground('proj', 'sid-1', true)
    await setSessionBackground('proj', 'sid-1', true)
    expect(await listBackgroundSessionIds('proj')).toEqual(new Set(['sid-1']))
  })

  it('unpinning removes the pin', async () => {
    await setSessionBackground('proj', 'sid-1', true)
    await setSessionBackground('proj', 'sid-1', false)
    expect(await listBackgroundSessionIds('proj')).toEqual(new Set())
  })

  it('unpinning a never-pinned session is a no-op', async () => {
    await setSessionBackground('proj', 'sid-1', false)
    expect(await listBackgroundSessionIds('proj')).toEqual(new Set())
  })

  it('returns an empty set for a project with no pins', async () => {
    expect(await listBackgroundSessionIds('nope')).toEqual(new Set())
  })
})
