import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// No cluster in unit tests — the detail helpers' pod listing is mocked to
// an empty cluster so the NOT_FOUND paths are exercised.
vi.mock('@yaac/server/lib/k8s/pods', async () => {
  const actual = await vi.importActual<typeof podsModule>('@yaac/server/lib/k8s/pods')
  return { ...actual, listSessionPods: vi.fn().mockResolvedValue([]) }
})

import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import { getSessionBlockedHosts, getSessionDetail, getSessionPrompt } from '@yaac/server/lib/session/detail'
import { ServerError } from '@yaac/shared/errors'
import type * as podsModule from '@yaac/server/lib/k8s/pods'

describe('session detail helpers', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('getSessionDetail throws NOT_FOUND for unknown ids', async () => {
    await expect(getSessionDetail('nonexistent-session')).rejects.toBeInstanceOf(ServerError)
    await expect(getSessionDetail('nonexistent-session')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('getSessionBlockedHosts throws NOT_FOUND for unknown ids', async () => {
    await expect(getSessionBlockedHosts('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('getSessionPrompt throws NOT_FOUND for unknown ids', async () => {
    await expect(getSessionPrompt('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
