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
import { recordTestProject } from '@yaac/test-utils/project-fixture'

const ONE = '0a0a0a0a-0000-4000-8000-000000000001'
const EMPTY = '0a0a0a0a-0000-4000-8000-000000000002'
const BULK = '0a0a0a0a-0000-4000-8000-000000000003'
const OTHER = '0a0a0a0a-0000-4000-8000-000000000004'

/**
 * One data dir serves the file, since each fresh one costs a PGlite boot and
 * migration replay. Each case uses its own project to stay isolated.
 */
describe('workspace death read-marks', () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = await createTempDataDir()
    for (const [id, name] of [[ONE, 'one'], [EMPTY, 'empty'], [BULK, 'bulk'], [OTHER, 'other']]) {
      await recordTestProject(id, { name })
    }
  })

  afterAll(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  const seen = async (
    projectId: string, workspaceId: string,
  ): Promise<boolean | undefined> =>
    (await listWorkspaceRows(projectId)).find((r) => r.workspaceId === workspaceId)?.deathSeen

  it('marks a recorded death seen on its session row', async () => {
    // Seed an abnormal death (unseen by default).
    await recordWorkspaceCreated({ projectId: ONE, workspaceId: 'sid-1' })
    await recordWorkspaceStopped(ONE, 'sid-1', { reason: 'oom' })
    expect(await seen(ONE, 'sid-1')).toBe(false)

    const client = makeTestApiClient(buildApp({ buildId: 'test' }))
    const res = await client.workspace['mark-death-seen'].$post({
      json: { projectId: ONE, workspaceId: 'sid-1' },
    })
    expect(res.status).toBe(204)

    expect(await seen(ONE, 'sid-1')).toBe(true)
  })

  it('is a 204 no-op for a session with no row (best-effort)', async () => {
    const client = makeTestApiClient(buildApp({ buildId: 'test' }))
    const res = await client.workspace['mark-death-seen'].$post({
      json: { projectId: EMPTY, workspaceId: 'ghost' },
    })
    expect(res.status).toBe(204)
    expect(await listWorkspaceRows(EMPTY)).toEqual([])
  })

  it('rejects a malformed body', async () => {
    const client = makeTestApiClient(buildApp({ buildId: 'test' }))
    const res = await client.workspace['mark-death-seen'].$post({
      // @ts-expect-error — workspaceId is required
      json: { projectId: ONE },
    })
    expect(res.status).toBe(400)
  })

  it('marks every death in the project seen at once, scoped to that project', async () => {
    // Two deaths and a plain delete here, plus a death in another project.
    // The request names the project, which the route resolves to its id.
    await recordWorkspaceCreated({ projectId: BULK, workspaceId: 'bulk-1' })
    await recordWorkspaceCreated({ projectId: BULK, workspaceId: 'bulk-2' })
    await recordWorkspaceCreated({ projectId: BULK, workspaceId: 'bulk-3' })
    await recordWorkspaceCreated({ projectId: OTHER, workspaceId: 'bulk-4' })
    await recordWorkspaceStopped(BULK, 'bulk-1', { reason: 'oom' })
    await recordWorkspaceStopped(BULK, 'bulk-2', { reason: 'evicted' })
    await recordWorkspaceStopped(BULK, 'bulk-3') // user-initiated: never a death
    await recordWorkspaceStopped(OTHER, 'bulk-4', { reason: 'crashed' })

    const client = makeTestApiClient(buildApp({ buildId: 'test' }))
    const res = await client.workspace['mark-all-deaths-seen'].$post({ json: { projectId: 'bulk' } })
    expect(res.status).toBe(204)

    expect(await seen(BULK, 'bulk-1')).toBe(true)
    expect(await seen(BULK, 'bulk-2')).toBe(true)
    // A plain delete has no death to acknowledge, and the other project's death
    // keeps flagging.
    expect(await seen(BULK, 'bulk-3')).toBe(false)
    expect(await seen(OTHER, 'bulk-4')).toBe(false)
  })

  it('rejects a mark-all with no project', async () => {
    const client = makeTestApiClient(buildApp({ buildId: 'test' }))
    // @ts-expect-error — projectId is required
    const res = await client.workspace['mark-all-deaths-seen'].$post({ json: {} })
    expect(res.status).toBe(400)
  })
})
