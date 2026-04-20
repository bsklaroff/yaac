import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import { getSessionBlockedHosts, getSessionDetail, getSessionPrompt } from '@/lib/session/detail'
import { DaemonError } from '@/lib/daemon/errors'

describe('session detail helpers', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('getSessionDetail throws NOT_FOUND for unknown ids', async () => {
    await expect(getSessionDetail('nonexistent-session')).rejects.toBeInstanceOf(DaemonError)
    await expect(getSessionDetail('nonexistent-session')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('getSessionBlockedHosts throws NOT_FOUND for unknown ids', async () => {
    await expect(getSessionBlockedHosts('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('getSessionPrompt throws NOT_FOUND for unknown ids', async () => {
    await expect(getSessionPrompt('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
