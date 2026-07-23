// In-process tests for streamd (the in-pod stream daemon): handshake
// auth, each stream kind, and the framing codec — it is just a TCP
// server, so the whole protocol is exercised over loopback sockets.
import net from 'node:net'
import { describe, it, expect, afterEach } from 'vitest'
// Untyped plain-JS modules (they run under bare node in the pod).
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { createStreamd } from '../streamd.js'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { FRAME_DATA, FRAME_EXIT, FRAME_RESIZE, FrameParser, encodeFrame } from '../framing.js'

const TOKEN = 'test-token-0123456789abcdef'

interface Daemon { listen(): Promise<number>; close(): Promise<void> }

const daemons: Daemon[] = []
const sockets: net.Socket[] = []

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy()
  for (const d of daemons.splice(0)) await d.close()
})

async function startDaemon(): Promise<number> {
  const d = createStreamd({ token: TOKEN, port: 0, host: '127.0.0.1' }) as Daemon
  daemons.push(d)
  return d.listen()
}

function dial(port: number): net.Socket {
  const s = net.connect(port, '127.0.0.1')
  sockets.push(s)
  return s
}

/** Dial + handshake; resolve with the socket and the reply object. */
function handshake(
  port: number,
  hs: Record<string, unknown>,
): Promise<{ socket: net.Socket; reply: { ok: boolean; error?: string }; leftover: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = dial(port)
    let buf = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      const nl = buf.indexOf(0x0a)
      if (nl < 0) return
      socket.removeListener('data', onData)
      socket.pause()
      const leftover = buf.subarray(nl + 1)
      if (leftover.length > 0) socket.unshift(leftover)
      resolve({
        socket,
        reply: JSON.parse(buf.subarray(0, nl).toString('utf8')) as { ok: boolean; error?: string },
        leftover,
      })
    }
    socket.on('data', onData)
    socket.on('error', reject)
    socket.on('connect', () => socket.write(JSON.stringify(hs) + '\n'))
  })
}

function readAll(socket: net.Socket): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    socket.on('data', (c: Buffer) => chunks.push(c))
    socket.on('close', () => resolve(Buffer.concat(chunks)))
    socket.resume()
  })
}

describe('framing codec', () => {
  it('round-trips frames across arbitrary chunk boundaries', () => {
    const frames = [
      encodeFrame(FRAME_DATA, Buffer.from('hello world')),
      encodeFrame(FRAME_RESIZE, { cols: 120, rows: 40 }),
      encodeFrame(FRAME_EXIT, { code: 3 }),
    ]
    const wire = Buffer.concat(frames)
    // Feed one byte at a time — the parser must buffer partial headers
    // and payloads.
    const parser = new FrameParser() as { feed(b: Buffer): Array<{ type: number; payload: Buffer }> }
    const out: Array<{ type: number; payload: Buffer }> = []
    for (let i = 0; i < wire.length; i++) {
      out.push(...parser.feed(wire.subarray(i, i + 1)))
    }
    expect(out).toHaveLength(3)
    expect(out[0].type).toBe(FRAME_DATA)
    expect(out[0].payload.toString('utf8')).toBe('hello world')
    expect(JSON.parse(out[1].payload.toString('utf8'))).toEqual({ cols: 120, rows: 40 })
    expect(out[2].type).toBe(FRAME_EXIT)
  })

  it('throws on an oversized frame (protocol error)', () => {
    const parser = new FrameParser() as { feed(b: Buffer): unknown }
    const evil = Buffer.alloc(5)
    evil.writeUInt8(FRAME_DATA, 0)
    evil.writeUInt32BE(0x7fffffff, 1)
    expect(() => parser.feed(evil)).toThrow(/frame too large/)
  })
})

describe('handshake', () => {
  it('refuses a bad token', async () => {
    const port = await startDaemon()
    const { reply } = await handshake(port, { token: 'wrong', kind: 'exec', cmd: ['true'] })
    expect(reply).toEqual({ ok: false, error: 'bad token' })
  })

  it('refuses an unknown kind', async () => {
    const port = await startDaemon()
    const { reply } = await handshake(port, { token: TOKEN, kind: 'nope' })
    expect(reply.ok).toBe(false)
    expect(reply.error).toContain('unknown kind')
  })

  it('refuses a malformed handshake line', async () => {
    const port = await startDaemon()
    const socket = dial(port)
    const replyLine = new Promise<string>((resolve) => {
      socket.once('data', (c: Buffer) => resolve(c.toString('utf8')))
    })
    socket.on('connect', () => socket.write('not json\n'))
    expect(JSON.parse(await replyLine)).toEqual({ ok: false, error: 'malformed handshake' })
  })
})

