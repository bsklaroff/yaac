import { EventEmitter } from 'node:events'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

interface FakeChild extends EventEmitter {
  stdout: EventEmitter & { unref: ReturnType<typeof vi.fn> }
  stderr: EventEmitter & { unref: ReturnType<typeof vi.fn> }
  unref: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
}

const spawned: Array<{ file: string; args: string[]; child: FakeChild }> = []
/** What the next spawned child does. */
let behavior: 'ready' | 'exit' | 'silent' = 'ready'
let nextPort = 40000
/**
 * Whether `kill()` emits `exit` synchronously. A real SIGTERM does not,
 * and the race test turns this off to reproduce that.
 */
let killEmitsExit = true

// Mock the kubectl child process; everything else runs for real.
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
} from '#drivers/k8s/substrate/port-forward'

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
    // One child per key, on an ephemeral local port.
    expect(spawned).toHaveLength(1)
    expect(spawned[0].file).toBe('kubectl')
    expect(spawned[0].args).toEqual([
      'port-forward', '-n', 'yaac', 'deploy/yaac-registry', '0:8443',
    ])
    // Unref'd so the process can still exit.
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
    // Nothing cached: the next attempt spawns a fresh child.
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

    // Node's `exit` event does not fire on a signal, so without a signal
    // handler kubectl would be orphaned. The extra listener stands in for
    // an app with its own SIGTERM handling; with it present the code must
    // not re-raise, which would also kill this test's worker.
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
    // A dead child's port is no longer returned.
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
    // The old child's `exit` arrives after a successor is already cached.
    killEmitsExit = false
    await resolvePortForward('a', SPEC)
    const dead = spawned[0].child
    invalidatePortForward('a')
    const successor = await resolvePortForward('a', SPEC)
    expect(spawned).toHaveLength(2)

    dead.emit('exit', null)

    // The successor stays cached and tracked, so no third child spawns.
    await expect(resolvePortForward('a', SPEC)).resolves.toEqual(successor)
    expect(spawned).toHaveLength(2)
    invalidatePortForward('a')
    expect(spawned[1].child.kill).toHaveBeenCalled()
  })
})
