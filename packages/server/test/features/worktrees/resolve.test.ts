import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { _resetHerdForTests, _setHerdForTests, type WorkspaceHandle } from '#herd'
import { resolveWorktreeContainer } from '#features/worktrees/resolve'
import { ServerError } from '@yaac/shared/errors'

/**
 * The herd is the boundary here: which workspace an id names, and whether it
 * is running, is the substrate's answer (asserted in test/herd/), and what
 * this module adds is the error vocabulary the routes above it rely on.
 */
const find = vi.fn<
  (idOrName: string, opts?: { preferCache?: boolean }) => Promise<WorkspaceHandle | undefined>
>()

function handle(over: Partial<WorkspaceHandle> = {}): WorkspaceHandle {
  return {
    workspaceId: 'abc123def456',
    projectSlug: 'proj',
    jobName: 'yaac-proj-abc123',
    tool: 'claude',
    running: true,
    state: 'running',
    labels: {},
    createdAtMs: 0,
    prewarmed: false,
    ...over,
  }
}

describe('resolveWorktreeContainer', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    find.mockReset().mockResolvedValue(undefined)
    _setHerdForTests({ workspaces: { find } })
  })

  afterEach(async () => {
    _resetHerdForTests()
    await cleanupTempDir(tmpDir)
  })

  it('throws NOT_FOUND when no workspace matches the id', async () => {
    await expect(resolveWorktreeContainer('nope')).rejects.toBeInstanceOf(ServerError)
    await expect(resolveWorktreeContainer('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('throws NOT_FOUND for an unknown id regardless of requireRunning', async () => {
    await expect(
      resolveWorktreeContainer('nope', { requireRunning: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  // Every session endpoint resolves through here and several are polled, so
  // the cache-preferring lookup is what keeps them off a subprocess.
  it('asks for the cache-preferred match and returns the container', async () => {
    find.mockResolvedValue(handle())
    expect(await resolveWorktreeContainer('abc123', { requireRunning: true })).toEqual({
      jobName: 'yaac-proj-abc123',
      worktreeId: 'abc123def456',
      projectSlug: 'proj',
      state: 'running',
    })
    expect(find).toHaveBeenCalledWith('abc123', { preferCache: true })
  })

  it('reports a non-running workspace as CONFLICT only when the caller requires running', async () => {
    find.mockResolvedValue(handle({ running: false, state: 'pending' }))
    await expect(
      resolveWorktreeContainer('abc123', { requireRunning: true }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    // Without the flag the same workspace resolves, carrying its state.
    expect(await resolveWorktreeContainer('abc123')).toMatchObject({ state: 'pending' })
  })

  // The herd distinguishes "no match" from "could not ask"; this path must
  // not flatten the second into a NOT_FOUND the client would act on.
  it('lets a substrate failure through', async () => {
    find.mockRejectedValue(new ServerError('RUNTIME_UNAVAILABLE', 'connection refused'))
    await expect(resolveWorktreeContainer('abc123')).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
    })
  })
})
