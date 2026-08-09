import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getWorktreeBlockedHosts, getWorktreeDetail, getWorktreePrompt } from '#features/worktrees/detail'
import { _resetHerdForTests, _setHerdForTests } from '#herd'
import { ServerError } from '@yaac/shared/errors'

describe('session detail helpers', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    // A herd running nothing: every helper here resolves the workspace first,
    // so this is what proves each one refuses rather than half-answering.
    _setHerdForTests({ workspaces: { find: () => Promise.resolve(undefined) } })
  })

  afterEach(async () => {
    _resetHerdForTests()
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
