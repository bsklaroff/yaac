import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { cleanupTempDir, createTempDataDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorktreeDriver } from '@yaac/test-utils/fake-driver'
import { closeDb } from '#db/client'
import { getProjectWorktreeRows, recordWorktreeCreated } from '#db/worktree-store'
import { listWorktreeAgentSessions, recordAgentSessions } from '#db/agent-session-store'
import { deleteWorktree } from '#domain/worktrees/delete'
import { opencodeDataDir, repoDir, worktreeDir, worktreeStateDir } from '@yaac/shared/project-paths'
import { ServerError } from '@yaac/shared/errors'

const SLUG = 'demo'

/**
 * Everything a worktree owns on disk, staged as a create would leave it —
 * including the `locked` file worktree setup writes into the git admin dir,
 * which has to be cleared first or it outlives the checkout it protects.
 */
async function stageWorktreeOnDisk(worktreeId: string): Promise<{
  checkout: string
  admin: string
  opencode: string
  state: string
}> {
  const checkout = worktreeDir(SLUG, worktreeId)
  const admin = path.join(repoDir(SLUG), '.git', 'worktrees', worktreeId)
  const opencode = opencodeDataDir(SLUG, worktreeId)
  const state = worktreeStateDir(SLUG, worktreeId)
  for (const dir of [checkout, admin, opencode, state]) await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(checkout, 'uncommitted.txt'), 'work in progress\n')
  await fs.writeFile(path.join(admin, 'locked'), 'yaac\n')
  return { checkout, admin, opencode, state }
}

/** A worktree with the row and the first conversation every create writes. */
async function seedWorktree(worktreeId: string): Promise<void> {
  await recordWorktreeCreated({ projectSlug: SLUG, worktreeId })
  await recordAgentSessions(SLUG, worktreeId, [
    { tool: 'claude', agentSessionId: `conv-${worktreeId}` },
  ])
}

const rowOf = async (worktreeId: string) =>
  (await getProjectWorktreeRows(SLUG)).get(worktreeId)

describe('deleteWorktree', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    // Nothing running, which is what a stopped worktree looks like to the
    // substrate. Cases that need one override `find`.
    installFakeWorktreeDriver()
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('removes everything the worktree had on disk, and the rows that named it', async () => {
    await seedWorktree('wt-done')
    const dirs = await stageWorktreeOnDisk('wt-done')

    await expect(deleteWorktree('wt-done')).resolves.toEqual({
      projectSlug: SLUG, worktreeId: 'wt-done',
    })

    // The checkout is the point — it is where the installed dependencies and
    // the uncommitted diff are, and nothing else in the product reclaims it.
    for (const dir of Object.values(dirs)) await expect(fs.access(dir)).rejects.toThrow()
    expect(await rowOf('wt-done')).toBeUndefined()
    // The links go with the row: a worktree that no longer exists must not
    // leave conversations behind that only it ever named.
    expect(await listWorktreeAgentSessions(SLUG, 'wt-done')).toEqual([])
  })

  // A prefix is what every surface prints and what a person types.
  it('resolves an id prefix, and leaves every other worktree alone', async () => {
    await seedWorktree('wt-aaaa-1111')
    await seedWorktree('wt-bbbb-2222')
    const doomed = await stageWorktreeOnDisk('wt-aaaa-1111')
    const keeper = await stageWorktreeOnDisk('wt-bbbb-2222')

    await deleteWorktree('wt-aaaa')

    await expect(fs.access(doomed.checkout)).rejects.toThrow()
    await expect(fs.access(keeper.checkout)).resolves.toBeUndefined()
    expect(await rowOf('wt-bbbb-2222')).toBeDefined()
  })

  // The delete rm's the directory a running workspace's agents are working
  // in, so it is the one thing this must never do on a guess.
  it('refuses a worktree that still has a runtime, and touches nothing', async () => {
    await seedWorktree('wt-live')
    const dirs = await stageWorktreeOnDisk('wt-live')
    installFakeWorktreeDriver({
      find: () => Promise.resolve(handleFixture({ workspaceId: 'wt-live', projectSlug: SLUG })),
    })

    await expect(deleteWorktree('wt-live')).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(fs.access(dirs.checkout)).resolves.toBeUndefined()
    expect(await rowOf('wt-live')).toBeDefined()
  })

  // Fails CLOSED: "I could not ask" is not "nothing is running", and the
  // recorded row a resolver would happily fall back to says nothing about
  // whether a pod is holding this checkout right now.
  it('propagates an unreachable substrate rather than deleting on the row alone', async () => {
    await seedWorktree('wt-unknown')
    const dirs = await stageWorktreeOnDisk('wt-unknown')
    installFakeWorktreeDriver({
      find: () => Promise.reject(new ServerError('RUNTIME_UNAVAILABLE', 'no cluster')),
    })

    await expect(deleteWorktree('wt-unknown')).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
    })
    await expect(fs.access(dirs.checkout)).resolves.toBeUndefined()
    expect(await rowOf('wt-unknown')).toBeDefined()
  })

  it('reports an unknown worktree as NOT_FOUND', async () => {
    await expect(deleteWorktree('wt-ghost')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  // The row is the last name anything has for the bytes, so a delete that
  // could not finish keeps the worktree listed and retryable rather than
  // stranding whatever is left.
  it('keeps the row when the bytes could not all go', async () => {
    await seedWorktree('wt-stuck')
    const { checkout } = await stageWorktreeOnDisk('wt-stuck')
    // A checkout the server cannot remove: the parent dir denies the unlink.
    await fs.chmod(path.dirname(checkout), 0o500)

    try {
      await expect(deleteWorktree('wt-stuck')).rejects.toMatchObject({ code: 'INTERNAL' })
      expect(await rowOf('wt-stuck')).toBeDefined()
    } finally {
      await fs.chmod(path.dirname(checkout), 0o700)
    }
  })
})
