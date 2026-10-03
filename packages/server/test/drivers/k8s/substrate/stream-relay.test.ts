// The client side of the stream relay, against an in-process fake speaking
// the wire protocol (relay auth line, streamd handshake line, {ok} reply,
// payload). The real relay and streamd have their own tests
// (docs/stream-relay.md).
import net from 'node:net'
import crypto from 'node:crypto'
import type * as childProcess from 'node:child_process'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type * as netModule from 'node:net'

// The socket is a real listener. The proxy auth Secret is read from the
// fake cluster, and the kubectl exec boot is a mocked child process.
type ExecResult = { stdout: string; stderr: string }
type ExecCallback = (err: unknown, res?: ExecResult) => void
const execMock = vi.fn<(command: string) => Promise<ExecResult>>()
const spawnMock = vi.fn<(file: string, args: readonly string[]) => unknown>()
/** Where a dial to the proxy Service lands: the fake relay's `host:port`,
 *  or (undefined) the Service's real cluster DNS name. */
let relayHost: string | undefined
vi.mock('node:net', async (importOriginal) => {
  const real = await importOriginal<typeof netModule>()
  const connect = (port: number, host: string): netModule.Socket => {
    if (relayHost === undefined || !host.endsWith('.svc.cluster.local')) return real.connect(port, host)
    const [h, p] = relayHost.split(':')
    return real.connect(Number(p), h)
  }
  return { ...real, connect, default: { ...real, connect } }
})
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof childProcess>(),
  exec: (command: string, opts: unknown, cb?: ExecCallback) => {
    const actualCb = (typeof opts === 'function' ? opts : cb) as ExecCallback
    void execMock(command).then(
      (res) => actualCb(null, res),
      (err: unknown) => actualCb(err),
    )
  },
  spawn: (file: string, args: readonly string[]) => spawnMock(file, args),
}))

import {
  bootStreamd,
  dialCtrlStream,
  dialPtyStream,
  relayDial,
  podExec,
  podStreamToken,
  readProxyAuthSecret,
  waitForStreamd,
} from '#drivers/k8s/substrate'
// Internals, for setup and assertions only.
import {
  RelayDialError,
  _resetRelayCacheForTests,
  type WaitForStreamdDeps,
} from '#drivers/k8s/substrate/stream-relay'
import { FRAME_DATA, FRAME_EXIT, FRAME_RESIZE, FrameParser, encodeFrame } from '@yaac/shared/stream-frames'
import { WorkspaceExecError } from '#drivers/contract'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'

const SECRET = 'relay-secret-0123456789abcdef'
const SID = '0f9b2c4d-1111-2222-3333-444455556666'
const JOB = `yaac-demo-${SID}`

/** The proxy auth Secret, as the proxy's first deploy creates it. */
function seedSecret(): void {
  fakeCluster.seed({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'yaac-proxy-auth', namespace: 'test-ns' },
    data: { secret: Buffer.from(SECRET).toString('base64') },
  })
}

interface Received {
  auth: { token?: string; workspaceId?: string }
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
  execMock.mockReset()
  spawnMock.mockReset()
  vi.stubEnv('YAAC_K8S_NAMESPACE', 'test-ns')
  seedSecret()
})

afterEach(() => {
  relay?.close()
  relay = null
  relayHost = undefined
  vi.unstubAllEnvs()
})

async function withRelay(serve: (r: Received) => void): Promise<void> {
  relay = await startFakeRelay(serve)
  relayHost = `127.0.0.1:${relay.port}`
}

const okThen = (r: Received, body?: Buffer): void => {
  r.socket.write('{"ok":true}\n')
  if (body) r.socket.write(body)
}

describe('readProxyAuthSecret', () => {
  it('decodes the Secret, and answers null before the proxy\'s first deploy creates it', async () => {
    await expect(readProxyAuthSecret()).resolves.toBe(SECRET)
    fakeCluster.reset()
    await expect(readProxyAuthSecret()).resolves.toBeNull()
  })
})

