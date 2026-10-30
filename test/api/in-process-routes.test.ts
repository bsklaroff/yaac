import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { buildApp } from '@yaac/server/main/server'
import { asTailnet, makeTestApiClient } from '@yaac/test-utils/api'
import { closeDb } from '@yaac/server/db/client'
import {
  recordDeathSeen,
  recordWorkspaceCreated,
  recordWorkspaceStopped,
  listWorkspaceRows,
} from '@yaac/server/db/workspace-store'
import { BUILT_IN_USER_ID, seeTailnetUser } from '@yaac/server/db/user-store'
import { getSessionRow, insertSession, recordSessionWaitingSeen } from '@yaac/server/db/session-store'
import { readAgentStatus, setAgentStatus } from '@yaac/server/runtime/status/status-store'
import { getProjectRow } from '@yaac/server/db/project-store'
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
describe('scratch dirs route', () => {
  const SCRATCH = '0a0a0a0a-0000-4000-8000-000000000010'

  it('sets either part, keeping the other, and refuses a path outside the checkout or a bad cap', async () => {
    await recordTestProject(SCRATCH)
    const client = makeTestApiClient(buildApp({ buildId: 'test' }))
    const scratch = client.project[':projectId']['scratch-dirs']
    const param = { projectId: SCRATCH }

    expect((await scratch.$put({ param, json: { ignoredTracked: ['target/'] } })).status).toBe(200)
    // Answered as stored: normalized and deduplicated.
    const res = await scratch.$put({
      param, json: { dirs: [{ path: 'node_modules/', sizeGiB: 4 }, { path: 'node_modules', sizeGiB: 9 }] },
    })
    const stored = { dirs: [{ path: 'node_modules', sizeGiB: 4 }], ignoredTracked: ['target'] }
    expect(await res.json()).toEqual(stored)
    expect((await getProjectRow(SCRATCH))?.scratchDirs).toEqual(stored)
    expect((await scratch.$put({ param, json: { dirs: [{ path: '../up', sizeGiB: 8 }] } })).status).toBe(400)
    expect((await scratch.$put({ param, json: { dirs: [{ path: 'target', sizeGiB: 0 }] } })).status).toBe(400)
    expect((await getProjectRow(SCRATCH))?.scratchDirs).toEqual(stored)
  })
})

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

/** A session of `workspaceId` whose agent waits now, and its spell's start. */
async function waitingSession(projectId: string, workspaceId: string): Promise<{ id: string; waitingSinceMs: number }> {
  await recordWorkspaceCreated({ projectId, workspaceId })
  const session = await insertSession(projectId, workspaceId, { tool: 'claude', mode: 'acp', permissionMode: 'bypass' })
  setAgentStatus(projectId, workspaceId, session.window, 'waiting')
  return { id: session.id, waitingSinceMs: readAgentStatus(projectId, workspaceId, session.window)!.waitingSinceMs! }
}

describe('session waiting read-marks', () => {
  it('marks the spell the request names, and 404s a session with no row', async () => {
    const { id, waitingSinceMs } = await waitingSession(ONE, 'waiting-1')

    const client = makeTestApiClient(buildApp({ buildId: 'test' }))
    const res = await client.workspace['mark-waiting-seen'].$post({ json: { sessionId: id, waitingSinceMs } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ marked: true })
    expect((await getSessionRow(id))?.waitingSeenBy).toEqual([BUILT_IN_USER_ID])

    const ghost = await client.workspace['mark-waiting-seen'].$post({
      json: { sessionId: '0a0a0a0a-0000-4000-8000-0000000000ff', waitingSinceMs },
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
  let waiting: { id: string; waitingSinceMs: number }

  beforeAll(async () => {
    vi.stubEnv('YAAC_ALLOWED_HOSTS', HOST)
    teammate = await seeTailnetUser('bob@example.com', 'bob')
    await recordTestProject(TEAM, { name: 'team' })
    for (const id of ['team-dead', 'team-dead-2']) {
      await recordWorkspaceCreated({ projectId: TEAM, workspaceId: id })
    }
    waiting = await waitingSession(TEAM, 'team-waiting')
    await recordWorkspaceStopped(TEAM, 'team-dead', { reason: 'oom' })
    await recordWorkspaceStopped(TEAM, 'team-dead-2', { reason: 'evicted' })
    await recordDeathSeen(TEAM, 'team-dead', BUILT_IN_USER_ID)
    await recordSessionWaitingSeen(waiting.id, BUILT_IN_USER_ID)
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

    const marked = await post('mark-waiting-seen', { sessionId: waiting.id, waitingSinceMs: waiting.waitingSinceMs })
    expect(await marked.json()).toEqual({ marked: true })
    expect((await getSessionRow(waiting.id))?.waitingSeenBy).toEqual([BUILT_IN_USER_ID, teammate])
  })
})
