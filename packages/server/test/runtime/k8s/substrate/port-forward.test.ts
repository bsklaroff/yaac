import { EventEmitter } from 'node:events'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

interface FakeChild extends EventEmitter {
  stdout: EventEmitter & { unref: ReturnType<typeof vi.fn> }
  stderr: EventEmitter & { unref: ReturnType<typeof vi.fn> }
  unref: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
}

const spawned: Array<{ file: string; args: string[]; child: FakeChild }> = []
/** What the next spawned child does: announce a port, die, or stay silent. */
let behavior: 'ready' | 'exit' | 'silent' = 'ready'
let nextPort = 40000
/**
 * Whether `kill()` emits `exit` synchronously. A real SIGTERM does NOT —
 * the event lands a tick or more later, which is the window the
 * invalidate → re-resolve race lives in, so the race test flips this off.
 */
let killEmitsExit = true

// kubectl is the process boundary; everything below it runs for real.
vi.mock('node:child_process', () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
  spawn: (file: string, args: string[]) => {
    const child = new EventEmitter() as FakeChild
    child.stdout = Object.assign(new EventEmitter(), { unref: vi.fn() })
    child.stderr = Object.assign(new EventEmitter(), { unref: vi.fn() })
    child.unref = vi.fn()
    child.kill = vi.fn(() => { if (killEmitsExit) child.emit('exit', null) })
    spawned.push({ file, args, child })
    const port = nextPort++
    if (behavior === 'ready') {
      process.nextTick(() => child.stdout.emit('data', Buffer.from(
        `Forwarding from 127.0.0.1:${port} -> 8443\n`,
      )))
    } else if (behavior === 'exit') {
      process.nextTick(() => child.emit('exit', 1))
    }
    return child
  },
}))

import {
  _resetPortForwardsForTests,
  invalidatePortForward,
  resolvePortForward,
} from '#runtime/k8s/substrate/port-forward'

const SPEC = { namespace: 'yaac', target: 'deploy/yaac-registry', remotePort: 8443 }

beforeEach(() => {
  spawned.length = 0
  behavior = 'ready'
  nextPort = 40000
  killEmitsExit = true
  _resetPortForwardsForTests()
})

afterEach(() => {
  _resetPortForwardsForTests()
})

