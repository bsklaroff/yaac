import { describe, it, expect, afterEach, vi } from 'vitest'
import net from 'node:net'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createAgentReplyFilter,
  createAgentRequestFilter,
  createSshAgentServer,
  isSshRemote,
  sshAgentGate,
} from 'yaac-proxy-sidecar/ssh-agent-relay'

/**
 * The ssh-agent relay, driven for real: a stand-in agent on a UNIX socket
 * and a client on TCP. The tests check what crosses the relay each way: an
 * admitted request reaches the agent intact, a refused one never does, a
 * refused connection gets nothing, and a workspace only sees its own
 * project's keys and signs with them only for the hosts they are granted for.
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
const IDENTITIES_ANSWER = 12

/** One agent-protocol message: `uint32 length` then the type byte + body. */
function agentMessage(type: number, body: Buffer = Buffer.alloc(0)): Buffer {
  const out = Buffer.alloc(5 + body.length)
  out.writeUInt32BE(1 + body.length, 0)
  out.writeUInt8(type, 4)
  body.copy(out, 5)
  return out
}

/** A wire `string`: uint32 length, then the bytes. */
function sshString(value: string | Buffer): Buffer {
  const bytes = Buffer.from(value)
  const out = Buffer.alloc(4 + bytes.length)
  out.writeUInt32BE(bytes.length, 0)
  bytes.copy(out, 4)
  return out
}

/** A sign request as ssh sends it: the key blob, the data, the flags. */
function signRequest(blob: Buffer): Buffer {
  return agentMessage(SIGN_REQUEST, Buffer.concat([sshString(blob), sshString('session-data'), Buffer.alloc(4)]))
}

/** An agent's identities answer listing `blobs`, each with a comment. */
function identitiesAnswer(blobs: Buffer[]): Buffer {
  const count = Buffer.alloc(4)
  count.writeUInt32BE(blobs.length, 0)
  return agentMessage(IDENTITIES_ANSWER,
    Buffer.concat([count, ...blobs.flatMap((b) => [sshString(b), sshString(`comment for ${b.toString()}`)])]))
}

const KEY_A = Buffer.from('key-blob-a')
const KEY_B = Buffer.from('key-blob-b')
const b64 = (blob: Buffer): string => blob.toString('base64')

/** An extension frame as ssh sends it: the name, then its payload. */
function extension(name: string, payload: Buffer): Buffer {
  return agentMessage(EXTENSION, Buffer.concat([sshString(name), payload]))
}

const HOST_GH = Buffer.from('hostkey-github')
const HOST_GL = Buffer.from('hostkey-gitlab')

/** The session bind ssh sends once connected to a server with `hostKey`:
 *  host key, session id, the server's signature, is-forwarding. */
function bind(hostKey: Buffer): Buffer {
  return extension('session-bind@openssh.com',
    Buffer.concat([sshString(hostKey), sshString('session-id'), sshString('signature'), Buffer.from([0])]))
}

/** Grants: key A for github.com's host key. */
const GRANT_A = (): Map<string, Set<string>> => new Map([[b64(KEY_A), new Set([b64(HOST_GH)])]])

interface FakeAgent {
  sock: string
  /** Every byte the agent was handed, in order. */
  received: () => Buffer
  /** How many agent-side connections have closed. */
  closed: () => number
}

/**
 * A stand-in ssh-agent holding `keys`: records what reaches it, answers an
 * identities request by listing every key, and answers anything else with a
 * one-byte reply echoing the request's type, so a test can tell an answered
 * request from a refused one.
 */
