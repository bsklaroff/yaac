import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import { projectScope, resolveProjectId, scopeToUser } from '#commands/api'
import { workspaceList } from '#commands/workspace-list'
import { ADA, ME, serveProjects, startFakeApi, type FakeApi } from './fake-api'

/**
 * Whose projects a command means (docs/cli.md "Whose projects"), against a
 * fake server where the caller and Ada each have an `app`.
 */
let api: FakeApi
const MINE = 'aaaaaaaa-1111-4111-8111-111111111111'
const HERS = 'bbbbbbbb-2222-4222-8222-222222222222'
const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

beforeAll(async () => {
  api = await startFakeApi()
  vi.stubEnv('YAAC_SERVER_URL', api.url)
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await api.close()
})

beforeEach(() => {
  api.reset()
  logSpy.mockClear()
  serveProjects(api, [[MINE, 'app'], [HERS, 'app', ADA], ['cccccccc-3333-4333-8333-333333333333', 'notes', ADA]])
})

afterEach(() => scopeToUser(undefined))

describe('projectScope', () => {
  it("is the caller's projects, or those of the user --user names by login, name or id", async () => {
    expect(await projectScope()).toMatchObject({ userId: ME, projects: [{ id: MINE }] })
    for (const ref of ['ada@example.com', 'ADA', ADA]) {
      scopeToUser(ref)
      expect((await projectScope()).projects.map((p) => p.id)).toEqual([HERS, 'cccccccc-3333-4333-8333-333333333333'])
    }
    scopeToUser('bo')
    await expect(projectScope()).rejects.toThrow('No user "bo" on this server; its users are me@example.com, ada@example.com.')
  })
})

describe('resolveProjectId', () => {
  it('resolves a name or id prefix among the projects in scope, and a full id among everyone\'s', async () => {
    expect(await resolveProjectId('app')).toBe(MINE)
    expect(await resolveProjectId(HERS)).toBe(HERS)
    await expect(resolveProjectId('notes')).rejects.toThrow("You have no project notes; pass --user <user> for a teammate's.")
    await expect(resolveProjectId('bbbbbbbb')).rejects.toThrow('You have no project bbbbbbbb')

    scopeToUser('ada@example.com')
    expect(await resolveProjectId('app')).toBe(HERS)
    expect(await resolveProjectId('bbbbbbbb')).toBe(HERS)
    expect(await resolveProjectId(MINE)).toBe(MINE)
  })
})

describe('workspaceList', () => {
  const running = (workspaceId: string, projectId: string, forwardedPorts: object[] = []): object => ({
    workspaceId, projectId, status: 'running', conversations: [], sessions: [], blockedHosts: [], createdAt: '', forwardedPorts,
  })

  it("lists the workspaces of the projects in scope, and asks for the scoped user's stopped ones", async () => {
    const port = { containerPort: 3001, hostPort: 3001 }
    api.on('GET /api/workspace/list', { json: { workspaces: [running('mine-1', MINE, [port]), running('hers-1', HERS, [port])], gitAuthFailures: {} } })
    api.on('GET /api/workspace/group/list', { json: { groups: [] } })
    api.on('GET /api/workspace/list-stopped', { json: { entries: [], total: 0 } })
    const scheduled = (id: string, projectId: string, prompt: string): object => ({
      id, projectId, prompt, tool: 'claude', model: 'm', mode: 'tui', permissionMode: 'manual', branch: 'main',
      createdAt: '', startAt: '2099-01-01T09:00:00.000Z',
    })
    api.on('GET /api/workspace/queue/list', { json: [scheduled('q-mine', MINE, 'my later'), scheduled('q-hers', HERS, 'her later')] })
    api.on('GET /api/config/time-zone', { json: { timeZone: 'Asia/Tokyo', pinned: true } })
    const printed = (): string => logSpy.mock.calls.map((c) => String(c[0])).join('\n')

    await workspaceList()
    expect(printed()).toContain('mine-1')
    expect(printed()).not.toContain('hers-1')
    // A server on this machine routes each port's hostname on its own port.
    expect(printed()).toContain(`http://3001.mine-1.localhost:${new URL(api.url).port}/`)
    // Scheduled ones are scoped the same way, and timed in the user's zone.
    expect(printed()).toContain('my later')
    expect(printed()).toContain('STARTS (Asia/Tokyo)')
    expect(printed()).toContain('Thu Jan 1 18:00')
    expect(printed()).not.toContain('her later')

    logSpy.mockClear()
    scopeToUser('ada@example.com')
    await workspaceList()
    expect(printed()).toContain('hers-1')
    expect(printed()).not.toContain('mine-1')

    await workspaceList(undefined, { stopped: true })
    await workspaceList('app', { stopped: true })
    expect(api.requests.filter((r) => r.route === 'GET /api/workspace/list-stopped').map((r) => Object.fromEntries(r.query)))
      .toEqual([{ owner: ADA, limit: '25' }, { project: HERS, limit: '25' }])
  })
})
