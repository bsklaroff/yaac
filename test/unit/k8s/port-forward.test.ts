import { EventEmitter } from 'node:events'
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface FakeChild extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
  exitCode: number | null
}

const spawned: Array<{ file: string; args: string[]; child: FakeChild }> = []

vi.mock('node:child_process', () => ({
  spawn: (file: string, args: string[]) => {
    const child = new EventEmitter() as FakeChild
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.exitCode = null
    child.kill = vi.fn(() => {
      child.exitCode = 137
    })
    spawned.push({ file, args, child })
    return child
  },
}))

vi.mock('@/daemon/log', () => ({
  daemonLog: vi.fn(),
}))

vi.mock('@/lib/k8s/kubectl', () => ({
  k8sNamespace: vi.fn(() => 'test-ns'),
}))

import { ServicePortForward } from '@/lib/k8s/port-forward'

function emitForwarding(child: FakeChild, port: number): void {
  child.stdout.emit('data', Buffer.from(`Forwarding from 127.0.0.1:${port} -> 10255\n`))
}

beforeEach(() => {
  spawned.length = 0
})

describe('ServicePortForward', () => {
  it('spawns kubectl port-forward against the service and resolves the local port', async () => {
    const fwd = new ServicePortForward('yaac-proxy', 10255)
    const ensure = fwd.ensure()
    expect(spawned).toHaveLength(1)
    expect(spawned[0].file).toBe('kubectl')
    expect(spawned[0].args).toEqual([
      'port-forward', '-n', 'test-ns', 'svc/yaac-proxy', ':10255', '--address', '127.0.0.1',
    ])

    emitForwarding(spawned[0].child, 38217)
    await expect(ensure).resolves.toBe(38217)
    expect(fwd.currentPort).toBe(38217)
  })

  it('reuses a live tunnel instead of respawning', async () => {
    const fwd = new ServicePortForward('yaac-proxy', 10255)
    const first = fwd.ensure()
    emitForwarding(spawned[0].child, 40000)
    await first

    await expect(fwd.ensure()).resolves.toBe(40000)
    expect(spawned).toHaveLength(1)
  })

  it('coalesces concurrent ensure() calls onto one spawn', async () => {
    const fwd = new ServicePortForward('yaac-proxy', 10255)
    const a = fwd.ensure()
    const b = fwd.ensure()
    expect(spawned).toHaveLength(1)
    emitForwarding(spawned[0].child, 41000)
    await expect(Promise.all([a, b])).resolves.toEqual([41000, 41000])
  })

  it('rejects when the child exits before reporting a port', async () => {
    const fwd = new ServicePortForward('yaac-proxy', 10255)
    const ensure = fwd.ensure()
    spawned[0].child.stderr.emit('data', Buffer.from('error: service not found\n'))
    spawned[0].child.emit('exit', 1)
    await expect(ensure).rejects.toThrow(/exited with code 1[\s\S]*service not found/)
    expect(fwd.currentPort).toBeNull()
  })

  it('rejects when the spawn itself errors', async () => {
    const fwd = new ServicePortForward('yaac-proxy', 10255)
    const ensure = fwd.ensure()
    spawned[0].child.emit('error', new Error('kubectl not found'))
    await expect(ensure).rejects.toThrow('kubectl not found')
  })

  it('respawns on the next ensure() after the tunnel dies', async () => {
    const fwd = new ServicePortForward('yaac-proxy', 10255)
    const first = fwd.ensure()
    emitForwarding(spawned[0].child, 42000)
    await first

    // apiserver restart kills the tunnel out-of-band.
    spawned[0].child.exitCode = 1
    spawned[0].child.emit('exit', 1)
    expect(fwd.currentPort).toBeNull()

    const second = fwd.ensure()
    expect(spawned).toHaveLength(2)
    emitForwarding(spawned[1].child, 42001)
    await expect(second).resolves.toBe(42001)
  })

  it('stop() kills the child and clears the port', async () => {
    const fwd = new ServicePortForward('yaac-proxy', 10255)
    const ensure = fwd.ensure()
    emitForwarding(spawned[0].child, 43000)
    await ensure

    fwd.stop()
    expect(spawned[0].child.kill).toHaveBeenCalled()
    expect(fwd.currentPort).toBeNull()
  })
})
