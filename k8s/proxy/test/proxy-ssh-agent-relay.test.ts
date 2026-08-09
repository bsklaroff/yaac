import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createAgentRequestFilter,
  createSshAgentServer,
  isSshRemote,
  sshAgentGate,
  type AgentPeerWorktree,
} from 'yaac-proxy-sidecar/ssh-agent-relay'

/**
 * The ssh-agent forwarding transport: worktree pods reach the proxy's
 * in-memory agent over TCP (a hostPath UNIX socket only rendezvous between
 * pods on one node), and the proxy decides per connection whether the
 * source is entitled to it.
 *
 * The listener is driven for real here — a stand-in "agent" on a UNIX
 * socket, a client on TCP — because the property under test is that an
 * admitted connection is spliced byte-for-byte and a refused one gets
 * nothing at all.
 */

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

/** Agent-protocol message types, from OpenSSH's PROTOCOL.agent. */
const REQUEST_IDENTITIES = 11
const SIGN_REQUEST = 13
const REMOVE_ALL_IDENTITIES = 19
const LOCK = 22
const EXTENSION = 27
const AGENT_FAILURE = 5

/** One agent-protocol message: `uint32 length` then the type byte + body. */
function agentMessage(type: number, body: Buffer = Buffer.alloc(0)): Buffer {
  const out = Buffer.alloc(5 + body.length)
  out.writeUInt32BE(1 + body.length, 0)
  out.writeUInt8(type, 4)
  body.copy(out, 5)
  return out
}

interface FakeAgent {
  sock: string
  /** Every byte the agent was handed, in order. */
  received: () => Buffer
  /** How many agent-side connections have closed. */
  closed: () => number
}

/**
 * A stand-in ssh-agent: records what reaches it and answers each message
 * with a one-byte reply echoing the request's type, so a test can tell an
 * answered request from a refused one.
 */
async function startFakeAgent(): Promise<FakeAgent> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-agent-'))
  const sock = path.join(dir, 'agent.sock')
  let seen = Buffer.alloc(0)
  let closes = 0
  const server = net.createServer((c) => {
    c.on('close', () => { closes++ })
    c.on('data', (chunk: Buffer) => {
      seen = Buffer.concat([seen, chunk])
      c.write(agentMessage(chunk[4]))
    })
  })
  await new Promise<void>((resolve) => server.listen(sock, resolve))
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(dir, { recursive: true, force: true })
  })
  return { sock, received: () => seen, closed: () => closes }
}

interface Harness {
  port: number
  logs: string[]
}

async function startListener(opts: {
  agentSock: string
  worktree?: AgentPeerWorktree
  repoUrl?: string
  maxConnections?: number
  idleTimeoutMs?: number
}): Promise<Harness> {
  const logs: string[] = []
  const server = createSshAgentServer({
    agentSock: opts.agentSock,
    resolveWorktree: () => Promise.resolve(opts.worktree),
    repoUrlFor: () => opts.repoUrl,
    log: (m) => { logs.push(m) },
    maxConnections: opts.maxConnections,
    idleTimeoutMs: opts.idleTimeoutMs,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => { server.close(() => resolve()) }))
  return { port: (server.address() as net.AddressInfo).port, logs }
}

/**
 * Connect, send one request, and resolve with the reply (or '' on refusal).
 * A refusal is a destroy, which the client sees as ECONNRESET — exactly what
 * an ssh client reports as "error connecting to agent", so it resolves empty
 * rather than throwing.
 */
function ask(port: number, payload: Buffer | Buffer[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    let out = Buffer.alloc(0)
    socket.on('connect', () => {
      for (const part of Array.isArray(payload) ? payload : [payload]) socket.write(part)
    })
    socket.on('data', (chunk: Buffer) => {
      out = Buffer.concat([out, chunk])
      socket.end()
    })
    socket.on('close', () => resolve(out))
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNRESET') resolve(out)
      else reject(err)
    })
    setTimeout(() => { socket.destroy(); resolve(out) }, 5000).unref()
  })
}

const SESSION: AgentPeerWorktree = { worktreeId: 'sess-1234abcd', viaVclusterAttribution: false }