describe('resolvePortForward', () => {
  it('spawns one kubectl child per key and caches its local address', async () => {
    const first = await resolvePortForward('a', SPEC)
    const second = await resolvePortForward('a', SPEC)

    expect(first).toEqual({ host: '127.0.0.1', port: 40000 })
    expect(second).toEqual(first)
    // One long-lived child serves every caller of the key — the whole point
    // of keying them — and the local port is always ephemeral, so two
    // installs on one machine never collide.
    expect(spawned).toHaveLength(1)
    expect(spawned[0].file).toBe('kubectl')
    expect(spawned[0].args).toEqual([
      'port-forward', '-n', 'yaac', 'deploy/yaac-registry', '0:8443',
    ])
    // Unref'd, child and pipes: a CLI run or a vitest global setup that
    // touched a forward must still be able to exit.
    expect(spawned[0].child.unref).toHaveBeenCalled()
    expect(spawned[0].child.stdout.unref).toHaveBeenCalled()
    expect(spawned[0].child.stderr.unref).toHaveBeenCalled()
  })

  it('keeps distinct keys on distinct children', async () => {
    const a = await resolvePortForward('a', SPEC)
    const b = await resolvePortForward('b', { ...SPEC, target: 'deploy/yaac-proxy' })
    expect(a.port).not.toBe(b.port)
    expect(spawned.map((s) => s.args[3])).toEqual(['deploy/yaac-registry', 'deploy/yaac-proxy'])
  })

  it('single-flights concurrent resolves so two children never race into existence', async () => {
    const [a, b] = await Promise.all([
      resolvePortForward('a', SPEC),
      resolvePortForward('a', SPEC),
    ])
    expect(a).toEqual(b)
    expect(spawned).toHaveLength(1)
  })

  it('rejects and caches nothing when the child dies during startup', async () => {
    behavior = 'exit'
    await expect(resolvePortForward('a', SPEC)).rejects.toThrow(/exited during startup/)
    // Nothing memoized: the next attempt gets a fresh child rather than an
    // address that was never valid.
    behavior = 'ready'
    await expect(resolvePortForward('a', SPEC)).resolves.toEqual({ host: '127.0.0.1', port: 40001 })
  })

  it('rejects when the child never reports a listener', async () => {
    behavior = 'silent'
    await expect(resolvePortForward('a', { ...SPEC, readyTimeoutMs: 20 }))
      .rejects.toThrow(/did not become ready/)
    expect(spawned[0].child.kill).toHaveBeenCalled()
  })

  it('kills every forward when the process is signalled, not just on clean exit', async () => {
    await resolvePortForward('registry', SPEC)
    await resolvePortForward('relay', { ...SPEC, target: 'deploy/yaac-proxy' })

    // `exit` fires on no signal, so without this a signalled process
    // reparents its kubectl to PID 1 — where it has no timeout and squats
    // an ephemeral port until something dials it. A vitest worker is the
    // measured case: vitest installs a SIGTERM handler in fork workers only
    // under profiling flags, so a normal run leaks one per worker.
    //
    // The co-listener stands in for an app that handles SIGTERM itself (the
    // server's graceful shutdown). It also keeps this assertion safe: with
    // a second handler registered the code under test must NOT re-raise,
    // which would terminate the worker running this test.
    const coListener = (): void => {}
    process.on('SIGTERM', coListener)
    try {
      process.emit('SIGTERM')
    } finally {
      process.off('SIGTERM', coListener)
    }

    expect(spawned.map((s) => s.child.kill.mock.calls.length)).toEqual([1, 1])
  })

  it('re-resolves after the child exits under it', async () => {
    await resolvePortForward('a', SPEC)
    spawned[0].child.emit('exit', 0)
    // A forward whose child died must not keep answering with its old port
    // for the rest of the server run.
    await expect(resolvePortForward('a', SPEC)).resolves.toEqual({ host: '127.0.0.1', port: 40001 })
    expect(spawned).toHaveLength(2)
  })
})

describe('invalidatePortForward', () => {
  it('kills the child and forces the next resolve to respawn', async () => {
    await resolvePortForward('a', SPEC)
    invalidatePortForward('a')
    expect(spawned[0].child.kill).toHaveBeenCalled()

    await expect(resolvePortForward('a', SPEC)).resolves.toEqual({ host: '127.0.0.1', port: 40001 })
    expect(spawned).toHaveLength(2)
  })

  it('leaves other keys alone', async () => {
    const a = await resolvePortForward('a', SPEC)
    const b = await resolvePortForward('b', SPEC)
    invalidatePortForward('a')
    await expect(resolvePortForward('b', SPEC)).resolves.toEqual(b)
    expect(a).not.toEqual(b)
    expect(spawned).toHaveLength(2)
  })

  it('is a no-op for a key that has no forward', () => {
    expect(() => { invalidatePortForward('never-used') }).not.toThrow()
  })

  it('a killed child\'s late exit cannot strand its live successor', async () => {
    // A real SIGTERM's `exit` lands after the kill returns, so an
    // invalidate followed immediately by a re-resolve (restartMainRegistry,
    // and the reachability heal path) has a live successor cached by the
    // time the dead child's event fires.
    killEmitsExit = false
    await resolvePortForward('a', SPEC)
    const dead = spawned[0].child
    invalidatePortForward('a')
    const successor = await resolvePortForward('a', SPEC)
    expect(spawned).toHaveLength(2)

    dead.emit('exit', null)

    // The successor must still be the cached address AND still be the
    // child the maps hold: wiping it here would spawn a third forward and
    // leave the successor unkillable by invalidate or the exit hook.
    await expect(resolvePortForward('a', SPEC)).resolves.toEqual(successor)
    expect(spawned).toHaveLength(2)
    invalidatePortForward('a')
    expect(spawned[1].child.kill).toHaveBeenCalled()
  })
})
