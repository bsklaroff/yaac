import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { buildApp } from '@yaac/server/main/server'
import { makeTestApiClient } from '@yaac/test-utils/api'
import { closeDb } from '@yaac/server/db/client'
import {
  recordWorkspaceCreated,
  recordWorkspaceStopped,
  listWorkspaceRows,
} from '@yaac/server/db/workspace-store'

/**
 * One data dir for the file, not one per test: a fresh dir costs a PGlite
 * boot plus a migration replay, which dwarfed these five route assertions.
 * Isolation comes from the project slug instead — each case owns its own,
 * so a shared dir carries no state between them.
 */
describe('workspace death read-marks', () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = await createTempDataDir()
  })

  afterAll(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  const seen = async (
    projectSlug: string, workspaceId: string,
  ): Promise<boolean | undefined> =>
    (await listWorkspaceRows(projectSlug)).find((r) => r.workspaceId === workspaceId)?.deathSeen

  it('marks a recorded death seen on its session row', async () => {
    // Seed an abnormal death (unseen by default).
    await recordWorkspaceCreated({ projectSlug: 'one', workspaceId: 'sid-1' })
    await recordWorkspaceStopped('one', 'sid-1', { reason: 'oom' })
    expect(await seen('one', 'sid-1')).toBe(false)

    const client = makeTestApiClient(buildApp({ buildId: 'test' }))
    const res = await client.workspace['mark-death-seen'].$post({
      json: { projectSlug: 'one', workspaceId: 'sid-1' },
    })
    expect(res.status).toBe(204)

    expect(await seen('one', 'sid-1')).toBe(true)
  })

  it('is a 204 no-op for a session with no row (best-effort)', async () => {
    const client = makeTestApiClient(buildApp({ buildId: 'test' }))
    const res = await client.workspace['mark-death-seen'].$post({
      json: { projectSlug: 'empty', workspaceId: 'ghost' },
    })
    expect(res.status).toBe(204)
    expect(await listWorkspaceRows('empty')).toEqual([])
  })

  it('rejects a malformed body', async () => {
    const client = makeTestApiClient(buildApp({ buildId: 'test' }))
    const res = await client.workspace['mark-death-seen'].$post({
      // @ts-expect-error — workspaceId is required
      json: { projectSlug: 'proj' },
    })
    expect(res.status).toBe(400)
  })

  it('marks every death in the project seen at once, scoped to that project', async () => {
    // Two deaths and a plain delete here, plus a death in another project that
    // must be left alone.
    await recordWorkspaceCreated({ projectSlug: 'bulk', workspaceId: 'bulk-1' })
    await recordWorkspaceCreated({ projectSlug: 'bulk', workspaceId: 'bulk-2' })
    await recordWorkspaceCreated({ projectSlug: 'bulk', workspaceId: 'bulk-3' })
    await recordWorkspaceCreated({ projectSlug: 'other', workspaceId: 'bulk-4' })
    await recordWorkspaceStopped('bulk', 'bulk-1', { reason: 'oom' })
    await recordWorkspaceStopped('bulk', 'bulk-2', { reason: 'evicted' })
    await recordWorkspaceStopped('bulk', 'bulk-3') // user-initiated: never a death
    await recordWorkspaceStopped('other', 'bulk-4', { reason: 'crashed' })

    const client = makeTestApiClient(buildApp({ buildId: 'test' }))
    const res = await client.workspace['mark-all-deaths-seen'].$post({ json: { projectSlug: 'bulk' } })
    expect(res.status).toBe(204)

    expect(await seen('bulk', 'bulk-1')).toBe(true)
    expect(await seen('bulk', 'bulk-2')).toBe(true)
    // A plain delete has no death to acknowledge, and the other project's death
    // keeps flagging.
    expect(await seen('bulk', 'bulk-3')).toBe(false)
    expect(await seen('other', 'bulk-4')).toBe(false)
  })

  it('rejects a mark-all with no project', async () => {
    const client = makeTestApiClient(buildApp({ buildId: 'test' }))
    // @ts-expect-error — projectSlug is required
    const res = await client.workspace['mark-all-deaths-seen'].$post({ json: {} })
    expect(res.status).toBe(400)
  })
})