describe('podStreamToken', () => {
  it('derives a stable HMAC of the proxy secret and session id', async () => {
    const a = await podStreamToken(SID)
    const b = await podStreamToken(SID)
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
    // Sends both the token and the workspace id (see relayDial).
    expect(r.auth).toEqual({ token: SECRET, workspaceId: SID })
    expect(r.handshake).toEqual({
      token: await podStreamToken(SID),
      kind: 'ctrl',
      cmd: ['tmux'],
    })
    // Bytes after the reply line are not lost.
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
    relayHost = '127.0.0.1:1' // nothing listens on port 1
    await expect(relayDial(SID, { kind: 'tcp', port: 80 }, { timeoutMs: 2_000 }))
      .rejects.toBeInstanceOf(RelayDialError)
  })

  it('dials the proxy Service', async () => {
    // The server pod shares the proxy's namespace, so it dials the Service.
    relayHost = undefined
    await expect(relayDial(SID, { kind: 'tcp', port: 80 }, { timeoutMs: 2_000 }))
      .rejects.toThrow(/yaac-proxy\.test-ns\.svc\.cluster\.local|ENOTFOUND|EAI_AGAIN/)
    expect(spawnMock).not.toHaveBeenCalled()
  })
})

describe('podExec', () => {
  it('wraps the command in sh -c, and resolves stdout/stderr on exit 0', async () => {
    let handshake: Record<string, unknown> = {}
    await withRelay((r) => {
      handshake = r.handshake
      r.socket.end('{"ok":true}\n' + JSON.stringify({ exitCode: 0, stdout: 'hi', stderr: '' }) + '\n')
    })
    const result = await podExec(JOB, 'echo hi')
    expect(result).toEqual({ stdout: 'hi', stderr: '' })
    expect(handshake.kind).toBe('exec')
    expect(handshake.cmd).toEqual(['sh', '-c', 'echo hi'])
  })

  it('throws WorkspaceExecError (code + stderr) on a nonzero exit, without retrying', async () => {
    let dials = 0
    await withRelay((r) => {
      dials++
      r.socket.end('{"ok":true}\n' + JSON.stringify({ exitCode: 1, stdout: '', stderr: 'no such session' }) + '\n')
    })
    const err = await podExec(JOB, 'tmux has-session -t yaac').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkspaceExecError)
    expect((err as WorkspaceExecError).code).toBe(1)
    expect((err as WorkspaceExecError).stderr).toBe('no such session')
    expect(dials).toBe(1)
  })

  it('retries dial failures up to maxAttempts', async () => {
    let dials = 0
    await withRelay((r) => {
      dials++
      r.socket.destroy()
    })
    await expect(podExec(JOB, 'true', { maxAttempts: 3, timeout: 2_000 }))
      .rejects.toBeInstanceOf(RelayDialError)
    expect(dials).toBe(3)
  })

  it("floors a caller's budget so a tight probe can't time out a live relay", async () => {
    // The stale reaper asks for 2s (runtime/status/liveness.ts); a slower
    // reply must still count rather than fail the transport.
    await withRelay((r) => {
      setTimeout(() => r.socket.end(
        '{"ok":true}\n' + JSON.stringify({ exitCode: 0, stdout: 'late', stderr: '' }) + '\n',
      ), 600)
    })
    const result = await podExec(JOB, 'true', { timeout: 200, maxAttempts: 1 })
    expect(result.stdout).toBe('late')
  })

  // The stale reaper treats a WorkspaceExecError as `dead` and tears the
  // workspace down, so only a command that actually ran and exited may
  // produce one.
  it('reports a signal-killed command as transport, not a nonzero exit', async () => {
    // A probe killed by the OOM killer must not look like a missing session.
    await withRelay((r) => {
      r.socket.end('{"ok":true}\n'
        + JSON.stringify({ exitCode: 1, stdout: '', stderr: '', signal: 'SIGKILL' }) + '\n')
    })
    const err = await podExec(JOB, 'tmux has-session -t yaac', { maxAttempts: 1 })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RelayDialError)
    expect(err).not.toBeInstanceOf(WorkspaceExecError)
    expect((err as RelayDialError).afterDispatch).toBe(true)
  })

  it('reports a spawn failure as transport, not the 127 it carries', async () => {
    // A real command-not-found also exits 127, so streamd marks spawn
    // failures separately.
    await withRelay((r) => {
      r.socket.end('{"ok":true}\n'
        + JSON.stringify({ exitCode: 127, spawnFailed: true, stdout: '', stderr: 'ENOMEM' }) + '\n')
    })
    const err = await podExec(JOB, 'tmux has-session -t yaac', { maxAttempts: 1 })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RelayDialError)
    expect(err).not.toBeInstanceOf(WorkspaceExecError)
  })

  it('reports a result with no exit code as transport, not exit 1', async () => {
    await withRelay((r) => {
      r.socket.end('{"ok":true}\n' + JSON.stringify({ stdout: '', stderr: '' }) + '\n')
    })
    const err = await podExec(JOB, 'tmux has-session -t yaac', { maxAttempts: 1 })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RelayDialError)
    expect(err).not.toBeInstanceOf(WorkspaceExecError)
  })

  it('still reports a real command-not-found as a nonzero exit', async () => {
    await withRelay((r) => {
      r.socket.end('{"ok":true}\n'
        + JSON.stringify({ exitCode: 127, stdout: '', stderr: 'codex: not found' }) + '\n')
    })
    const err = await podExec(JOB, 'codex --version', { maxAttempts: 1 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkspaceExecError)
    expect((err as WorkspaceExecError).code).toBe(127)
  })

  it('does not retry a transport failure past dispatch — the command may have run', async () => {
    // streamd already accepted the command, so a retry would run it twice
    // (e.g. a duplicate `new-window`).
    let dials = 0
    await withRelay((r) => {
      dials++
      r.socket.write('{"ok":true}\n')
      setTimeout(() => r.socket.destroy(), 10)
    })
    const err = await podExec(JOB, 'tmux new-window', { maxAttempts: 3, timeout: 2_000 })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RelayDialError)
    expect((err as RelayDialError).afterDispatch).toBe(true)
    expect(dials).toBe(1)
  })
})

