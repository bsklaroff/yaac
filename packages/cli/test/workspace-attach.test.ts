import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { workspaceAttach } from '#commands/workspace-attach'
import { workspaceCreate } from '#commands/workspace-create'
import { workspaceRestart } from '#commands/workspace-restart'
import { serveProjects, startFakeApi, type FakeApi } from './fake-api'

/**
 * The commands that end by attaching the terminal to a workspace, against a
 * fake server: what they send, and which workspace's terminal they attach.
 * What the server does with a request is covered by the server's own tests.
 */
let api: FakeApi
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
  serveProjects(api, [['id-demo', 'demo']])
})

/** The terminal attaches made so far, as `[workspace id, target]`. */
const attaches = (): Array<[string | null, string | null]> => api.requests
  .filter((r) => r.route === 'GET /api/pty/attach')
  .map((r) => [r.query.get('id'), r.query.get('target')])

const started = (result: object): { ndjson: object[] } => ({ ndjson: [{ type: 'result', result }] })

/** The running workspaces the server lists, each with its open sessions. */
const listing = (...workspaces: Array<[string, Array<{ sessionId: string; mode: 'tui' | 'acp'; window: string }>]>): void => {
  api.on('GET /api/workspace/list', { json: {
    workspaces: workspaces.map(([workspaceId, sessions]) => ({
      workspaceId, sessions: sessions.map((s) => ({ tool: 'claude', permissionMode: 'bypass', ordinal: 0, ...s })),
    })),
    gitAuthFailures: {},
  } })
}

describe('workspaceCreate', () => {
  it('POSTs the request with unset options omitted, prints progress, and attaches', async () => {
    api.on('POST /api/workspace/create', { ndjson: [
      { type: 'progress', message: 'Fetching latest from remote...' },
      { type: 'progress', message: 'Creating session job yaac-demo-sess-123...' },
      { type: 'result', result: { workspaceId: 'sess-123', jobName: 'yaac-demo-sess-123', forwardedPorts: [], sessionId: 's-1' } },
    ] })
    listing(['sess-123', [{ sessionId: 's-1', mode: 'tui', window: 'claude-s1' }]])

    await workspaceCreate('demo', {})

    // Omitted so the server picks from what the project last used. The git
    // identity is a server setting, not a request field.
    const create = api.requests.find((r) => r.route === 'POST /api/workspace/create')
    expect(create?.body).toEqual({ project: 'id-demo' })
    expect(logSpy.mock.calls.map((args) => args[0] as unknown)).toEqual(expect.arrayContaining([
      'Fetching latest from remote...', 'Creating session job yaac-demo-sess-123...',
    ]))
    // On the window of the session the create opened.
    expect(attaches()).toEqual([['sess-123', 'native:claude-s1']])
  })

  it('forwards an explicit --tool, and does not attach to an acp session', async () => {
    // Its tmux window only runs acpd; attaching would show its log. The
    // server's listing decides, not the request.
    api.on('POST /api/workspace/create', started({ workspaceId: 'sess-acp', jobName: 'j', forwardedPorts: [], sessionId: 's-2' }))
    listing(['sess-acp', [{ sessionId: 's-2', mode: 'acp', window: 'codex-s2' }]])
    await workspaceCreate('demo', { tool: 'codex', mode: 'acp' })
    expect(api.requests.find((r) => r.route === 'POST /api/workspace/create')?.body)
      .toMatchObject({ tool: 'codex', mode: 'acp' })
    expect(attaches()).toEqual([])
  })

  it('throws with the server error message when the stream carries an error event', async () => {
    api.on('POST /api/workspace/create', { ndjson: [
      { type: 'progress', message: 'Fetching latest from remote...' },
      { type: 'error', error: { code: 'VALIDATION', message: 'no github token' } },
    ] })
    await expect(workspaceCreate('demo', {})).rejects.toThrow('no github token')
    expect(attaches()).toEqual([])
  })
})

describe('workspaceRestart', () => {
  // A restart brings back several sessions, none of them the one to attach
  // to, so it says how to attach instead.
  it('names the restarted workspace for an attach, attaching nothing', async () => {
    api.on('POST /api/workspace/restart', (req) => {
      const { workspaceId } = req.body as { workspaceId: string }
      return started({ workspaceId, jobName: 'j', forwardedPorts: [] })
    })
    await workspaceRestart('w1')
    expect(attaches()).toEqual([])
    expect(logSpy).toHaveBeenCalledWith('Workspace w1 is running — attach with `yaac workspace attach w1`.')
  })
})

describe('workspaceAttach', () => {
  // The socket takes only an exact id, so the prefix is resolved first.
  it('attaches the shell target by the id the server resolved', async () => {
    api.on('GET /api/workspace/abc', { json: { workspaceId: 'abc123def456' } })
    await workspaceAttach('abc', 'shell')
    expect(attaches()).toEqual([['abc123def456', 'shell']])
  })

  // tmux on the first session's window, or the one --session names by id
  // or prefix; with no session, whichever window tmux shows.
  it('attaches tmux on a session\'s window, refusing a session the workspace lacks', async () => {
    api.on('GET /api/workspace/abc', { json: { workspaceId: 'abc123def456' } })
    listing(['abc123def456', [
      { sessionId: 'aaaa1111', mode: 'tui', window: 'claude-aaaa1111' },
      { sessionId: 'bbbb2222', mode: 'tui', window: 'codex-bbbb2222' },
    ]], ['bare', []])
    await workspaceAttach('abc', 'native')
    await workspaceAttach('abc', 'native', { session: 'bbbb' })
    await expect(workspaceAttach('abc', 'native', { session: 'cccc' })).rejects.toThrow('Workspace abc123def456 has no open session "cccc".')
    api.on('GET /api/workspace/bare', { json: { workspaceId: 'bare' } })
    await workspaceAttach('bare', 'native')
    expect(attaches()).toEqual([
      ['abc123def456', 'native:claude-aaaa1111'], ['abc123def456', 'native:codex-bbbb2222'], ['bare', 'native'],
    ])
  })

  it('opens no socket when the id does not resolve', async () => {
    api.on('GET /api/workspace/abc', { status: 400, json: { error: { code: 'VALIDATION', message: 'Ambiguous workspace prefix: abc' } } })
    await expect(workspaceAttach('abc', 'native')).rejects.toThrow(/Ambiguous/)
    expect(attaches()).toEqual([])
  })
})
