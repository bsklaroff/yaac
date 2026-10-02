/**
 * The client half of a port forward — `startForward`.
 *
 * Runs against a real WebSocket server standing in for
 * `/api/forward/attach`, since the module is the splice between a TCP
 * socket and a WebSocket. The server echoes, so a byte that comes back
 * proves the whole round trip.
 */
import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import { createServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { startForward, type ForwardHandle } from '#port-tunnel'

interface Upgrade {
  path: string
  authorization: string | undefined
}

/** A stand-in for the server's `/api/forward/attach`: records what each client
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
      { baseUrl: server.baseUrl },
      { session: 'sess-1', containerPort: 5173, hostPort: 0 },
    ))

    expect(await roundTrip(handle.hostPort, 'hello')).toBe('hello')

    // No credential is sent; the server identifies the caller from the
    // request, as for the PTY.
    const [upgrade] = server.upgrades
    expect(upgrade.authorization).toBeUndefined()
    expect(upgrade.path).toContain('/api/forward/attach')
    expect(upgrade.path).toContain('id=sess-1')
    expect(upgrade.path).toContain('port=5173')
  })

  it('opens one WebSocket per accepted TCP connection', async () => {
    // Raw bytes, unframed: v1 multiplexes nothing.
    const server = await fakeServer()
    cleanups.push(server.close)
    const handle = track(await startForward(
      { baseUrl: server.baseUrl },
      { session: 'sess-1', containerPort: 5173, hostPort: 0 },
    ))

    expect(await roundTrip(handle.hostPort, 'one')).toBe('one')
    expect(await roundTrip(handle.hostPort, 'two')).toBe('two')

    expect(server.upgrades).toHaveLength(2)
  })

  it('holds the client\'s first bytes until the tunnel is open', async () => {
    // A TCP client may write before the WebSocket handshake finishes; those
    // bytes must be buffered, not lost.
    const server = await fakeServer({
      onSocket: (ws) => {
        ws.on('message', (data: Buffer) => ws.send(data))
      },
    })
    cleanups.push(server.close)
    const handle = track(await startForward(
      { baseUrl: server.baseUrl },
      { session: 'sess-1', containerPort: 5173, hostPort: 0 },
    ))

    expect(await roundTrip(handle.hostPort, 'GET / HTTP/1.1\r\n\r\n'))
      .toBe('GET / HTTP/1.1\r\n\r\n')
  })

  it('reports a refused tunnel per connection, leaving the listener up', async () => {
    // The dial happens in the cluster, so the 4xxx close code is the only
    // diagnosis. It must not stop the forward; the next connection may work.
    const server = await fakeServer({
      onSocket: (ws) => ws.close(4001, 'dial failed'),
    })
    cleanups.push(server.close)
    const errors: string[] = []
    const handle = track(await startForward(
      { baseUrl: server.baseUrl },
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
    // Only this machine can report a failed bind.
    const squatter = net.createServer()
    await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => squatter.close(() => resolve())))
    const addr = squatter.address()
    const taken = typeof addr === 'object' && addr ? addr.port : 0

    await expect(startForward(
      { baseUrl: 'http://127.0.0.1:1' },
      { session: 'sess-1', containerPort: 5173, hostPort: taken },
    )).rejects.toThrow(/EADDRINUSE/)
  })
})