describe('dialCtrlStream', () => {
  it('buffers pre-dial writes, delivers data, and emits exit on close', async () => {
    await withRelay((r) => {
      okThen(r)
      // Echo everything, including writes buffered before the dial.
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
    relayHost = '127.0.0.1:1'
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
      // One TCP write with three data frames and the exit: the data arrives
      // as one callback, before the exit.
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
    relayHost = '127.0.0.1:1'
    const pty = dialPtyStream(SID, ['sh'], {})
    const code = await new Promise<number>((resolve) => pty.onExit(({ exitCode }) => resolve(exitCode)))
    expect(code).toBe(1)
  })
})

describe('waitForStreamd', () => {
  // Fake timers advance Date.now() through the injected sleep.
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
    const exec = vi.fn().mockRejectedValue(new WorkspaceExecError('exit 1', 1, '', 'boom'))
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

  it('still heals when the budget expires before the halfway mark is observed', async () => {
    // On a short budget (the claim path's 10s) one probe can span both the
    // halfway mark and the deadline; streamd must still be restarted.
    const deps = makeDeps(vi.fn().mockImplementation(() => {
      vi.advanceTimersByTime(9_000) // one slow cycle: past halfway AND past the deadline
      return Promise.reject(new RelayDialError('no route'))
    }))
    await expect(waitForStreamd(JOB, { timeoutMs: 5_000 }, deps)).rejects.toThrow(/not reachable/)
    expect(deps.boot).toHaveBeenCalledTimes(1)
  })

  it('caps the heal at the remaining budget so a short deadline cannot overrun', async () => {
    const deps = makeDeps(vi.fn().mockRejectedValue(new RelayDialError('no route')))
    await expect(waitForStreamd(JOB, { timeoutMs: 10_000 }, deps)).rejects.toThrow(/not reachable/)
    const [, bootOpts] = deps.boot.mock.calls[0] as [string, { timeout: number }]
    expect(bootOpts.timeout).toBeLessThanOrEqual(10_000)
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
