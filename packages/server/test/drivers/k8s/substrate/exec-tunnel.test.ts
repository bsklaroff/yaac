import net from 'node:net'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

interface FakeChild extends EventEmitter {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
}

const spawned: Array<{ file: string; args: string[]; child: FakeChild }> = []

vi.mock('node:child_process', () => ({
  // The tunnel reaches #lib/port for startPortForwarders and the
  // kubectl module for the namespace; both promisify a runner at module
  // eval. Nothing here calls either — only spawn matters.
  execFile: vi.fn(),
  exec: vi.fn(),
  spawn: (file: string, args: string[]) => {
    const child = new EventEmitter() as FakeChild
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    // Echo relay: everything written to stdin comes back on stdout, as if
    // the in-pod socat dialed a local echo server.
    child.stdin.on('data', (chunk: Buffer) => child.stdout.write(chunk))
    child.kill = vi.fn(() => {
      child.emit('close')
    })
    spawned.push({ file, args, child })
    return child
  },
}))

vi.mock('#log', () => ({
  serverLog: vi.fn(),
}))

import { ExecTunnel } from '#drivers/k8s/substrate'
import { serverLog } from '#log'

let tunnel: ExecTunnel | null = null

beforeEach(() => {
  vi.stubEnv('YAAC_K8S_NAMESPACE', 'test-ns')
  spawned.length = 0
})

afterEach(() => {
  tunnel?.stop()
  tunnel = null
  vi.unstubAllEnvs()
})

/** Open a client socket to the tunnel, send a payload, read the echo. */
function roundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(payload)
    })
    sock.once('data', (chunk) => {
      sock.destroy()
      resolve(chunk.toString())
    })
    sock.once('error', reject)
  })
}

describe('ExecTunnel', () => {
  it('binds a loopback listener and resolves its ephemeral port', async () => {
    tunnel = new ExecTunnel('yaac-proxy', 10255)
    const port = await tunnel.ensure()
    expect(port).toBeGreaterThan(0)
    expect(tunnel.currentPort).toBe(port)
    // Nothing spawned until a connection actually arrives.
    expect(spawned).toHaveLength(0)
  })

  it('reuses the live listener and coalesces concurrent ensure() calls', async () => {
    tunnel = new ExecTunnel('yaac-proxy', 10255)
    const [a, b] = await Promise.all([tunnel.ensure(), tunnel.ensure()])
    expect(a).toBe(b)
    await expect(tunnel.ensure()).resolves.toBe(a)
  })

  it('bridges a connection through kubectl exec + socat into the deployment', async () => {
    tunnel = new ExecTunnel('yaac-proxy', 10255)
    const port = await tunnel.ensure()

    const echoed = await roundTrip(port, 'GET /healthz\r\n')
    expect(echoed).toBe('GET /healthz\r\n')

    expect(spawned).toHaveLength(1)
    expect(spawned[0].file).toBe('kubectl')
    // exec (not port-forward: broken for gVisor pods — the netns has no
    // kernel-stack listener), -i for the stdin leg, deploy/ target so a
    // ready pod is resolved per connection.
    expect(spawned[0].args).toEqual([
      'exec', '-n', 'test-ns', '-i', 'deploy/yaac-proxy', '--',
      'socat', '-', 'TCP:127.0.0.1:10255',
    ])
  })

  it('spawns one relay per connection', async () => {
    tunnel = new ExecTunnel('yaac-proxy', 10255)
    const port = await tunnel.ensure()
    await roundTrip(port, 'a')
    await roundTrip(port, 'b')
    expect(spawned).toHaveLength(2)
  })

  it('stop() closes the listener, kills relays, and ensure() rebinds after', async () => {
    tunnel = new ExecTunnel('yaac-proxy', 10255)
    const port = await tunnel.ensure()

    // Hold a connection open so a relay is alive at stop() time.
    const sock = net.connect(port, '127.0.0.1')
    await new Promise((r) => sock.once('connect', r))
    await new Promise((r) => setTimeout(r, 20)) // let the server accept
    expect(spawned).toHaveLength(1)

    tunnel.stop()
    expect(tunnel.currentPort).toBeNull()
    expect(spawned[0].child.kill).toHaveBeenCalled()
    sock.destroy()

    const next = await tunnel.ensure()
    expect(next).toBeGreaterThan(0)
    expect(tunnel.currentPort).toBe(next)
  })

  it('stop() during an in-flight start() aborts it — no resurrected listener', async () => {
    // Server shutdown (disconnect) can race a background reconcile's
    // ensure(): the listen callback must not repopulate a stopped tunnel
    // and leak a listener that keeps the process alive.
    tunnel = new ExecTunnel('yaac-proxy', 10255)
    const pending = tunnel.ensure()
    tunnel.stop()
    await expect(pending).rejects.toThrow(/stopped during start/)
    expect(tunnel.currentPort).toBeNull()

    // A later ensure() starts cleanly (stop is not terminal).
    const port = await tunnel.ensure()
    expect(port).toBeGreaterThan(0)
  })

  it('logs relay stderr when the exec child fails', async () => {
    tunnel = new ExecTunnel('yaac-proxy', 10255)
    const port = await tunnel.ensure()
    const sock = net.connect(port, '127.0.0.1')
    await new Promise((r) => sock.once('connect', r))
    await new Promise((r) => setTimeout(r, 20))
    expect(spawned).toHaveLength(1)

    // e.g. an RBAC denial: kubectl writes the reason to stderr and exits
    // non-zero — the tunnel must surface it, not swallow it.
    const { child } = spawned[0]
    child.stderr.write('error: unable to upgrade connection: Forbidden')
    await new Promise((r) => setImmediate(r))
    child.emit('close', 1)
    expect(vi.mocked(serverLog)).toHaveBeenCalledWith(
      expect.stringContaining('Forbidden'),
    )
    sock.destroy()
  })
})
