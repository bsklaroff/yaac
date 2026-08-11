import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installFakeWorktreeRuntime } from '@yaac/test-utils/fake-runtime'

import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getWorktreeBlockedHosts, getWorktreeDetail, getWorktreePrompt } from '#domain/worktrees/detail'
import { ServerError } from '@yaac/shared/errors'

// Every helper here resolves the workspace through the runtime first.
const mockFind = vi.fn()

describe('session detail helpers', () => {
  let tmpDir: string

  beforeEach(async () => {
    installFakeWorktreeRuntime({ find: mockFind })
    tmpDir = await createTempDataDir()
    // A substrate running nothing: every helper here resolves the workspace
    // first, so this is what proves each one refuses rather than
    // half-answering.
    mockFind.mockReset().mockResolvedValue(undefined)
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('getWorktreeDetail throws NOT_FOUND for unknown ids', async () => {
    await expect(getWorktreeDetail('nonexistent-session')).rejects.toBeInstanceOf(ServerError)
    await expect(getWorktreeDetail('nonexistent-session')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('getWorktreeBlockedHosts throws NOT_FOUND for unknown ids', async () => {
    await expect(getWorktreeBlockedHosts('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('getWorktreePrompt throws NOT_FOUND for unknown ids', async () => {
    await expect(getWorktreePrompt('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
