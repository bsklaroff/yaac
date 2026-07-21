import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getDb, closeDb } from '#platform/db/client'
import { sessionTitles } from '#platform/db/schema'
import {
  MAX_TITLE_LENGTH,
  normalizeTitle,
  getSessionTitles,
  setSessionTitle,
} from '#features/titles/titles'

describe('session titles', () => {
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
    await db.delete(sessionTitles)
  })

  it('normalizeTitle collapses whitespace and caps the length', () => {
    expect(normalizeTitle('  fix   the\tparser \n')).toBe('fix the parser')
    expect(normalizeTitle('')).toBe('')
    expect(normalizeTitle('x'.repeat(500))).toHaveLength(MAX_TITLE_LENGTH)
  })

  it('set + get round-trips titles per project', async () => {
    await setSessionTitle('proj', 'sid-1', 'fix the parser')
    await setSessionTitle('proj', 'sid-2', 'docs pass')
    await setSessionTitle('other', 'sid-1', 'unrelated')
    expect(await getSessionTitles('proj')).toEqual({ 'sid-1': 'fix the parser', 'sid-2': 'docs pass' })
    expect(await getSessionTitles('other')).toEqual({ 'sid-1': 'unrelated' })
  })

  it('overwrites an existing title in place', async () => {
    await setSessionTitle('proj', 'sid-1', 'first name')
    await setSessionTitle('proj', 'sid-1', 'second name')
    expect(await getSessionTitles('proj')).toEqual({ 'sid-1': 'second name' })
  })

  it('a blank title clears the entry', async () => {
    await setSessionTitle('proj', 'sid-1', 'temp name')
    await setSessionTitle('proj', 'sid-1', '   ')
    expect(await getSessionTitles('proj')).toEqual({})
  })

  it('returns {} for a project with no titles', async () => {
    expect(await getSessionTitles('nope')).toEqual({})
  })
})
