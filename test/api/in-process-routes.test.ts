import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { buildApp } from '@yaac/server/main/server'
import { asTailnet, makeTestApiClient } from '@yaac/test-utils/api'
import { closeDb } from '@yaac/server/db/client'
import {
  recordDeathSeen,
  recordWaitingSeen,
  recordWorkspaceCreated,
  recordWorkspaceStopped,
  listWorkspaceRows,
} from '@yaac/server/db/workspace-store'
import { BUILT_IN_USER_ID, seeTailnetUser } from '@yaac/server/db/user-store'
import { recordTestProject } from '@yaac/test-utils/project-fixture'

/**
 * Routes no driver feature gates, driven in process against one data dir
 * for the whole file, since each fresh one costs a PGlite boot and
 * migration replay.
 */
let tmpDir: string

beforeAll(async () => {
  tmpDir = await createTempDataDir()
})

afterAll(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

const chord = { code: 'KeyG', alt: true, ctrl: false, meta: false, shift: false }

/**
 * Order matters: the pristine-state case runs first and the reset case
 * (the only other writer) last.
 */
describe('shortcuts route', () => {
  it('GET /shortcuts/get returns no overrides initially', async () => {
    const client = makeTestApiClient(buildApp({ buildId: 'test' }))
    const res = await client.shortcuts.get.$get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ overrides: {} })
  })

  it('POST /shortcuts/set persists a rebind that GET then reflects', async () => {
    const client = makeTestApiClient(buildApp({ buildId: 'test' }))
    const set = await client.shortcuts.set.$post({ json: { id: 'new-session', chord } })
    expect(set.status).toBe(200)
    expect(await set.json()).toEqual({ ok: true })

    const get = await client.shortcuts.get.$get()
    expect(await get.json()).toEqual({ overrides: { 'new-session': chord } })
  })

  it('POST /shortcuts/set rejects a malformed chord', async () => {
    const client = makeTestApiClient(buildApp({ buildId: 'test' }))
    const res = await client.shortcuts.set.$post({
      // @ts-expect-error — chord is missing modifier flags on purpose
      json: { id: 'new-session', chord: { code: 'KeyG' } },
    })
    expect(res.status).toBe(400)
  })

  it('POST /shortcuts/reset clears every override', async () => {
    const client = makeTestApiClient(buildApp({ buildId: 'test' }))
    await client.shortcuts.set.$post({ json: { id: 'new-session', chord } })
    const reset = await client.shortcuts.reset.$post()
    expect(reset.status).toBe(200)
    const get = await client.shortcuts.get.$get()
    expect(await get.json()).toEqual({ overrides: {} })
  })
})

const ONE = '0a0a0a0a-0000-4000-8000-000000000001'
const EMPTY = '0a0a0a0a-0000-4000-8000-000000000002'
const BULK = '0a0a0a0a-0000-4000-8000-000000000003'
const OTHER = '0a0a0a0a-0000-4000-8000-000000000004'

/** Each case uses its own project to stay isolated. */
describe('workspace death read-marks', () => {
  beforeAll(async () => {
    for (const [id, name] of [[ONE, 'one'], [EMPTY, 'empty'], [BULK, 'bulk'], [OTHER, 'other']]) {
      await recordTestProject(id, { name })
    }
  })

  const seen = async (projectId: string, workspaceId: string): Promise<boolean | undefined> =>
    (await listWorkspaceRows(projectId)).find((r) => r.workspaceId === workspaceId)?.deathSeenBy.includes(BUILT_IN_USER_ID)

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

describe('workspace waiting read-marks', () => {
  // Nothing watches this workspace, so it reads as waiting in a spell with
  // no stamp, which a mark names as 0.
  it('marks the spell the request names, and 404s a workspace with no row', async () => {
    await recordWorkspaceCreated({ projectId: ONE, workspaceId: 'waiting-1' })
    const waitingSinceMs = 0

    const client = makeTestApiClient(buildApp({ buildId: 'test' }))
    const res = await client.workspace['mark-waiting-seen'].$post({
      json: { projectId: ONE, workspaceId: 'waiting-1', waitingSinceMs },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ marked: true })
    expect((await listWorkspaceRows(ONE)).find((r) => r.workspaceId === 'waiting-1')?.waitingSeenBy).toEqual([BUILT_IN_USER_ID])

    const ghost = await client.workspace['mark-waiting-seen'].$post({
      json: { projectId: ONE, workspaceId: 'ghost', waitingSinceMs },
    })
    expect(ghost.status).toBe(404)
  })
})

/**
 * A teammate's marks on the owner's workspaces, through a tailnet server.
 * The id recorded is the caller's, never one the body names, so a teammate
 * can neither mark for the owner nor clear the owner's own mark.
 */
describe('read-marks as a teammate', () => {
  const TEAM = '0a0a0a0a-0000-4000-8000-000000000005'
  const HOST = 'srv.tailnet.ts.net'
  const app = (): ReturnType<typeof buildApp> => buildApp({ buildId: 'test', access: () => 'tailnet' })
  let teammate: string

  beforeAll(async () => {
    vi.stubEnv('YAAC_ALLOWED_HOSTS', HOST)
    teammate = await seeTailnetUser('bob@example.com', 'bob')
    await recordTestProject(TEAM, { name: 'team' })
    for (const id of ['team-dead', 'team-dead-2', 'team-waiting']) {
      await recordWorkspaceCreated({ projectId: TEAM, workspaceId: id })
    }
    await recordWorkspaceStopped(TEAM, 'team-dead', { reason: 'oom' })
    await recordWorkspaceStopped(TEAM, 'team-dead-2', { reason: 'evicted' })
    await recordDeathSeen(TEAM, 'team-dead', BUILT_IN_USER_ID)
    await recordWaitingSeen(TEAM, 'team-waiting', BUILT_IN_USER_ID)
  })
  afterAll(() => {
    vi.unstubAllEnvs()
  })

  const post = (path: string, body: object): Promise<Response> => Promise.resolve(app().request(`/api/workspace/${path}`, {
    method: 'POST',
    headers: { ...asTailnet('bob@example.com', HOST), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, userId: BUILT_IN_USER_ID }),
  }))
  const row = async (workspaceId: string) =>
    (await listWorkspaceRows(TEAM)).find((r) => r.workspaceId === workspaceId)

  it('records only the caller, whatever the body names', async () => {
    expect((await post('mark-death-seen', { projectId: TEAM, workspaceId: 'team-dead' })).status).toBe(204)
    expect((await row('team-dead'))?.deathSeenBy).toEqual([BUILT_IN_USER_ID, teammate])

    expect((await post('mark-all-deaths-seen', { projectId: TEAM })).status).toBe(204)
    expect((await row('team-dead'))?.deathSeenBy).toEqual([BUILT_IN_USER_ID, teammate])
    expect((await row('team-dead-2'))?.deathSeenBy).toEqual([teammate])

    // Nothing watches it, so it waits in a spell with no stamp (0).
    const waiting = await post('mark-waiting-seen', { projectId: TEAM, workspaceId: 'team-waiting', waitingSinceMs: 0 })
    expect(await waiting.json()).toEqual({ marked: true })
    expect((await row('team-waiting'))?.waitingSeenBy).toEqual([BUILT_IN_USER_ID, teammate])
  })
})
