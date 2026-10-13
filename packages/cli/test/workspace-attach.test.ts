import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { workspaceAttach } from '#commands/workspace-attach'
import { workspaceCreate } from '#commands/workspace-create'
import { workspaceRestart } from '#commands/workspace-restart'
import { startFakeApi, type FakeApi } from './fake-api'

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
})

/** The terminal attaches made so far, as `[workspace id, target]`. */
const attaches = (): Array<[string | null, string | null]> => api.requests
  .filter((r) => r.route === 'GET /api/pty/attach')
  .map((r) => [r.query.get('id'), r.query.get('target')])

const started = (result: object): { ndjson: object[] } => ({ ndjson: [{ type: 'result', result }] })

describe('workspaceCreate', () => {
  it('POSTs the request with unset options omitted, prints progress, and attaches', async () => {
    api.on('POST /api/workspace/create', { ndjson: [
      { type: 'progress', message: 'Fetching latest from remote...' },
      { type: 'progress', message: 'Creating session job yaac-demo-sess-123...' },
      { type: 'result', result: { workspaceId: 'sess-123', jobName: 'yaac-demo-sess-123', forwardedPorts: [], tool: 'claude', mode: 'tui' } },
    ] })

    await workspaceCreate('demo', {})

    // Omitted so the server picks from what the project last used. The git
    // identity is a server setting, not a request field.
    const create = api.requests.find((r) => r.route === 'POST /api/workspace/create')
    expect(create?.body).toEqual({ project: 'demo' })
    expect(logSpy.mock.calls.map((args) => args[0] as unknown)).toEqual(expect.arrayContaining([
      'Fetching latest from remote...', 'Creating session job yaac-demo-sess-123...',
    ]))
    expect(attaches()).toEqual([['sess-123', 'native']])
  })

  it('forwards an explicit --tool, and does not attach to an acp workspace', async () => {
    // Its tmux window only runs acpd; attaching would show its log. The
    // server's answer decides, not the request.
    api.on('POST /api/workspace/create', started({ workspaceId: 'sess-acp', jobName: 'j', forwardedPorts: [], tool: 'codex', mode: 'acp' }))
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
  it('attaches a terminal to a restarted tui workspace, and not to an acp one', async () => {
    api.on('POST /api/workspace/restart', (req) => {
      const { workspaceId } = req.body as { workspaceId: string }
      return started({ workspaceId, mode: workspaceId === 'w1' ? 'tui' : 'acp' })
    })
    await workspaceRestart('w1')
    // Its tmux window only runs acpd; attaching would hang, as on create.
    await workspaceRestart('w2')
    expect(attaches()).toEqual([['w1', 'native']])
  })
})

describe('workspaceAttach', () => {
  // The socket takes only an exact id, so the prefix is resolved first.
  it.each(['native', 'shell'] as const)('attaches the %s target by the id the server resolved', async (target) => {
    api.on('GET /api/workspace/abc', { json: { workspaceId: 'abc123def456' } })
    await workspaceAttach('abc', target)
    expect(attaches()).toEqual([['abc123def456', target]])
  })

  it('opens no socket when the id does not resolve', async () => {
    api.on('GET /api/workspace/abc', { status: 400, json: { error: { code: 'VALIDATION', message: 'Ambiguous workspace prefix: abc' } } })
    await expect(workspaceAttach('abc', 'native')).rejects.toThrow(/Ambiguous/)
    expect(attaches()).toEqual([])
  })
})
