// The server side of the stream relay, exercised against an in-process
// fake that speaks the wire protocol (relay auth line → streamd handshake
// line → {ok} reply → payload). The REAL relay and streamd are covered by
// k8s/proxy + dockerfiles/streamd tests and e2e; this file pins the
// client: handshake pipelining, error surfacing, and each adapter facade.
import net from 'node:net'
import crypto from 'node:crypto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('#platform/k8s/kubectl', () => ({
  k8sNamespace: vi.fn(() => 'test-ns'),
  kubectlGetJson: vi.fn(),
  shellKubectlWithRetry: vi.fn(),
}))

import { kubectlGetJson } from '#platform/k8s/kubectl'
import {
  RelayDialError,
  RelayExecError,
  _resetRelayCacheForTests,
  dialCtrlStream,
  dialPtyStream,
  relayDial,
  relayTcpFactory,
  sessionExec,
  sessionStreamToken,
} from '#platform/k8s/stream-relay'
import { FRAME_DATA, FRAME_EXIT, FRAME_RESIZE, FrameParser, encodeFrame } from '@yaac/shared/stream-frames'

const SECRET = 'relay-secret-0123456789abcdef'
const SID = '0f9b2c4d-1111-2222-3333-444455556666'
const JOB = `yaac-demo-${SID}`

const mockGetJson = vi.mocked(kubectlGetJson)

interface Received {
  auth: { token?: string; sessionId?: string }
  handshake: Record<string, unknown>
  socket: net.Socket
  leftover: Buffer
}

/**
 * A fake relay+streamd in one listener: read the two pipelined JSON lines,
 * verify the relay bearer, then hand the stream to `serve`.
 */
function startFakeRelay(
  serve: (r: Received) => void,
): Promise<{ port: number; close: () => void }> {
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.on('error', () => { /* test teardown */ })
    let buf = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      const first = buf.indexOf(0x0a)
      if (first < 0) return
      const second = buf.indexOf(0x0a, first + 1)
      if (second < 0) return
      socket.removeListener('data', onData)
      const auth = JSON.parse(buf.subarray(0, first).toString('utf8')) as Received['auth']
      const handshake = JSON.parse(buf.subarray(first + 1, second).toString('utf8')) as Record<string, unknown>
      if (auth.token !== SECRET) {
        socket.destroy()
        return
      }
      serve({ auth, handshake, socket, leftover: buf.subarray(second + 1) })
    }
    socket.on('data', onData)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port
      resolve({ port, close: () => server.close() })
    })
  })
}

let relay: { port: number; close: () => void } | null = null

beforeEach(() => {
  _resetRelayCacheForTests()
  mockGetJson.mockReset()
  // The proxy auth secret read (cached after first fetch).
  mockGetJson.mockResolvedValue({ data: { secret: Buffer.from(SECRET).toString('base64') } })
})

afterEach(() => {
  relay?.close()
  relay = null
  vi.unstubAllEnvs()
})

async function withRelay(serve: (r: Received) => void): Promise<void> {
  relay = await startFakeRelay(serve)
  vi.stubEnv('YAAC_RELAY_ADDR', `127.0.0.1:${relay.port}`)
}

const okThen = (r: Received, body?: Buffer): void => {
  r.socket.write('{"ok":true}\n')
  if (body) r.socket.write(body)
}

describe('sessionStreamToken', () => {
  it('derives a stable HMAC of the proxy secret and session id', async () => {
    const a = await sessionStreamToken(SID)
    const b = await sessionStreamToken(SID)
    expect(a).toBe(b)
    expect(a).toBe(crypto.createHmac('sha256', SECRET).update(SID).digest('hex'))
  })
})

