/**
 * The client half of a port forward: `startForward`, the hostname router
 * `startHostRouter` with the head reading it shares with the server, and
 * the preview pane's SOCKS5 listener `startSocksTunnel`.
 *
 * Runs against a real WebSocket server standing in for
 * `/api/forward/attach`, since the module is the splice between a TCP
 * socket and a WebSocket. The server echoes, so a byte that comes back
 * proves the whole round trip.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import net from 'node:net'
import os from 'node:os'
import { createServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  answerAndClose, readRequestHead, startForward, startHostRouter, startSocksTunnel, type ForwardHandle,
} from '#port-tunnel'

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

/** A SOCKS5 CONNECT to `host` (a name, or an IPv4 address as `[a, b, c, d]`)
 *  at `port`, with command `cmd`. */
function socksConnect(host: string | number[], port: number, cmd = 1): Buffer {
  const addr = typeof host === 'string'
    ? Buffer.concat([Buffer.from([3, host.length]), Buffer.from(host, 'latin1')])
    : Buffer.from([1, ...host])
  const portBytes = Buffer.alloc(2)
  portBytes.writeUInt16BE(port)
  return Buffer.concat([Buffer.from([5, cmd, 0]), addr, portBytes])
}

/** Send raw bytes to a local port; resolve everything back until it closes,
 *  or until `want` bytes came, then close. */
function rawExchange(port: number, payload: Buffer, want = Infinity): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const socket = net.connect(port, '127.0.0.1', () => socket.write(payload))
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      if (Buffer.concat(chunks).length >= want) socket.end()
    })
    socket.on('close', () => resolve(Buffer.concat(chunks)))
    socket.on('error', reject)
  })
}

describe('startSocksTunnel', () => {
  const NO_AUTH = Buffer.from([5, 1, 0])
  const GRANTED = Buffer.from([5, 0, 5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
  const REFUSED = Buffer.from([5, 0, 5, 2, 0, 1, 0, 0, 0, 0, 0, 0])

  it('tunnels a CONNECT to any loopback name into the route for its port, bytes sent after it included', async () => {
    // A client may write its request before the greeting is answered, and
    // its first bytes before the CONNECT is.
    const server = await fakeServer()
    cleanups.push(server.close)
    const asked: number[] = []
    const handle = track(await startSocksTunnel((port) => {
      asked.push(port)
      return Promise.resolve({ target: { baseUrl: server.baseUrl }, spec: { session: 'ws-1', containerPort: port } })
    }))

    const hosts: Array<[string | number[], number]> = [
      ['localhost', 3000], ['app.localhost', 3001], ['::1', 3002], [[127, 0, 0, 1], 3003], ['localhost.', 3004],
    ]
    for (const [host, port] of hosts) {
      const request = Buffer.concat([NO_AUTH, socksConnect(host, port), Buffer.from('ping')])
      expect(await rawExchange(handle.hostPort, request, GRANTED.length + 4))
        .toEqual(Buffer.concat([GRANTED, Buffer.from('ping')]))
    }
    expect(asked).toEqual([3000, 3001, 3002, 3003, 3004])
    expect(server.upgrades).toHaveLength(5)
    for (const [i, upgrade] of server.upgrades.entries()) {
      expect(upgrade.path).toContain('id=ws-1')
      expect(upgrade.path).toContain(`port=${String(3000 + i)}`)
    }
  })

  it('refuses, opening no tunnel, a port with no route, any other way onto this machine, and what it does not speak', async () => {
    // Chromium sends every request through the listener; `0.0.0.0` and `::`
    // reach local listeners, as do names that resolve to loopback and this
    // machine's own interface addresses.
    const server = await fakeServer()
    cleanups.push(server.close)
    const handle = track(await startSocksTunnel((port) => Promise.resolve(port === 3000
      ? { target: { baseUrl: server.baseUrl }, spec: { session: 'ws-1', containerPort: port } }
      : undefined)))
    const own = Object.values(os.networkInterfaces()).flat().flatMap((a) => (a ? [a.address] : []))

    for (const host of ['0.0.0.0', '::', '::ffff:127.0.0.1', ...own]) {
      expect(await rawExchange(handle.hostPort, Buffer.concat([NO_AUTH, socksConnect(host, Number(new URL(server.baseUrl).port))])), host).toEqual(REFUSED)
    }
    expect(await rawExchange(handle.hostPort, Buffer.concat([NO_AUTH, socksConnect([0, 0, 0, 0], Number(new URL(server.baseUrl).port))]))).toEqual(REFUSED)
    expect(await rawExchange(handle.hostPort, Buffer.concat([NO_AUTH, socksConnect('localhost', 4000)]))).toEqual(REFUSED)
    // BIND, and a greeting offering only username/password.
    expect(await rawExchange(handle.hostPort, Buffer.concat([NO_AUTH, socksConnect('localhost', 3000, 2)]))).toEqual(REFUSED)
    expect(await rawExchange(handle.hostPort, Buffer.from([5, 1, 2]))).toEqual(Buffer.from([5, 0xff]))
    expect(server.upgrades).toEqual([])
  })

  it('opens no tunnel for a client that resets or leaves while its route is pending, and leaves none open', async () => {
    // The route lookup waits on the desktop app's first snapshot, and the
    // listener answers any local process.
    const opened: WebSocket[] = []
    const server = await fakeServer({ onSocket: (ws) => opened.push(ws) })
    cleanups.push(server.close)
    const held: Array<() => void> = []
    const handle = track(await startSocksTunnel((port) => new Promise((resolve) => {
      held.push(() => resolve({ target: { baseUrl: server.baseUrl }, spec: { session: 'ws-1', containerPort: port } }))
    })))
    const request = Buffer.concat([NO_AUTH, socksConnect('localhost', 3000)])
    const pending = async (leave: (socket: net.Socket) => void): Promise<void> => {
      const socket = net.connect(handle.hostPort, '127.0.0.1', () => socket.write(request))
      socket.on('error', () => { /* reset by this end */ })
      const count = held.length
      await vi.waitFor(() => expect(held).toHaveLength(count + 1))
      leave(socket)
      await new Promise((r) => setTimeout(r, 50))
      held[count]()
    }

    await pending((socket) => socket.resetAndDestroy())
    await pending((socket) => socket.end())
    await new Promise((r) => setTimeout(r, 300))
    expect(opened.filter((ws) => ws.readyState !== ws.CLOSED)).toEqual([])
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
