import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#platform/db/client'
import {
  SESSIONS_BACKFILLED_KEY,
  getDefaultTool,
  isFlagSet,
  setFlag,
} from '#features/projects/preferences'

/**
 * One-shot migration markers. These gate work that must happen exactly once
 * per data dir (adopting pre-existing sessions), so "has it run?" has to
 * survive a restart and be independent of whatever the migration itself
 * wrote — the reason the session backfill can't just ask whether its table
 * is empty.
 */
describe('migration flags', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('is unset until set, then stays set', async () => {
    expect(await isFlagSet(SESSIONS_BACKFILLED_KEY)).toBe(false)
    await setFlag(SESSIONS_BACKFILLED_KEY)
    expect(await isFlagSet(SESSIONS_BACKFILLED_KEY)).toBe(true)
  })

  it('is idempotent — setting twice is not an error', async () => {
    await setFlag(SESSIONS_BACKFILLED_KEY)
    await setFlag(SESSIONS_BACKFILLED_KEY)
    expect(await isFlagSet(SESSIONS_BACKFILLED_KEY)).toBe(true)
  })

  it('keys are independent, and unrelated preferences are untouched', async () => {
    await setFlag('some_other_migration')
    expect(await isFlagSet(SESSIONS_BACKFILLED_KEY)).toBe(false)
    expect(await getDefaultTool()).toBeUndefined()
  })
})