async function startFakeAgent(keys: Buffer[] = []): Promise<FakeAgent> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-agent-'))
  const sock = path.join(dir, 'agent.sock')
  let seen = Buffer.alloc(0)
  let closes = 0
  const server = net.createServer((c) => {
    c.on('close', () => { closes++ })
    c.on('data', (chunk: Buffer) => {
      seen = Buffer.concat([seen, chunk])
      c.write(chunk[4] === REQUEST_IDENTITIES ? identitiesAnswer(keys) : agentMessage(chunk[4]))
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
  workspace?: string
  repoUrl?: string
  /** The workspace's grants, asked per message. */
  grants?: () => Map<string, Set<string>>
  maxConnections?: number
  idleTimeoutMs?: number
}): Promise<Harness> {
  const logs: string[] = []
  const server = createSshAgentServer({
    agentSock: opts.agentSock,
    resolveWorkspace: () => Promise.resolve(opts.workspace),
    repoUrlFor: () => opts.repoUrl,
    grantsFor: opts.grants ?? (() => new Map<string, Set<string>>()),
    log: (m) => { logs.push(m) },
    maxConnections: opts.maxConnections,
    idleTimeoutMs: opts.idleTimeoutMs,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => { server.close(() => resolve()) }))
  return { port: (server.address() as net.AddressInfo).port, logs }
}

/**
 * Connect, send one request, and resolve with the reply, or '' when the
 * relay refuses the connection (seen as ECONNRESET).
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

/**
 * One connection held open across several requests, the way an ssh client
 * uses a forwarded agent: `request` writes a message and resolves with the
 * next whole reply frame.
 */
async function openConnection(port: number): Promise<{ request: (msg: Buffer) => Promise<Buffer> }> {
  const socket = net.connect({ port, host: '127.0.0.1' })
  cleanups.push(() => { socket.destroy() })
  await new Promise<void>((resolve) => socket.on('connect', () => resolve()))
  let buf = Buffer.alloc(0)
  let waiting: ((frame: Buffer) => void) | null = null
  const settle = (): void => {
    if (!waiting || buf.length < 4 || buf.length < 4 + buf.readUInt32BE(0)) return
    const frame = buf.subarray(0, 4 + buf.readUInt32BE(0))
    buf = buf.subarray(frame.length)
    const resolve = waiting
    waiting = null
    resolve(frame)
  }
  socket.on('data', (chunk: Buffer) => { buf = Buffer.concat([buf, chunk]); settle() })
  return {
    request: (msg) => new Promise((resolve) => {
      waiting = resolve
      socket.write(msg)
      settle()
    }),
  }
}

const SESSION = 'sess-1234abcd'

describe('sshAgentGate', () => {
  it('admits a watched workspace pod whose registered remote is SSH', () => {
    expect(sshAgentGate(SESSION, 'git@github.com:acme/app.git'))
      .toEqual({ ok: true, workspaceId: SESSION })
    expect(sshAgentGate(SESSION, 'ssh://git@example.com:2222/acme/app.git').ok).toBe(true)
  })

  it('refuses an unresolvable source — the pod-watch is the only identity', () => {
    // The source IP is the only authentication.
    expect(sshAgentGate(undefined, 'git@github.com:acme/app.git').ok).toBe(false)
  })

  it('refuses a workspace with no SSH remote — the same condition the server provisions on', () => {
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
      allowSign: (blob, bound) => blob.equals(KEY_A) && bound.length > 0 && bound.every((h) => h.equals(HOST_GH)),
      forward: (m) => { forwarded.push(m[4]) },
      refuse: (t) => { refused.push(t) },
      fail: (r) => { failures.push(r) },
    })
    for (const c of chunks) feed(c)
    return { forwarded, refused, failures }
  }

  it('admits identity listing, a bound sign with a granted key and the session bind, and nothing else', () => {
    // Only list, sign and session-bind pass. Anything else could mutate the
    // shared agent.
    const res = run([
      agentMessage(REQUEST_IDENTITIES),
      // Unbound, so the host it would sign for is unknown.
      signRequest(KEY_A),
      bind(HOST_GH),
      signRequest(KEY_A),
      signRequest(KEY_B),
      // A sign request whose key blob overruns the frame names no key.
      agentMessage(SIGN_REQUEST, Buffer.from('blob')),
      agentMessage(REMOVE_ALL_IDENTITIES),
      agentMessage(LOCK, Buffer.from('pw')),
      extension('query', Buffer.alloc(0)),
      extension('session-bind@openssh.com.evil', Buffer.alloc(0)),
      // A bind carrying no host key, and a bare name with no wire length.
      extension('session-bind@openssh.com', Buffer.alloc(0)),
      agentMessage(EXTENSION, Buffer.from('session-bind@openssh.com')),
    ])
    expect(res.forwarded).toEqual([REQUEST_IDENTITIES, EXTENSION, SIGN_REQUEST])
    expect(res.refused).toEqual([
      SIGN_REQUEST, SIGN_REQUEST, SIGN_REQUEST, REMOVE_ALL_IDENTITIES, LOCK, EXTENSION, EXTENSION, EXTENSION, EXTENSION,
    ])
    expect(res.failures).toEqual([])
  })

  it('hands the sign check every host the connection bound', () => {
    // The agent's own constraint is every host any grant of the key names,
    // so a bind to a host this workspace's grant lacks must stop the sign.
    const res = run([bind(HOST_GH), bind(HOST_GL), signRequest(KEY_A)])
    expect(res.forwarded).toEqual([EXTENSION, EXTENSION])
    expect(res.refused).toEqual([SIGN_REQUEST])
  })

  it('reassembles a message split across chunks, and holds a partial one back', () => {
    const msg = signRequest(KEY_A)
    const res = run([bind(HOST_GH), msg.subarray(0, 3), msg.subarray(3, 9), msg.subarray(9)])
    expect(res.forwarded).toEqual([EXTENSION, SIGN_REQUEST])

    // A frame whose body has not all arrived must not be forwarded early.
    expect(run([bind(HOST_GH), msg.subarray(0, msg.length - 1)]).forwarded).toEqual([EXTENSION])
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

describe('createAgentReplyFilter', () => {
  function run(chunks: Buffer[]): { delivered: Buffer[]; failures: string[] } {
    const delivered: Buffer[] = []
    const failures: string[] = []
    const feed = createAgentReplyFilter({
      allowKey: (blob) => blob.equals(KEY_A),
      deliver: (m) => { delivered.push(Buffer.from(m)) },
      fail: (r) => { failures.push(r) },
    })
    for (const c of chunks) feed(c)
    return { delivered, failures }
  }

  it('lists only the project\'s keys, reframed, and passes every other reply through', () => {
    // Split mid-frame and coalesced with the next reply, as a stream may.
    const stream = Buffer.concat([identitiesAnswer([KEY_B, KEY_A]), agentMessage(AGENT_FAILURE)])
    const res = run([stream.subarray(0, 7), stream.subarray(7)])
    expect(res.delivered).toEqual([identitiesAnswer([KEY_A]), agentMessage(AGENT_FAILURE)])
    expect(run([identitiesAnswer([KEY_B])]).delivered).toEqual([identitiesAnswer([])])
    expect(res.failures).toEqual([])
  })

  it('fails an identities answer it cannot parse rather than passing it unfiltered', () => {
    const overclaims = identitiesAnswer([KEY_A])
    overclaims.writeUInt32BE(2, 5)
    const trailing = Buffer.concat([identitiesAnswer([KEY_B]), Buffer.from('x')])
    trailing.writeUInt32BE(trailing.length - 4, 0)
    for (const bad of [overclaims, trailing, agentMessage(IDENTITIES_ANSWER)]) {
      const res = run([bad])
      expect(res.delivered).toEqual([])
      expect(res.failures).toHaveLength(1)
    }
  })
})

describe('createSshAgentServer', () => {
  it('passes an entitled workspace\'s sign request through to the agent socket', async () => {
    const agent = await startFakeAgent()
    const { port } = await startListener({
      agentSock: agent.sock, workspace: SESSION, repoUrl: 'git@github.com:acme/app.git',
      grants: GRANT_A,
    })
    // The requests are written immediately after connect, i.e. while the
    // gate is still resolving: those bytes must be buffered, not dropped.
    const request = Buffer.concat([bind(HOST_GH), signRequest(KEY_A)])
    const reply = await ask(port, request)
    expect(reply.subarray(0, 5)).toEqual(agentMessage(EXTENSION))
    await vi.waitFor(() => expect(agent.received()).toEqual(request))
  })

  it('shows only the workspace\'s keys and signs only for their granted hosts, re-read per message', async () => {
    // The agent holds every owner's keys for every project, constrained to
    // the union of their hosts; the relay narrows both.
    const agent = await startFakeAgent([KEY_A, KEY_B])
    let grants = GRANT_A()
    const { port, logs } = await startListener({
      agentSock: agent.sock, workspace: SESSION, repoUrl: 'git@github.com:acme/app.git',
      grants: () => grants,
    })
    const conn = await openConnection(port)
    expect(await conn.request(agentMessage(REQUEST_IDENTITIES))).toEqual(identitiesAnswer([KEY_A]))
    expect(await conn.request(bind(HOST_GH))).toEqual(agentMessage(EXTENSION))
    expect(await conn.request(signRequest(KEY_B))).toEqual(agentMessage(AGENT_FAILURE))
    expect(logs.join('\n')).toContain('not granted')

    // A reassignment applies to an open connection's next request.
    grants = new Map([[b64(KEY_B), new Set([b64(HOST_GH)])]])
    expect(await conn.request(agentMessage(REQUEST_IDENTITIES))).toEqual(identitiesAnswer([KEY_B]))
    expect(await conn.request(signRequest(KEY_A))).toEqual(agentMessage(AGENT_FAILURE))
    expect(await conn.request(signRequest(KEY_B))).toEqual(agentMessage(SIGN_REQUEST))

    // Key B granted here only for gitlab.com: bound to github.com, the
    // connection may list it but not sign with it, although the agent would.
    grants = new Map([[b64(KEY_B), new Set([b64(HOST_GL)])]])
    expect(await conn.request(agentMessage(REQUEST_IDENTITIES))).toEqual(identitiesAnswer([KEY_B]))
    expect(await conn.request(signRequest(KEY_B))).toEqual(agentMessage(AGENT_FAILURE))
    // Only the one admitted sign ever reached the agent.
    const reached = agent.received()
    const first = reached.indexOf(signRequest(KEY_B))
    expect(first).toBeGreaterThan(-1)
    expect(reached.indexOf(signRequest(KEY_B), first + 1)).toBe(-1)
  })

  it('answers a mutating request itself and never lets it reach the agent', async () => {
    // The agent is shared, so one workspace must not lock or empty it.
    const agent = await startFakeAgent()
    const { port, logs } = await startListener({
      agentSock: agent.sock, workspace: SESSION, repoUrl: 'git@github.com:acme/app.git',
    })
    const reply = await ask(port, agentMessage(REMOVE_ALL_IDENTITIES))
    expect(reply).toEqual(agentMessage(AGENT_FAILURE))
    expect(agent.received()).toHaveLength(0)
    expect(logs.join('\n')).toContain('refused message type 19')
  })

  it('still serves a legitimate request pipelined behind a refused one', async () => {
    const agent = await startFakeAgent()
    const { port } = await startListener({
      agentSock: agent.sock, workspace: SESSION, repoUrl: 'git@github.com:acme/app.git',
    })
    await ask(port, [agentMessage(LOCK), agentMessage(REQUEST_IDENTITIES)])
    expect(agent.received()[4]).toBe(REQUEST_IDENTITIES)
  })

  it('drops a refused connection without writing a byte', async () => {
    const agent = await startFakeAgent()
    const { port, logs } = await startListener({
      agentSock: agent.sock, workspace: SESSION, repoUrl: 'https://github.com/acme/app.git',
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
    expect(logs.join('\n')).toContain('not a known workspace pod')
  })

  it('closes the client when the agent socket is missing rather than hanging', async () => {
    const { port, logs } = await startListener({
      agentSock: path.join(os.tmpdir(), 'yaac-agent-does-not-exist.sock'),
      workspace: SESSION,
      repoUrl: 'git@github.com:acme/app.git',
    })
    expect(await ask(port, agentMessage(SIGN_REQUEST))).toHaveLength(0)
    expect(logs.join('\n')).toContain('ssh-agent dial failed')
  })

  it('refuses new dials past the in-flight cap instead of holding agent fds', async () => {
    const agent = await startFakeAgent()
    const { port, logs } = await startListener({
      agentSock: agent.sock, workspace: SESSION, repoUrl: 'git@github.com:acme/app.git',
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
    // The idle reaper is set far out, so only half-close propagation can
    // close the agent side in time.
    const agent = await startFakeAgent()
    const { port } = await startListener({
      agentSock: agent.sock, workspace: SESSION, repoUrl: 'git@github.com:acme/app.git',
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
      agentSock: agent.sock, workspace: SESSION, repoUrl: 'git@github.com:acme/app.git',
      idleTimeoutMs: 150,
    })
    const idle = net.connect({ port, host: '127.0.0.1' })
    idle.on('error', () => { /* closed under us, which is the point */ })
    await new Promise<void>((resolve) => idle.on('close', () => resolve()))
  })
})
