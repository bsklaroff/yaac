// The client side of the stream relay, against an in-process fake speaking
// the wire protocol (relay auth line, streamd handshake line, {ok} reply,
// payload). The real relay (k8s/mountd/cmd/relay) and streamd have their
// own tests (docs/stream-relay.md).
import net from 'node:net'
import crypto from 'node:crypto'
import type * as childProcess from 'node:child_process'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type * as netModule from 'node:net'

// The socket is a real listener. The proxy auth Secret, the workspace's pod
// and each node's netd pod are read from the fake cluster, and the kubectl
// exec boot is a mocked child process.
type ExecResult = { stdout: string; stderr: string }
type ExecCallback = (err: unknown, res?: ExecResult) => void
const execMock = vi.fn<(command: string) => Promise<ExecResult>>()
const spawnMock = vi.fn<(file: string, args: readonly string[]) => unknown>()
/** Where nothing listens, so a dial is refused at once. */
const NO_RELAY = '127.0.0.1:1'
/** netd's stream port, which every relay dial targets. */
const NETD_STREAM_PORT = 10262
/** Where a dial to a netd pod lands: the fake relay's `host:port`. A pod
 *  address is never dialed, since none exists outside a cluster. */
let relayHost = NO_RELAY
/** The address the last relay dial asked for. */
let dialed: string | undefined
vi.mock('node:net', async (importOriginal) => {
  const real = await importOriginal<typeof netModule>()
  const connect = (port: number, host: string): netModule.Socket => {
    if (port !== NETD_STREAM_PORT) return real.connect(port, host)
    dialed = `${host}:${String(port)}`
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
  podClaim,
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
import { installId } from '#drivers/k8s/substrate'

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

/** The workspace's pod, on `node` (none for a pod not yet scheduled). */
function seedWorkspacePod(node: string | undefined): void {
  fakeCluster.seed({
    apiVersion: 'v1', kind: 'Pod',
    metadata: {
      name: `${JOB}-x`, namespace: 'test-ns', creationTimestamp: '2026-01-01T00:00:00Z',
      labels: {
        'batch.kubernetes.io/job-name': JOB, 'yaac.workspace-id': SID, 'yaac.project-id': 'demo',
        'yaac.install-id': installId(),
      },
    },
    spec: node !== undefined ? { nodeName: node } : {},
    status: { phase: 'Running' },
  })
}

/** netd on two nodes, as the DaemonSet runs it. */
function seedNetd(): void {
  for (const [node, ip] of [['n1', '10.244.1.7'], ['n2', '10.244.2.8']]) {
    fakeCluster.seed({
      apiVersion: 'v1', kind: 'Pod',
      metadata: { name: `yaac-netd-${node}`, namespace: 'test-ns', labels: { app: 'yaac-netd' } },
      spec: { nodeName: node },
      status: { phase: 'Running', podIP: ip },
    })
  }
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
  seedNetd()
  seedWorkspacePod('n2')
  dialed = undefined
})

afterEach(() => {
  relay?.close()
  relay = null
  relayHost = NO_RELAY
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
    relayHost = NO_RELAY
    await expect(relayDial(SID, { kind: 'tcp', port: 80 }, { timeoutMs: 2_000 }))
      .rejects.toBeInstanceOf(RelayDialError)
  })

  it('dials netd on the node the workspace\'s pod runs on, and fails as transport where there is none', async () => {
    await withRelay((r) => r.socket.destroy())
    await expect(relayDial(SID, { kind: 'tcp', port: 80 })).rejects.toBeInstanceOf(RelayDialError)
    expect(dialed).toBe(`10.244.2.8:${String(NETD_STREAM_PORT)}`)
    expect(spawnMock).not.toHaveBeenCalled()

    // A pod the scheduler has not placed, and a node with no running netd:
    // nothing to dial, so the caller reads it as `unknown`.
    for (const [node, why] of [[undefined, /on no node yet/], ['n3', /no running netd on node n3/]] as const) {
      dialed = undefined
      seedWorkspacePod(node)
      const err = await relayDial(SID, { kind: 'tcp', port: 80 }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(RelayDialError)
      expect(String(err)).toMatch(why)
      expect(dialed).toBeUndefined()
    }
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

  it('sends stdin after the handshake that names its byte length', async () => {
    // Multibyte and far past the handshake line's cap, as a long prompt's
    // delivery script is.
    const input = 'Pläase ✓ the 🙂 brief\n'.repeat(30_000)
    await withRelay((r) => {
      const want = r.handshake.stdin as number
      let got = r.leftover
      r.socket.write('{"ok":true}\n')
      r.socket.on('data', (c: Buffer) => {
        got = Buffer.concat([got, c])
        if (got.length < want) return
        r.socket.end(JSON.stringify({ exitCode: 0, stdout: got.toString('utf8'), stderr: '' }) + '\n')
      })
    })
    const { stdout } = await podExec(JOB, 'cat', { stdin: input })
    expect(stdout === input).toBe(true)
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

  // A cut output must not read as the whole of it.
  it('refuses an output streamd cut at its cap, as transport', async () => {
    await withRelay((r) => {
      r.socket.end('{"ok":true}\n'
        + JSON.stringify({ exitCode: 0, stdout: 'partial', stderr: '', truncated: true }) + '\n')
    })
    const err = await podExec(JOB, 'git ls-files', { maxAttempts: 1 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RelayDialError)
    expect((err as RelayDialError).afterDispatch).toBe(true)
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

  it('hangs up on an abort, which streamd reads as the caller leaving, without retrying', async () => {
    let dials = 0
    let running!: () => void
    const dispatched = new Promise<void>((r) => { running = r })
    let hungUp!: () => void
    const closed = new Promise<void>((r) => { hungUp = r })
    await withRelay((r) => {
      dials++
      r.socket.on('end', hungUp)
      r.socket.write('{"ok":true}\n', running)
    })
    const abort = new AbortController()
    const run = podExec(JOB, 'sleep 60', { maxAttempts: 3, signal: abort.signal }).catch((e: unknown) => e)
    await dispatched
    abort.abort()
    expect(await run).toMatchObject({ name: 'AbortError' })
    await closed
    expect(dials).toBe(1)
  })
})

/** A streamd that answers a claim's handshake, reads its request whole and
 *  replies `reply` once it has it, recording the request. */
function claimServer(reply: string, requests: unknown[]): (r: Received) => void {
  return (r) => {
    r.socket.write('{"ok":true}\n')
    const want = r.handshake.bytes as number
    let got = r.leftover
    const take = (): void => {
      if (got.length < want) return
      requests.push(JSON.parse(got.subarray(0, want).toString('utf8')))
      r.socket.end(reply)
    }
    r.socket.on('data', (c: Buffer) => { got = Buffer.concat([got, c]); take() })
    take()
  }
}

describe('podClaim', () => {
  it('sends the request after a claim handshake naming its byte length, and resolves on streamd\'s ok', async () => {
    const requests: unknown[] = []
    let handshake: Record<string, unknown> = {}
    const serve = claimServer('{"ok":true}\n', requests)
    await withRelay((r) => { handshake = r.handshake; serve(r) })
    const request = { cwd: '/workspace', env: { NAME: 'Zoë ✓' } }
    await podClaim(JOB, request, { timeoutMs: 10_000 })
    expect(handshake).toMatchObject({ kind: 'claim', bytes: Buffer.byteLength(JSON.stringify(request)) })
    expect(requests).toEqual([request])
  })

  it('retries only the dial, three times at most, backing off between them', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      let dials = 0
      const requests: unknown[] = []
      const serve = claimServer('{"ok":true}\n', requests)
      await withRelay((r) => {
        dials++
        if (dials < 3) r.socket.destroy()
        else serve(r)
      })
      const claim = podClaim(JOB, {}, { timeoutMs: 10_000 })
      await vi.waitFor(() => { expect(dials).toBe(1) })
      await vi.advanceTimersByTimeAsync(250)
      await vi.waitFor(() => { expect(dials).toBe(2) })
      await vi.advanceTimersByTimeAsync(500)
      await claim
      expect(dials).toBe(3)
      expect(requests).toEqual([{}])

      // Past the third failed dial it gives up with the dial's error.
      dials = -10
      const failing = podClaim(JOB, {}, { timeoutMs: 10_000 }).catch((e: unknown) => e)
      await vi.waitFor(() => { expect(dials).toBe(-9) })
      await vi.advanceTimersByTimeAsync(250)
      await vi.waitFor(() => { expect(dials).toBe(-8) })
      await vi.advanceTimersByTimeAsync(500)
      expect(await failing).toBeInstanceOf(RelayDialError)
      expect(dials).toBe(-7)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects with WorkspaceExecError carrying streamd\'s reason when the claim fails, and with RelayDialError on a reply it cannot read', async () => {
    await withRelay(claimServer('{"ok":false,"error":"tmux exited 1: no server"}\n', []))
    const err = await podClaim(JOB, {}, { timeoutMs: 10_000 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkspaceExecError)
    expect((err as WorkspaceExecError).message).toBe(`claiming ${JOB} failed: tmux exited 1: no server`)
    expect((err as WorkspaceExecError).stderr).toBe('tmux exited 1: no server')
    relay?.close()

    await withRelay(claimServer('not json', []))
    await expect(podClaim(JOB, {}, { timeoutMs: 10_000 })).rejects.toThrow(new RelayDialError(`malformed claim result from ${JOB}`, true))
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
    relayHost = NO_RELAY
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
    relayHost = NO_RELAY
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
      + "sh -c 'setsid /opt/yaac/helpers/daemons/streamd >>/tmp/streamd.log 2>&1 </dev/null &'",
    )
  })

  it('propagates the exec failure so the caller can fall back', async () => {
    execMock.mockRejectedValue(Object.assign(new Error('kubectl failed'), { stderr: 'not found' }))
    await expect(bootStreamd(JOB)).rejects.toThrow('kubectl failed')
    expect(execMock).toHaveBeenCalledTimes(1)
  })
})
