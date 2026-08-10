import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type * as locateModule from '#runtime/k8s/worktrees/locate'

import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getWorktreeBlockedHosts, getWorktreeDetail, getWorktreePrompt } from '#domain/worktrees/detail'
import { ServerError } from '@yaac/shared/errors'

vi.mock('#runtime/k8s/worktrees/locate', async (importOriginal) => ({
  ...(await importOriginal<typeof locateModule>()),
  findWorkspace: vi.fn(),
}))
import { findWorkspace } from '#runtime/k8s/worktrees/locate'

describe('session detail helpers', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    // A substrate running nothing: every helper here resolves the workspace
    // first, so this is what proves each one refuses rather than
    // half-answering.
    vi.mocked(findWorkspace).mockReset().mockResolvedValue(undefined)
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