describe('exec streams', () => {
  it('runs the argv and reports exitCode/stdout/stderr as one JSON line', async () => {
    const port = await startDaemon()
    const { socket } = await handshake(port, {
      token: TOKEN, kind: 'exec', cmd: ['sh', '-c', 'echo out; echo err >&2; exit 0'],
    })
    const result = JSON.parse((await readAll(socket)).toString('utf8')) as Record<string, unknown>
    expect(result).toMatchObject({ exitCode: 0, stdout: 'out\n', stderr: 'err\n' })
  })

  it('reports a nonzero exit code', async () => {
    const port = await startDaemon()
    const { socket } = await handshake(port, {
      token: TOKEN, kind: 'exec', cmd: ['sh', '-c', 'echo nope >&2; exit 7'],
    })
    const result = JSON.parse((await readAll(socket)).toString('utf8')) as Record<string, unknown>
    expect(result).toMatchObject({ exitCode: 7, stderr: 'nope\n' })
  })
})

describe('ctrl streams', () => {
  it('splices stdin/stdout raw and ends the stream on process exit', async () => {
    const port = await startDaemon()
    const { socket } = await handshake(port, { token: TOKEN, kind: 'ctrl', cmd: ['cat'] })
    socket.write('line one\n')
    socket.end() // EOF → cat exits → daemon ends the stream
    const out = await readAll(socket)
    expect(out.toString('utf8')).toBe('line one\n')
  })
})

describe('tcp streams', () => {
  it('splices bytes to a local port both ways', async () => {
    // A local echo server standing in for an in-pod dev server.
    const echo = net.createServer((c) => c.pipe(c))
    const echoPort = await new Promise<number>((resolve) => {
      echo.listen(0, '127.0.0.1', () => resolve((echo.address() as net.AddressInfo).port))
    })
    try {
      const port = await startDaemon()
      const { socket } = await handshake(port, { token: TOKEN, kind: 'tcp', port: echoPort })
      const got = new Promise<string>((resolve) => {
        socket.once('data', (c: Buffer) => resolve(c.toString('utf8')))
      })
      socket.write('ping')
      socket.resume()
      expect(await got).toBe('ping')
    } finally {
      echo.close()
    }
  })

  it('refuses an invalid port', async () => {
    const port = await startDaemon()
    const { reply } = await handshake(port, { token: TOKEN, kind: 'tcp', port: 'nope' })
    expect(reply.ok).toBe(false)
  })
})

describe('pty streams', () => {
  it('runs the argv under a PTY, frames output, and sends an exit frame', async () => {
    const port = await startDaemon()
    const { socket } = await handshake(port, {
      token: TOKEN, kind: 'pty', cmd: ['sh', '-c', 'echo from-pty'], cols: 80, rows: 24,
    })
    const wire = await readAll(socket)
    const parser = new FrameParser() as { feed(b: Buffer): Array<{ type: number; payload: Buffer }> }
    const frames = parser.feed(wire)
    const data = frames.filter((f) => f.type === FRAME_DATA)
      .map((f) => f.payload.toString('utf8')).join('')
    expect(data).toContain('from-pty')
    const exit = frames.find((f) => f.type === FRAME_EXIT)
    expect(exit).toBeDefined()
    expect(JSON.parse(exit!.payload.toString('utf8'))).toEqual({ code: 0 })
  })

  it('delivers input frames to the child TTY', async () => {
    const port = await startDaemon()
    const { socket } = await handshake(port, {
      token: TOKEN, kind: 'pty', cmd: ['cat'], cols: 80, rows: 24,
    })
    const parser = new FrameParser() as { feed(b: Buffer): Array<{ type: number; payload: Buffer }> }
    const sawEcho = new Promise<string>((resolve) => {
      let acc = ''
      socket.on('data', (c: Buffer) => {
        for (const f of parser.feed(c)) {
          if (f.type === FRAME_DATA) acc += f.payload.toString('utf8')
          if (acc.includes('typed')) resolve(acc)
        }
      })
    })
    socket.write(encodeFrame(FRAME_DATA, Buffer.from('typed\n')))
    socket.resume()
    expect(await sawEcho).toContain('typed')
    socket.destroy() // daemon kills the pty child on socket close
  })
})
