// The server side of the stream relay, exercised against an in-process
// fake that speaks the wire protocol (relay auth line → streamd handshake
// line → {ok} reply → payload). The REAL relay and streamd are covered by
// k8s/proxy + dockerfiles/streamd tests and e2e; this file pins the
// client: handshake pipelining, error surfacing, and each adapter facade.
import net from 'node:net'
import crypto from 'node:crypto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The relay's own boundary is the socket (a real listener below); its two
// cluster reads — the proxy auth secret and, when nested, the inner proxy's
// pod IP — are kubectl child processes, so those run for real too.
type ExecResult = { stdout: string; stderr: string }
type ExecCallback = (err: unknown, res?: ExecResult) => void
const execFileMock = vi.fn<(file: string, args: readonly string[]) => Promise<ExecResult>>()
const execMock = vi.fn<(command: string) => Promise<ExecResult>>()
vi.mock('node:child_process', () => ({
  execFile: (file: string, args: readonly string[], opts: unknown, cb?: ExecCallback) => {
    const actualCb = (typeof opts === 'function' ? opts : cb) as ExecCallback
    void execFileMock(file, args).then(
      (res) => actualCb(null, res),
      (err: unknown) => actualCb(err),
    )
    return { stdin: { end: vi.fn() } }
  },
  exec: (command: string, opts: unknown, cb?: ExecCallback) => {
    const actualCb = (typeof opts === 'function' ? opts : cb) as ExecCallback
    void execMock(command).then(
      (res) => actualCb(null, res),
      (err: unknown) => actualCb(err),
    )
  },
  spawn: vi.fn(),
}))

import {
  RelayExecError,
  bootStreamd,
  dialCtrlStream,
  dialPtyStream,
  invalidateRelayAddr,
  relayDial,
  relayTcpFactory,
  sessionExec,
  sessionStreamToken,
  waitForStreamd,
  RELAY_PORT,
} from '#platform/k8s'
// Internals: the dial-failure type the relay throws, the cache reset, and
// the exec/boot seam waitForStreamd takes.
import {
  RelayDialError,
  _resetRelayCacheForTests,
  type WaitForStreamdDeps,
} from '#platform/k8s/stream-relay'
import { FRAME_DATA, FRAME_EXIT, FRAME_RESIZE, FrameParser, encodeFrame } from '@yaac/shared/stream-frames'

const SECRET = 'relay-secret-0123456789abcdef'
const SID = '0f9b2c4d-1111-2222-3333-444455556666'
const JOB = `yaac-demo-${SID}`

/** Serve the two kubectl reads: the proxy auth Secret and the pods list. */
let podsPayload: unknown = { items: [] }
function serveKubectl(): void {
  execFileMock.mockImplementation((_file, args) => Promise.resolve({
    stdout: JSON.stringify(args[1] === 'secret'
      ? { data: { secret: Buffer.from(SECRET).toString('base64') } }
      : podsPayload),
    stderr: '',
  }))
}

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
  fixedPort = 0,
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
    server.listen(fixedPort, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port
      resolve({ port, close: () => server.close() })
    })
  })
}

let relay: { port: number; close: () => void } | null = null

