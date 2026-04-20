import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import { resolveSessionContainer } from '@/lib/daemon/session-resolve'
import { DaemonError } from '@/lib/daemon/errors'

describe('resolveSessionContainer', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('throws NOT_FOUND when no container matches the id', async () => {
    await expect(resolveSessionContainer('nope')).rejects.toBeInstanceOf(DaemonError)
    await expect(resolveSessionContainer('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('throws NOT_FOUND for any id in a fresh data dir, regardless of requireRunning', async () => {
    await expect(
      resolveSessionContainer('nope', { requireRunning: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