describe('relayDial', () => {
  it('pipelines both handshake lines and resolves after the ok reply', async () => {
    let received: Received | null = null
    await withRelay((r) => {
      received = r
      okThen(r, Buffer.from('early-payload'))
    })
    const socket = await relayDial(SID, { kind: 'ctrl', cmd: ['tmux'] })
    const r = received!
    expect(r.auth).toEqual({ token: SECRET, sessionId: SID })
    expect(r.handshake).toEqual({
      token: await sessionStreamToken(SID),
      kind: 'ctrl',
      cmd: ['tmux'],
    })
    // Bytes past the reply line survive the handshake read (unshifted).
    const got = await new Promise<string>((resolve) => {
      socket.once('data', (c: Buffer) => resolve(c.toString('utf8')))
      socket.resume()
    })
    expect(got).toBe('early-payload')
    socket.destroy()
  })

  it('rejects with RelayDialError when streamd refuses', async () => {
    await withRelay((r) => {
      r.socket.end('{"ok":false,"error":"bad token"}\n')
    })
    await expect(relayDial(SID, { kind: 'tcp', port: 80 }))
      .rejects.toThrow(/refused: bad token/)
  })

  it('rejects with RelayDialError when the relay drops the connection', async () => {
    await withRelay((r) => r.socket.destroy())
    await expect(relayDial(SID, { kind: 'tcp', port: 80 }))
      .rejects.toBeInstanceOf(RelayDialError)
  })

  it('rejects with RelayDialError when nothing listens at the relay address', async () => {
    vi.stubEnv('YAAC_RELAY_ADDR', '127.0.0.1:1') // nothing listens on port 1
    await expect(relayDial(SID, { kind: 'tcp', port: 80 }, { timeoutMs: 2_000 }))
      .rejects.toBeInstanceOf(RelayDialError)
  })
})

describe('sessionExec', () => {
  it('wraps the command in sh -c, and resolves stdout/stderr on exit 0', async () => {
    let handshake: Record<string, unknown> = {}
    await withRelay((r) => {
      handshake = r.handshake
      r.socket.end('{"ok":true}\n' + JSON.stringify({ exitCode: 0, stdout: 'hi', stderr: '' }) + '\n')
    })
    const result = await sessionExec(JOB, 'echo hi')
    expect(result).toEqual({ stdout: 'hi', stderr: '' })
    expect(handshake.kind).toBe('exec')
    expect(handshake.cmd).toEqual(['sh', '-c', 'echo hi'])
  })

  it('throws RelayExecError (code + stderr) on a nonzero exit, without retrying', async () => {
    let dials = 0
    await withRelay((r) => {
      dials++
      r.socket.end('{"ok":true}\n' + JSON.stringify({ exitCode: 1, stdout: '', stderr: 'no such session' }) + '\n')
    })
    const err = await sessionExec(JOB, 'tmux has-session -t yaac').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RelayExecError)
    expect((err as RelayExecError).code).toBe(1)
    expect((err as RelayExecError).stderr).toBe('no such session')
    expect(dials).toBe(1)
  })

  it('retries dial failures up to maxAttempts', async () => {
    let dials = 0
    await withRelay((r) => {
      dials++
      r.socket.destroy()
    })
    await expect(sessionExec(JOB, 'true', { maxAttempts: 3, timeout: 2_000 }))
      .rejects.toBeInstanceOf(RelayDialError)
    expect(dials).toBe(3)
  })
})

describe('dialCtrlStream', () => {
  it('buffers pre-dial writes, delivers data, and emits exit on close', async () => {
    await withRelay((r) => {
      okThen(r)
      // Echo whatever arrives (incl. the pre-dial buffered write).
      r.socket.on('data', (c: Buffer) => r.socket.write(c))
      if (r.leftover.length > 0) r.socket.write(r.leftover)
    })
    const child = dialCtrlStream(SID, ['tmux', '-C'])
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
    const data = new Promise<string>((resolve) => {
      child.stdout?.on('data', (c) => resolve(c.toString()))
    })
    child.stdin?.write('display-message ok\n') // before the dial resolves
    expect(await data).toBe('display-message ok\n')
    child.kill()
    await exited
  })

  it('emits error when the dial fails', async () => {
    vi.stubEnv('YAAC_RELAY_ADDR', '127.0.0.1:1')
    const child = dialCtrlStream(SID, ['tmux'])
    const err = await new Promise<unknown>((resolve) => child.on('error', (e) => resolve(e)))
    expect(err).toBeInstanceOf(RelayDialError)
  })
})