describe('sshAgentGate', () => {
  it('admits a watched worktree pod whose registered remote is SSH', () => {
    expect(sshAgentGate(SESSION, 'git@github.com:acme/app.git'))
      .toEqual({ ok: true, worktreeId: SESSION.worktreeId })
    expect(sshAgentGate(SESSION, 'ssh://git@example.com:2222/acme/app.git').ok).toBe(true)
  })

  it('refuses an unresolvable source — the pod-watch is the only identity', () => {
    // Nothing else authenticates the connection, so a source the proxy
    // cannot place must never reach the agent.
    expect(sshAgentGate(undefined, 'git@github.com:acme/app.git').ok).toBe(false)
  })

  it('refuses a vcluster-attributed source: nested installs have their own agent', () => {
    const nested: AgentPeerWorktree = { worktreeId: 'sess-1234abcd', viaVclusterAttribution: true }
    expect(sshAgentGate(nested, 'git@github.com:acme/app.git').ok).toBe(false)
  })

  it('refuses a worktree with no SSH remote — the same condition the server provisions on', () => {
    expect(sshAgentGate(SESSION, 'https://github.com/acme/app.git').ok).toBe(false)
    expect(sshAgentGate(SESSION, undefined).ok).toBe(false)
  })
})

describe('isSshRemote', () => {
  it('accepts ssh:// URLs and the scp-like host:path form', () => {
    expect(isSshRemote('ssh://git@github.com/acme/app.git')).toBe(true)
    expect(isSshRemote('git@github.com:acme/app.git')).toBe(true)
    expect(isSshRemote('github.com:acme/app.git')).toBe(true)
  })

  it('rejects http(s) and other schemes, including a colon-bearing URL', () => {
    // `https://host:443/p` has a colon but is not scp syntax — the scheme
    // test must win, or every HTTPS project would be handed the agent.
    expect(isSshRemote('https://github.com/acme/app.git')).toBe(false)
    expect(isSshRemote('https://github.com:443/acme/app.git')).toBe(false)
    expect(isSshRemote('file:///srv/repo.git')).toBe(false)
    expect(isSshRemote(undefined)).toBe(false)
    expect(isSshRemote('/srv/local/repo.git')).toBe(false)
  })
})

describe('createAgentRequestFilter', () => {
  function run(chunks: Buffer[]): { forwarded: number[]; refused: number[]; failures: string[] } {
    const forwarded: number[] = []
    const refused: number[] = []
    const failures: string[] = []
    const feed = createAgentRequestFilter({
      forward: (m) => { forwarded.push(m[4]) },
      refuse: (t) => { refused.push(t) },
      fail: (r) => { failures.push(r) },
    })
    for (const c of chunks) feed(c)
    return { forwarded, refused, failures }
  }

  it('admits identity listing and signing, and nothing else', () => {
    // The two an ssh client needs. Everything else — add, remove-all, lock,
    // extension — would mutate an agent every worktree shares.
    const res = run([
      agentMessage(REQUEST_IDENTITIES),
      agentMessage(SIGN_REQUEST, Buffer.from('blob')),
      agentMessage(REMOVE_ALL_IDENTITIES),
      agentMessage(LOCK, Buffer.from('pw')),
      agentMessage(EXTENSION, Buffer.from('session-bind@openssh.com')),
    ])
    expect(res.forwarded).toEqual([REQUEST_IDENTITIES, SIGN_REQUEST])
    expect(res.refused).toEqual([REMOVE_ALL_IDENTITIES, LOCK, EXTENSION])
    expect(res.failures).toEqual([])
  })

  it('reassembles a message split across chunks, and holds a partial one back', () => {
    const msg = agentMessage(SIGN_REQUEST, Buffer.from('a longer signing blob'))
    const res = run([msg.subarray(0, 3), msg.subarray(3, 9), msg.subarray(9)])
    expect(res.forwarded).toEqual([SIGN_REQUEST])

    // A frame whose body has not all arrived must not be forwarded early.
    expect(run([msg.subarray(0, msg.length - 1)]).forwarded).toEqual([])
  })

  it('fails a frame that cannot be the agent protocol instead of buffering it', () => {
    // A hostile length would otherwise have the proxy buffer 4 GiB.
    const huge = Buffer.alloc(4)
    huge.writeUInt32BE(0xffffffff, 0)
    expect(run([huge]).failures).toHaveLength(1)
    const zero = Buffer.alloc(4)
    expect(run([zero]).failures).toHaveLength(1)
  })
})

