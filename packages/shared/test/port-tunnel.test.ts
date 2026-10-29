/**
 * The client half of a port forward: `startForward`, and the hostname
 * router `startHostRouter` with the head reading it shares with the server.
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
import { answerAndClose, readRequestHead, startForward, startHostRouter, type ForwardHandle } from '#port-tunnel'

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

  it('close cuts open connections and their tunnels, not just the listener', async () => {
    let tunnelClosed!: Promise<void>
    const server = await fakeServer({
      onSocket: (ws) => {
        tunnelClosed = new Promise((resolve) => ws.once('close', () => resolve()))
        ws.on('message', (data: Buffer) => ws.send(data))
      },
    })
    cleanups.push(server.close)
    const handle = await startForward(
      { baseUrl: server.baseUrl },
      { session: 'sess-1', containerPort: 5173, hostPort: 0 },
    )

    // A long-lived connection (a keep-alive or HMR socket), still open.
    const socket = net.connect(handle.hostPort, '127.0.0.1', () => socket.write('hi'))
    await new Promise<void>((resolve) => socket.once('data', () => resolve()))
    const socketClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()))

    handle.close()

    await socketClosed
    await tunnelClosed
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

/** Send `payload` to a local port and resolve everything that comes back. */
function exchange(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let got = ''
    const socket = net.connect(port, '127.0.0.1', () => socket.write(payload))
    socket.on('data', (chunk: Buffer) => {
      got += chunk.toString('utf8')
      // The echo server never closes; one echo is the whole answer.
      if (got.length >= payload.length) socket.end()
    })
    socket.on('close', () => resolve(got))
    socket.on('error', reject)
  })
}

describe('startHostRouter', () => {
  const ID = 'ab12cd34-0000-4000-8000-000000000000'
  const request = (host: string): string => `GET /app HTTP/1.1\r\nHost: ${host}\r\n\r\n`

  it('tunnels a connection to the forward its Host names, replaying the whole head', async () => {
    const server = await fakeServer()
    cleanups.push(server.close)
    const asked: Array<{ port: number; idPrefix: string }> = []
    const handle = track(await startHostRouter({ baseUrl: server.baseUrl }, 0, (name) => {
      asked.push(name)
      return { session: ID, containerPort: name.port }
    }))

    const req = request(`5173.ab12cd34.localhost:${String(handle.hostPort)}`)
    expect(await exchange(handle.hostPort, req)).toBe(req)
    expect(asked).toEqual([{ port: 5173, idPrefix: 'ab12cd34' }])
    expect(server.upgrades[0].path).toContain(`id=${ID}`)
    expect(server.upgrades[0].path).toContain('port=5173')
  })

  it('answers 404 without opening a tunnel for a host that names no offered forward', async () => {
    const server = await fakeServer()
    cleanups.push(server.close)
    const handle = track(await startHostRouter({ baseUrl: server.baseUrl }, 0, () => undefined))

    expect(await exchange(handle.hostPort, request('5173.ab12cd34.localhost'))).toMatch(/^HTTP\/1\.1 404 /)
    expect(await exchange(handle.hostPort, request('localhost'))).toMatch(/^HTTP\/1\.1 404 /)
    expect(server.upgrades).toEqual([])
  })
})

describe('readRequestHead', () => {
  /** A connected socket pair: what the client writes, the server reads. */
  async function pair(): Promise<{ client: net.Socket; accepted: net.Socket }> {
    const listener = net.createServer()
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => listener.close(() => resolve())))
    const addr = listener.address()
    const accepted = new Promise<net.Socket>((resolve) => listener.once('connection', resolve))
    const client = net.connect(typeof addr === 'object' && addr ? addr.port : 0, '127.0.0.1')
    const server = await accepted
    cleanups.push(() => {
      client.destroy()
      server.destroy()
    })
    return { client, accepted: server }
  }

  it('waits for a head split across writes, then leaves every byte to be read again', async () => {
    const { client, accepted } = await pair()
    const head = readRequestHead(accepted)
    client.write('GET / HTTP/1.1\r\nHo')
    await new Promise((r) => setTimeout(r, 20))
    client.write('st: 3000.ab12cd34.localhost\r\nHost: second\r\nX-Forwarded-For: 100.64.0.1\r\n\r\nbody')

    const header = await head
    expect(header?.('host')).toBe('3000.ab12cd34.localhost')
    expect(header?.('x-forwarded-for')).toBe('100.64.0.1')
    expect(accepted.isPaused()).toBe(true)
    const replayed = new Promise<string>((resolve) => {
      let got = ''
      accepted.on('data', (c: Buffer) => {
        got += c.toString('utf8')
        if (got.endsWith('body')) resolve(got)
      })
    })
    accepted.resume()
    expect(await replayed).toMatch(/^GET \/ HTTP\/1\.1\r\nHost: 3000\.ab12cd34/)
  })

  it('hands on a head too large to be one with no fields, and drops a connection that ends first', async () => {
    const big = await pair()
    const head = readRequestHead(big.accepted)
    big.client.write(`GET / HTTP/1.1\r\nHost: x\r\nX-Pad: ${'a'.repeat(20_000)}`)
    expect((await head)?.('host')).toBeUndefined()

    const short = await pair()
    const gone = readRequestHead(short.accepted)
    short.client.end('GET / HTTP/1.1\r\n')
    expect(await gone).toBeNull()
    expect(short.accepted.destroyed).toBe(true)
  })
})

describe('answerAndClose', () => {
  it('writes a complete plain-text response and closes', async () => {
    const listener = net.createServer((socket) => answerAndClose(socket, 502, 'nothing listening'))
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => listener.close(() => resolve())))
    const addr = listener.address()
    const res = await fetch(`http://127.0.0.1:${String(typeof addr === 'object' && addr ? addr.port : 0)}/`)
    expect(res.status).toBe(502)
    expect(await res.text()).toBe('nothing listening\n')
  })
})