beforeEach(() => {
  _resetRelayCacheForTests()
  execFileMock.mockReset()
  execMock.mockReset()
  podsPayload = { items: [] }
  vi.stubEnv('YAAC_K8S_NAMESPACE', 'test-ns')
  serveKubectl()
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

describe('waitForStreamd', () => {
  // Fake timers make Date.now() advance through the injected sleep, so the
  // heal threshold and deadline are exercised without real waiting.
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function makeDeps(exec: WaitForStreamdDeps['exec']): WaitForStreamdDeps & {
    boot: ReturnType<typeof vi.fn>
  } {
    return {
      exec,
      boot: vi.fn().mockResolvedValue(undefined),
      sleepMs: (ms: number) => {
        vi.advanceTimersByTime(ms)
        return Promise.resolve()
      },
    }
  }

  it('returns as soon as a relay exec lands', async () => {
    const deps = makeDeps(vi.fn().mockResolvedValue({ stdout: '', stderr: '' }))
    await waitForStreamd(JOB, { timeoutMs: 1_000 }, deps)
    expect(deps.boot).not.toHaveBeenCalled()
  })

  it('retries dial failures until streamd answers', async () => {
    const exec = vi.fn()
      .mockRejectedValueOnce(new RelayDialError('no route'))
      .mockRejectedValueOnce(new RelayDialError('refused'))
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
    await waitForStreamd(JOB, { timeoutMs: 10_000 }, makeDeps(exec))
    expect(exec).toHaveBeenCalledTimes(3)
  })

  it('rethrows a non-dial error immediately — the command ran, streamd is up', async () => {
    const exec = vi.fn().mockRejectedValue(new RelayExecError('exit 1', 1, '', 'boom'))
    const deps = makeDeps(exec)
    await expect(waitForStreamd(JOB, { timeoutMs: 10_000 }, deps)).rejects.toThrow('exit 1')
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('re-boots streamd via kubectl exec once past half the budget, then keeps dialing', async () => {
    const deps = makeDeps(vi.fn().mockImplementation(() =>
      deps.boot.mock.calls.length > 0
        ? Promise.resolve({ stdout: '', stderr: '' })
        : Promise.reject(new RelayDialError('no route'))))
    await waitForStreamd(JOB, { timeoutMs: 10_000 }, deps)
    expect(deps.boot).toHaveBeenCalledTimes(1)
  })

  it('fails with the last dial error once the deadline passes', async () => {
    const deps = makeDeps(vi.fn().mockRejectedValue(new RelayDialError('no route')))
    await expect(waitForStreamd(JOB, { timeoutMs: 3_000 }, deps))
      .rejects.toThrow(/streamd in .* not reachable after 3000ms: .*no route/)
    expect(deps.boot).toHaveBeenCalledTimes(1)
  })
})

describe('bootStreamd', () => {
  it('starts a detached streamd in the pod via one non-retried kubectl exec', async () => {
    execMock.mockResolvedValue({ stdout: '', stderr: '' })
    await bootStreamd(JOB)
    expect(execMock).toHaveBeenCalledTimes(1)
    const [command] = execMock.mock.calls[0]
    expect(command).toBe(
      `kubectl exec -n test-ns job/${JOB} -- `
      + "sh -c 'setsid node /opt/yaac/streamd/main.js >>/tmp/streamd.log 2>&1 </dev/null &'",
    )
  })

  it('propagates the exec failure so the caller can fall back', async () => {
    execMock.mockRejectedValue(Object.assign(new Error('kubectl failed'), { stderr: 'not found' }))
    await expect(bootStreamd(JOB)).rejects.toThrow('kubectl failed')
    expect(execMock).toHaveBeenCalledTimes(1)
  })
})

describe('invalidateRelayAddr', () => {
  const podLists = (): number =>
    execFileMock.mock.calls.filter(([, args]) => args[1] === 'pods').length

  it('drops the cached inner-proxy address so the next dial re-resolves it', async () => {
    // Nested: the relay is the inner proxy's pod IP on the fixed relay port,
    // read from the vcluster apiserver and cached until invalidated.
    vi.stubEnv('YAAC_NESTED', '1')
    podsPayload = {
      items: [
        { status: { phase: 'Pending', podIP: '198.51.100.9' } },
        { status: { phase: 'Running', podIP: '127.0.0.1' } },
      ],
    }
    relay = await startFakeRelay((r) => okThen(r), RELAY_PORT)

    ;(await relayDial(SID, { kind: 'tcp', port: 80 })).destroy()
    expect(podLists()).toBe(1)
    ;(await relayDial(SID, { kind: 'tcp', port: 80 })).destroy()
    expect(podLists()).toBe(1)

    invalidateRelayAddr()
    ;(await relayDial(SID, { kind: 'tcp', port: 80 })).destroy()
    expect(podLists()).toBe(2)
  })

  it('surfaces a nested proxy with no pod IP yet as a dial failure', async () => {
    vi.stubEnv('YAAC_NESTED', '1')
    podsPayload = { items: [{ status: { phase: 'Pending' } }] }
    await expect(relayDial(SID, { kind: 'tcp', port: 80 }))
      .rejects.toThrow(/no inner proxy pod IP yet/)
  })
})