describe('createSshAgentServer', () => {
  it('passes an entitled worktree\'s sign request through to the agent socket', async () => {
    const agent = await startFakeAgent()
    const { port } = await startListener({
      agentSock: agent.sock, worktree: SESSION, repoUrl: 'git@github.com:acme/app.git',
    })
    // The request is written immediately after connect, i.e. while the gate
    // is still resolving: those bytes must be buffered, not dropped.
    const reply = await ask(port, agentMessage(SIGN_REQUEST, Buffer.from('blob')))
    expect(reply).toEqual(agentMessage(SIGN_REQUEST))
    expect(agent.received()[4]).toBe(SIGN_REQUEST)
  })

  it('answers a mutating request itself and never lets it reach the agent', async () => {
    // The cross-worktree DoS this closes: the agent is install-wide, so one
    // worktree locking or emptying it would strand every other worktree.
    const agent = await startFakeAgent()
    const { port, logs } = await startListener({
      agentSock: agent.sock, worktree: SESSION, repoUrl: 'git@github.com:acme/app.git',
    })
    const reply = await ask(port, agentMessage(REMOVE_ALL_IDENTITIES))
    expect(reply).toEqual(agentMessage(AGENT_FAILURE))
    expect(agent.received()).toHaveLength(0)
    expect(logs.join('\n')).toContain('refused message type 19')
  })

  it('still serves a legitimate request pipelined behind a refused one', async () => {
    const agent = await startFakeAgent()
    const { port } = await startListener({
      agentSock: agent.sock, worktree: SESSION, repoUrl: 'git@github.com:acme/app.git',
    })
    await ask(port, [agentMessage(LOCK), agentMessage(REQUEST_IDENTITIES)])
    expect(agent.received()[4]).toBe(REQUEST_IDENTITIES)
  })

  it('drops a refused connection without writing a byte', async () => {
    const agent = await startFakeAgent()
    const { port, logs } = await startListener({
      agentSock: agent.sock, worktree: SESSION, repoUrl: 'https://github.com/acme/app.git',
    })
    expect(await ask(port, agentMessage(SIGN_REQUEST))).toHaveLength(0)
    expect(logs.join('\n')).toContain('BLOCKED ssh-agent')
  })

  it('drops a connection from an unknown source pod', async () => {
    const agent = await startFakeAgent()
    const { port, logs } = await startListener({
      agentSock: agent.sock, repoUrl: 'git@github.com:acme/app.git',
    })
    expect(await ask(port, agentMessage(SIGN_REQUEST))).toHaveLength(0)
    expect(logs.join('\n')).toContain('not a known worktree pod')
  })

  it('closes the client when the agent socket is missing rather than hanging', async () => {
    const { port, logs } = await startListener({
      agentSock: path.join(os.tmpdir(), 'yaac-agent-does-not-exist.sock'),
      worktree: SESSION,
      repoUrl: 'git@github.com:acme/app.git',
    })
    expect(await ask(port, agentMessage(SIGN_REQUEST))).toHaveLength(0)
    expect(logs.join('\n')).toContain('ssh-agent dial failed')
  })

  it('refuses new dials past the in-flight cap instead of holding agent fds', async () => {
    const agent = await startFakeAgent()
    const { port, logs } = await startListener({
      agentSock: agent.sock, worktree: SESSION, repoUrl: 'git@github.com:acme/app.git',
      maxConnections: 1,
    })
    // Hold one open (no payload, so it never completes), then dial again.
    const held = net.connect({ port, host: '127.0.0.1' })
    held.on('error', () => { /* reaped in cleanup */ })
    cleanups.push(() => { held.destroy() })
    await new Promise<void>((resolve) => held.on('connect', () => resolve()))

    expect(await ask(port, agentMessage(REQUEST_IDENTITIES))).toHaveLength(0)
    expect(logs.join('\n')).toContain('connections in flight')
  })

  it('releases the agent fd as soon as the client half-closes', async () => {
    // The filter replaced a `pipe`, which used to carry the client's FIN
    // across. Without that, a finished `git push` would pin an agent
    // connection until the idle reaper — so the reaper is set far out here
    // and only real propagation can pass this.
    const agent = await startFakeAgent()
    const { port } = await startListener({
      agentSock: agent.sock, worktree: SESSION, repoUrl: 'git@github.com:acme/app.git',
      idleTimeoutMs: 60_000,
    })
    await ask(port, agentMessage(REQUEST_IDENTITIES))
    const deadline = Date.now() + 2000
    while (agent.closed() === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(agent.closed()).toBe(1)
  })

  it('reaps a connection that goes idle', async () => {
    const agent = await startFakeAgent()
    const { port } = await startListener({
      agentSock: agent.sock, worktree: SESSION, repoUrl: 'git@github.com:acme/app.git',
      idleTimeoutMs: 150,
    })
    const idle = net.connect({ port, host: '127.0.0.1' })
    idle.on('error', () => { /* closed under us, which is the point */ })
    await new Promise<void>((resolve) => idle.on('close', () => resolve()))
  })
})
