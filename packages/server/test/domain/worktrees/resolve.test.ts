import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installFakeWorktreeDriver } from '@yaac/test-utils/fake-driver'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { resolveWorktreeContainer } from '#domain/worktrees/resolve'
import { ServerError } from '@yaac/shared/errors'
import type { RuntimeHandle } from '#drivers/contract'

/**
 * The substrate lookup is the boundary here: which workspace an id names,
 * and whether it is running, is `findWorkspace`'s answer (asserted in
 * locate.test.ts), and what this module adds is the error vocabulary the
 * routes above it rely on.
 */
const find = vi.fn()

function handle(over: Partial<RuntimeHandle> = {}): RuntimeHandle {
  return {
    workspaceId: 'abc123def456',
    projectSlug: 'proj',
    jobName: 'yaac-proj-abc123',
    tool: 'claude',
    mode: 'tui',
    running: true,
    state: 'running',
    labels: {},
    createdAtMs: 0,
    prewarmed: false,
    terminating: false,
    deathCause: { reason: 'pod-stopped' },
    ...over,
  }
}

describe('resolveWorktreeContainer', () => {
  let tmpDir: string

  beforeEach(async () => {
    installFakeWorktreeDriver({ find })
    tmpDir = await createTempDataDir()
    find.mockReset().mockResolvedValue(undefined)
  })

  afterEach(async () => {
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

  // The lookup distinguishes "no match" from "could not ask"; this path must
  // not flatten the second into a NOT_FOUND the client would act on.
  it('lets a substrate failure through', async () => {
    find.mockRejectedValue(new ServerError('RUNTIME_UNAVAILABLE', 'connection refused'))
    await expect(resolveWorktreeContainer('abc123')).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
    })
  })
})
