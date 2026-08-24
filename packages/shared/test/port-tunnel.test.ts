/**
 * The client half of a port forward — `startForward`.
 *
 * Driven against a REAL WebSocket server standing in for yaac's
 * `/forward/attach`, because what this module is is the splice between a
 * TCP socket and a WebSocket: mocking either end would leave nothing under
 * test. The far end here echoes, so a byte that comes back proves the
 * whole round trip — the listener bound, the socket opened with the right
 * URL and bearer, and both directions spliced.
 */
import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import { createServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { startForward, tunnelUrl, type ForwardHandle } from '#port-tunnel'

interface Upgrade {
  path: string
  authorization: string | undefined
}

/** A stand-in for the server's `/forward/attach`: records what each client
 *  asked for, and echoes every binary frame back. */
async function fakeServer(opts: {
  onSocket?: (ws: WebSocket) => void
} = {}): Promise<{ baseUrl: string; upgrades: Upgrade[]; close: () => Promise<void> }> {
  const upgrades: Upgrade[] = []
  const http = createServer()
  const wss = new WebSocketServer({ server: http })
  wss.on('connection', (ws, req) => {
    upgrades.push({ path: req.url ?? '', authorization: req.headers.authorization })
    if (opts.onSocket) {
      opts.onSocket(ws)
      return
    }
    ws.on('message', (data: Buffer) => ws.send(data))
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const addr = http.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    upgrades,
    close: () => new Promise<void>((resolve) => {
      wss.close(() => http.close(() => resolve()))
    }),
  }
}

/** Connect to the forward, send `payload`, and resolve what comes back. */
function roundTrip(hostPort: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(hostPort, '127.0.0.1', () => socket.write(payload))
    socket.on('data', (chunk: Buffer) => {
      socket.end()
      resolve(chunk.toString('utf8'))
    })
    socket.on('error', reject)
  })
}

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const c of cleanups.reverse()) await c()
  cleanups.length = 0
})

function track(handle: ForwardHandle): ForwardHandle {
  cleanups.push(() => handle.close())
  return handle
}

describe('startForward', () => {
  it('binds the host port and carries bytes both ways over one socket per connection', async () => {
    const server = await fakeServer()
    cleanups.push(server.close)

    const handle = track(await startForward(
      { baseUrl: server.baseUrl, secret: 'sekrit' },
      { session: 'sess-1', containerPort: 5173, hostPort: 0 },
    ))

    expect(await roundTrip(handle.hostPort, 'hello')).toBe('hello')

    // The bearer rides the upgrade, exactly as it does for the PTY —
    // there is no token in the URL.
    const [upgrade] = server.upgrades
    expect(upgrade.authorization).toBe('Bearer sekrit')
    expect(upgrade.path).toContain('/forward/attach')
    expect(upgrade.path).toContain('id=sess-1')
    expect(upgrade.path).toContain('port=5173')
  })

  it('opens one WebSocket per accepted TCP connection', async () => {
    // v1 frames it this way on purpose (the kubectl shape): nothing is
    // multiplexed, so nothing has to be framed.
    const server = await fakeServer()
    cleanups.push(server.close)
    const handle = track(await startForward(
      { baseUrl: server.baseUrl, secret: 's' },
      { session: 'sess-1', containerPort: 5173, hostPort: 0 },
    ))

    expect(await roundTrip(handle.hostPort, 'one')).toBe('one')
    expect(await roundTrip(handle.hostPort, 'two')).toBe('two')

    expect(server.upgrades).toHaveLength(2)
  })

  it('holds the client\'s first bytes until the tunnel is open', async () => {
    // A TCP client writes the moment it connects; the WebSocket handshake
    // has not finished yet. Bytes written into a socket nothing is reading
    // would be lost silently, which looks like a hang rather than a fault.
    const server = await fakeServer({
      onSocket: (ws) => {
        ws.on('message', (data: Buffer) => ws.send(data))
      },
    })
    cleanups.push(server.close)
    const handle = track(await startForward(
      { baseUrl: server.baseUrl, secret: 's' },
      { session: 'sess-1', containerPort: 5173, hostPort: 0 },
    ))

    expect(await roundTrip(handle.hostPort, 'GET / HTTP/1.1\r\n\r\n'))
      .toBe('GET / HTTP/1.1\r\n\r\n')
  })

  it('reports a refused tunnel per connection, leaving the listener up', async () => {
    // The dial happens inside the cluster where this process cannot look,
    // so a 4xxx close code is the whole diagnosis — and it must not take
    // the forward down with it: the next connection may well work.
    const server = await fakeServer({
      onSocket: (ws) => ws.close(4001, 'dial failed'),
    })
    cleanups.push(server.close)
    const errors: string[] = []
    const handle = track(await startForward(
      { baseUrl: server.baseUrl, secret: 's' },
      { session: 'sess-1', containerPort: 5173, hostPort: 0 },
      { onConnectionError: (m) => errors.push(m) },
    ))

    await new Promise<void>((resolve) => {
      const socket = net.connect(handle.hostPort, '127.0.0.1')
      socket.on('close', () => resolve())
      socket.on('error', () => resolve())
    })

    expect(errors).toEqual(['dial failed'])
  })

  it('rejects when the host port is already taken', async () => {
    // The one failure a forward cannot work around, and the one the server
    // could never have reported — the machine that binds is this one.
    const squatter = net.createServer()
    await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => squatter.close(() => resolve())))
    const addr = squatter.address()
    const taken = typeof addr === 'object' && addr ? addr.port : 0

    await expect(startForward(
      { baseUrl: 'http://127.0.0.1:1', secret: 's' },
      { session: 'sess-1', containerPort: 5173, hostPort: taken },
    )).rejects.toThrow(/EADDRINUSE/)
  })

  it('speaks wss to an https origin, and ws to an http one', () => {
    // The remote-server shape: the scheme has to follow the origin's, or
    // the upgrade is made in the clear against a TLS listener.
    //
    // Asserted on the URL rather than on a failed connection to a
    // made-up hostname. That form only holds where DNS says the name does
    // not exist — inside a sandboxed worktree, whose proxy accepts the dial
    // and drops the handshake, the error names no host at all and the test
    // fails for a reason that has nothing to do with this module.
    const spec = { session: 'sess-1', containerPort: 5173, hostPort: 0 }
    expect(tunnelUrl({ baseUrl: 'https://srv.example.ts.net', secret: 's' }, spec))
      .toBe('wss://srv.example.ts.net/forward/attach?id=sess-1&port=5173')
    expect(tunnelUrl({ baseUrl: 'http://127.0.0.1:8787', secret: 's' }, spec))
      .toBe('ws://127.0.0.1:8787/forward/attach?id=sess-1&port=5173')
  })
})
