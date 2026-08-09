import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { buildApp } from '@yaac/server/main/server'
import { makeTestApiClient } from '@yaac/test-utils/api'
import { closeDb } from '@yaac/server/platform/db/client'
import {
  recordWorktreeCreated,
  recordWorktreeStopped,
  listWorktreeRows,
} from '@yaac/server/features/records/worktree-store'

/**
 * One data dir for the file, not one per test: a fresh dir costs a PGlite
 * boot plus a migration replay, which dwarfed these five route assertions.
 * Isolation comes from the project slug instead — each case owns its own,
 * so a shared dir carries no state between them.
 */
describe('worktree death read-marks', () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = await createTempDataDir()
  })

  afterAll(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  const seen = async (
    projectSlug: string, worktreeId: string,
  ): Promise<boolean | undefined> =>
    (await listWorktreeRows(projectSlug)).find((r) => r.worktreeId === worktreeId)?.deathSeen

  it('marks a recorded death seen on its session row', async () => {
    // Seed an abnormal death (unseen by default).
    await recordWorktreeCreated({ projectSlug: 'one', worktreeId: 'sid-1' })
    await recordWorktreeStopped('one', 'sid-1', { reason: 'oom' })
    expect(await seen('one', 'sid-1')).toBe(false)

    const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
    const res = await client.worktree['mark-death-seen'].$post({
      json: { projectSlug: 'one', worktreeId: 'sid-1' },
    })
    expect(res.status).toBe(204)

    expect(await seen('one', 'sid-1')).toBe(true)
  })

  it('is a 204 no-op for a session with no row (best-effort)', async () => {
    const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
    const res = await client.worktree['mark-death-seen'].$post({
      json: { projectSlug: 'empty', worktreeId: 'ghost' },
    })
    expect(res.status).toBe(204)
    expect(await listWorktreeRows('empty')).toEqual([])
  })

  it('rejects a malformed body', async () => {
    const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
    const res = await client.worktree['mark-death-seen'].$post({
      // @ts-expect-error — worktreeId is required
      json: { projectSlug: 'proj' },
    })
    expect(res.status).toBe(400)
  })

  it('marks every death in the project seen at once, scoped to that project', async () => {
    // Two deaths and a plain delete here, plus a death in another project that
    // must be left alone.
    await recordWorktreeCreated({ projectSlug: 'bulk', worktreeId: 'sid-1' })
    await recordWorktreeCreated({ projectSlug: 'bulk', worktreeId: 'sid-2' })
    await recordWorktreeCreated({ projectSlug: 'bulk', worktreeId: 'sid-3' })
    await recordWorktreeCreated({ projectSlug: 'other', worktreeId: 'sid-4' })
    await recordWorktreeStopped('bulk', 'sid-1', { reason: 'oom' })
    await recordWorktreeStopped('bulk', 'sid-2', { reason: 'evicted' })
    await recordWorktreeStopped('bulk', 'sid-3') // user-initiated: never a death
    await recordWorktreeStopped('other', 'sid-4', { reason: 'crashed' })

    const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
    const res = await client.worktree['mark-all-deaths-seen'].$post({ json: { projectSlug: 'bulk' } })
    expect(res.status).toBe(204)

    expect(await seen('bulk', 'sid-1')).toBe(true)
    expect(await seen('bulk', 'sid-2')).toBe(true)
    // A plain delete has no death to acknowledge, and the other project's death
    // keeps flagging.
    expect(await seen('bulk', 'sid-3')).toBe(false)
    expect(await seen('other', 'sid-4')).toBe(false)
  })

  it('rejects a mark-all with no project', async () => {
    const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
    // @ts-expect-error — projectSlug is required
    const res = await client.worktree['mark-all-deaths-seen'].$post({ json: {} })
    expect(res.status).toBe(400)
  })
})
