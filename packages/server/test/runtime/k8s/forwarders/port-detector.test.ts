import net from 'node:net'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('#runtime/k8s/substrate/stream-relay', () => ({
  relayDial: vi.fn(),
}))

vi.mock('#runtime/k8s/forwarders/port-forwarders', () => ({
  getWorktreePorts: vi.fn().mockReturnValue([]),
}))

import { getWorktreePorts } from '#runtime/k8s/forwarders/port-forwarders'
import {
  PortDetectorManager,
  SENSITIVE_PORTS,
  _resetPortDetectorForTests,
  _setDetectedPortsForTests,
  dismissWorktreePort,
  getUnforwardedPorts,
  isForwardablePort,
} from '#runtime/k8s/forwarders/port-detector'
import { onWorktreeListChanged, _resetWorktreeListChangedForTests } from '#notify'
import type { PodInfo } from '#runtime/k8s/substrate/pods'

const mockGetSessionPorts = vi.mocked(getWorktreePorts)

function pod(worktreeId: string, over: Partial<PodInfo> = {}): PodInfo {
  return {
    jobName: `yaac-p-${worktreeId}`,
    podName: `yaac-p-${worktreeId}-abc`,
    worktreeId,
    projectSlug: 'p',
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 0,
    labels: {},
    ...over,
  }
}

/**
 * A tiny in-process stand-in for the relay `ports` stream: a loopback TCP
 * server the injected dialPorts connects to, with a handle to write lines
 * into the newest stream.
 */