describe('dialPtyStream', () => {
  it('speaks the frame protocol: data out, data/exit in, resize control', async () => {
    const serverFrames: Array<{ type: number; payload: Buffer }> = []
    await withRelay((r) => {
      okThen(r)
      const parser = new FrameParser()
      const feed = (c: Buffer): void => {
        for (const f of parser.feed(c)) {
          serverFrames.push(f)
          if (f.type === FRAME_DATA) {
            r.socket.write(encodeFrame(FRAME_DATA, Buffer.from('echo:' + f.payload.toString('utf8'))))
          }
          if (f.type === FRAME_RESIZE) {
            r.socket.write(encodeFrame(FRAME_EXIT, { code: 0 }))
            r.socket.end()
          }
        }
      }
      if (r.leftover.length > 0) feed(r.leftover)
      r.socket.on('data', feed)
    })

    const pty = dialPtyStream(SID, ['sh'], { cols: 100, rows: 30 })
    const outputs: string[] = []
    pty.onData((d) => outputs.push(d))
    const exit = new Promise<number>((resolve) => pty.onExit(({ exitCode }) => resolve(exitCode)))
    pty.write('ls\r') // buffered until the dial lands
    pty.resize(120, 40)
    expect(await exit).toBe(0)
    expect(outputs.join('')).toBe('echo:ls\r')
    const resize = serverFrames.find((f) => f.type === FRAME_RESIZE)
    expect(JSON.parse(resize!.payload.toString('utf8'))).toEqual({ cols: 120, rows: 40 })
  })

  it('coalesces consecutive data frames in one chunk into one callback', async () => {
    await withRelay((r) => {
      // One TCP write carrying three data frames then the exit: the data
      // must dispatch as ONE callback (one WS message downstream), and all
      // of it must land before the exit fires.
      okThen(r, Buffer.concat([
        encodeFrame(FRAME_DATA, Buffer.from('a')),
        encodeFrame(FRAME_DATA, Buffer.from('b')),
        encodeFrame(FRAME_DATA, Buffer.from('c')),
        encodeFrame(FRAME_EXIT, { code: 0 }),
      ]))
      r.socket.end()
    })

    const pty = dialPtyStream(SID, ['sh'], {})
    const outputs: string[] = []
    let outputsAtExit: string[] | null = null
    const exit = new Promise<number>((resolve) => {
      pty.onExit(({ exitCode }) => {
        outputsAtExit = [...outputs]
        resolve(exitCode)
      })
    })
    pty.onData((d) => outputs.push(d))
    expect(await exit).toBe(0)
    expect(outputs).toEqual(['abc'])
    expect(outputsAtExit).toEqual(['abc'])
  })

  it('emits exit(1) when the dial fails (the frontend reconnect owns retries)', async () => {
    vi.stubEnv('YAAC_RELAY_ADDR', '127.0.0.1:1')
    const pty = dialPtyStream(SID, ['sh'], {})
    const code = await new Promise<number>((resolve) => pty.onExit(({ exitCode }) => resolve(exitCode)))
    expect(code).toBe(1)
  })
})

describe('relayTcpFactory', () => {
  it('produces a child-shaped relay that splices stdin/stdout onto a tcp stream', async () => {
    let handshake: Record<string, unknown> = {}
    await withRelay((r) => {
      handshake = r.handshake
      okThen(r)
      r.socket.on('data', (c: Buffer) => r.socket.write(c)) // echo
      if (r.leftover.length > 0) r.socket.write(r.leftover)
    })
    const child = relayTcpFactory(SID)(3000)
    const closed = new Promise<void>((resolve) => child.on('close', () => resolve()))
    const echoed = new Promise<string>((resolve) => {
      child.stdout?.on('data', (c: Buffer) => resolve(c.toString('utf8')))
    })
    child.stdin?.write('GET / HTTP/1.1\r\n')
    expect(await echoed).toBe('GET / HTTP/1.1\r\n')
    expect(handshake).toMatchObject({ kind: 'tcp', port: 3000 })
    child.kill()
    await closed
  })

  it('emits close when the dial fails so the forwarder drops the client', async () => {
    vi.stubEnv('YAAC_RELAY_ADDR', '127.0.0.1:1')
    const child = relayTcpFactory(SID)(3000)
    await new Promise<void>((resolve) => child.on('close', () => resolve()))
  })
})
