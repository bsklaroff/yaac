import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// No cluster in unit tests — resolveSessionContainer's pod listing is
// mocked to an empty cluster so the NOT_FOUND paths are exercised.
vi.mock('#platform/k8s/pods', async () => {
  const actual = await vi.importActual<typeof podsModule>('#platform/k8s/pods')
  return { ...actual, listSessionPods: vi.fn().mockResolvedValue([]) }
})

import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { resolveSessionContainer } from '#features/sessions/resolve'
import { ServerError } from '@yaac/shared/errors'
import type * as podsModule from '#platform/k8s/pods'

describe('resolveSessionContainer', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('throws NOT_FOUND when no container matches the id', async () => {
    await expect(resolveSessionContainer('nope')).rejects.toBeInstanceOf(ServerError)
    await expect(resolveSessionContainer('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('throws NOT_FOUND for any id in a fresh data dir, regardless of requireRunning', async () => {
    await expect(
      resolveSessionContainer('nope', { requireRunning: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