async function startFakePortsServer(): Promise<{
  dial: () => Promise<net.Socket>
  write: (line: string) => void
  connections: () => number
  close: () => Promise<void>
}> {
  const serverSockets: net.Socket[] = []
  const server = net.createServer((socket) => {
    serverSockets.push(socket)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  return {
    dial: () => new Promise((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1')
      s.on('connect', () => resolve(s))
      s.on('error', reject)
    }),
    write: (line: string) => {
      serverSockets[serverSockets.length - 1]?.write(line + '\n')
    },
    connections: () => serverSockets.length,
    close: () => new Promise((resolve) => {
      for (const s of serverSockets) s.destroy()
      server.close(() => resolve())
    }),
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 25))

describe('isForwardablePort', () => {
  it('rejects sensitive ports, the infra range, and out-of-range values', () => {
    for (const p of SENSITIVE_PORTS) expect(isForwardablePort(p)).toBe(false)
    expect(isForwardablePort(10300)).toBe(false) // streamd
    expect(isForwardablePort(10260)).toBe(false) // relay
    expect(isForwardablePort(0)).toBe(false)
    expect(isForwardablePort(65536)).toBe(false)
    expect(isForwardablePort(3.5)).toBe(false)
    expect(isForwardablePort(8080)).toBe(true)
    expect(isForwardablePort(5173)).toBe(true)
  })
})

describe('getUnforwardedPorts', () => {
  beforeEach(() => {
    _resetPortDetectorForTests()
    mockGetSessionPorts.mockReturnValue([])
  })

  it('returns [] for an unknown session', () => {
    expect(getUnforwardedPorts('nope')).toEqual([])
  })

  it('subtracts already-forwarded container ports', () => {
    _setDetectedPortsForTests('s1', [3000, 8080])
    mockGetSessionPorts.mockReturnValue([{ containerPort: 3000, hostPort: 3000 }])
    expect(getUnforwardedPorts('s1')).toEqual([8080])
  })

  it('subtracts dismissed ports per session', () => {
    _setDetectedPortsForTests('s1', [3000, 8080])
    _setDetectedPortsForTests('s2', [3000])
    expect(dismissWorktreePort('s1', 3000)).toBe(true)
    expect(getUnforwardedPorts('s1')).toEqual([8080])
    expect(getUnforwardedPorts('s2')).toEqual([3000])
  })

  // A dismissal exists only in this module's memory, so it is the only
  // thing that can tell a client the popover row is gone.
  it('pushes a fresh snapshot when a dismissal lands, and not when it is refused', () => {
    _resetWorktreeListChangedForTests()
    let pushes = 0
    onWorktreeListChanged(() => { pushes += 1 })
    _setDetectedPortsForTests('s1', [3000])

    expect(dismissWorktreePort('s1', 8080)).toBe(false)
    expect(pushes).toBe(0)
    expect(dismissWorktreePort('s1', 3000)).toBe(true)
    expect(pushes).toBe(1)
    _resetWorktreeListChangedForTests()
  })

  it('refuses to dismiss a port that is not currently surfaced', () => {
    // Un-detected session, un-detected port, an already-forwarded port,
    // and a filtered (sensitive) port are all refused — otherwise the
    // dismissed set could be grown for sessions the sync never cleans up.
    expect(dismissWorktreePort('nope', 8080)).toBe(false)
    _setDetectedPortsForTests('s1', [3000, 9229])
    expect(dismissWorktreePort('s1', 8080)).toBe(false)
    expect(dismissWorktreePort('s1', 9229)).toBe(false)
    mockGetSessionPorts.mockReturnValue([{ containerPort: 3000, hostPort: 3000 }])
    expect(dismissWorktreePort('s1', 3000)).toBe(false)
  })

  it('hides sensitive and infra ports fail-closed', () => {
    _setDetectedPortsForTests('s1', [22, 5432, 8080, 9229, 10300, 10333])
    expect(getUnforwardedPorts('s1')).toEqual([8080])
  })

  it('caps the surfaced set', () => {
    _setDetectedPortsForTests('s1', Array.from({ length: 50 }, (_, i) => 8000 + i))
    expect(getUnforwardedPorts('s1')).toHaveLength(10)
    expect(getUnforwardedPorts('s1')[0]).toBe(8000)
  })
})

describe('PortDetectorManager', () => {
  let fake: Awaited<ReturnType<typeof startFakePortsServer>>
  let manager: PortDetectorManager | null = null

  beforeEach(async () => {
    _resetPortDetectorForTests()
    mockGetSessionPorts.mockReturnValue([])
    fake = await startFakePortsServer()
  })

  afterEach(async () => {
    manager?.stopAll()
    manager = null
    await fake.close()
  })

  function makeManager(onChange: () => void): PortDetectorManager {
    manager = new PortDetectorManager(onChange, {
      dialPorts: () => fake.dial(),
      respawnDelayMs: 10,
      maxRespawnDelayMs: 50,
      silenceTimeoutMs: 60_000,
      log: () => {},
    })
    return manager
  }

  it('feeds pushed sets into the detector map and fires onChange on change only', async () => {
    const onChange = vi.fn()
    const m = makeManager(onChange)
    m.sync([pod('s1')])
    await flush()
    expect(fake.connections()).toBe(1)

    fake.write(JSON.stringify({ ports: [8080, 3000] }))
    await flush()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(getUnforwardedPorts('s1')).toEqual([3000, 8080])

    // Unchanged push (a keepalive) → no extra onChange.
    fake.write(JSON.stringify({ ports: [3000, 8080] }))
    await flush()
    expect(onChange).toHaveBeenCalledTimes(1)

    // Changed set → onChange again.
    fake.write(JSON.stringify({ ports: [3000] }))
    await flush()
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(getUnforwardedPorts('s1')).toEqual([3000])
  })

  it('re-validates pushed payloads (non-ints and out-of-range dropped, bounded)', async () => {
    const m = makeManager(() => {})
    m.sync([pod('s1')])
    await flush()
    fake.write(JSON.stringify({ ports: [8080, 'evil', -5, 0, 65536, 3.5, 8080] }))
    await flush()
    expect(getUnforwardedPorts('s1')).toEqual([8080])
  })

  it('ignores prewarmed and non-running pods, and clears state when a pod goes away', async () => {
    const onChange = vi.fn()
    const m = makeManager(onChange)
    m.sync([
      pod('s1'),
      pod('s2', { labels: { 'yaac.prewarmed': 'true' } }),
      pod('s3', { running: false }),
    ])
    await flush()
    expect(m.size).toBe(1)

    fake.write(JSON.stringify({ ports: [8080] }))
    await flush()
    expect(getUnforwardedPorts('s1')).toEqual([8080])

    m.sync([])
    expect(m.size).toBe(0)
    expect(getUnforwardedPorts('s1')).toEqual([])
    // The clear itself pushed a change.
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('redials after a stream death and keeps the last set in the meantime', async () => {
    const m = makeManager(() => {})
    m.sync([pod('s1')])
    await flush()
    fake.write(JSON.stringify({ ports: [8080] }))
    await flush()

    // Kill the stream; detection stays sticky and the watcher redials.
    await fake.close()
    fake = await startFakePortsServer()
    expect(getUnforwardedPorts('s1')).toEqual([8080])
    await new Promise((r) => setTimeout(r, 100))
    expect(fake.connections()).toBeGreaterThanOrEqual(1)

    fake.write(JSON.stringify({ ports: [9000] }))
    await flush()
    expect(getUnforwardedPorts('s1')).toEqual([9000])
  })
})
