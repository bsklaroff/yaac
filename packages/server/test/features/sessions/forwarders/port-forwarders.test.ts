import { EventEmitter } from 'node:events'
import type net from 'node:net'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('#platform/k8s/stream-relay', () => ({
  sessionExec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  relayTcpFactory: vi.fn(),
}))

vi.mock('#platform/container/port', () => ({
  reserveAvailablePort: vi.fn(),
  startPortForwarders: vi.fn(),
}))

import { relayTcpFactory, sessionExec } from '#platform/k8s/stream-relay'
import { reserveAvailablePort, startPortForwarders } from '#platform/container/port'
import type { ReservedPort } from '#platform/container/port'
import {
  buildStatusRight,
  getSessionPorts,
  hasSessionForwarders,
  provisionSessionForwarders,
  registerSessionForwarders,
  setSessionStatusRight,
  stopAllSessionForwarders,
  stopSessionForwarders,
} from '#features/sessions/forwarders/port-forwarders'

const mockExec = vi.mocked(sessionExec)
const mockReserve = vi.mocked(reserveAvailablePort)
const mockStartForwarders = vi.mocked(startPortForwarders)
const mockRelayFactory = vi.mocked(relayTcpFactory)

function makeReservedPort(hostPort: number, containerPort: number): ReservedPort {
  const server = new EventEmitter() as unknown as net.Server
  return { containerPort, hostPort, server }
}

describe('buildStatusRight', () => {
  it('omits port info when no ports forwarded', () => {
    expect(buildStatusRight('myproj', 'abcdef0123456789', [])).toBe(' myproj abcdef01 ')
  })

  it('includes host->container mappings for each port', () => {
    const result = buildStatusRight('myproj', 'abcdef0123456789', [
      { hostPort: 3000, containerPort: 3000 },
      { hostPort: 5432, containerPort: 5432 },
    ])
    expect(result).toBe(' myproj abcdef01 :3000->3000 :5432->5432 ')
  })

  it('truncates the session id to 8 characters', () => {
    expect(buildStatusRight('p', 'xxxxxxxxyyyyyyyy', [])).toBe(' p xxxxxxxx ')
  })
})

describe('setSessionStatusRight', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('execs a tmux set-option command into the job with the rendered value', async () => {
    await setSessionStatusRight('yaac-proj-123', 'proj', 'abcdef0123456789', [
      { hostPort: 19001, containerPort: 3000 },
    ])
    expect(mockExec).toHaveBeenCalledTimes(1)
    const [jobName, cmd] = mockExec.mock.calls[0] ?? []
    expect(jobName).toBe('yaac-proj-123')
    expect(cmd).toContain('tmux -S /tmp/yaac-tmux/server set-option -t yaac status-right')
    expect(cmd).toContain(':19001->3000')
  })
})

describe('registry: register/stop/hasSessionForwarders', () => {
  afterEach(() => {
    // Clean up any registrations left by prior tests so they don't
    // bleed across it() calls.
    stopSessionForwarders('sess-reg-1')
    stopSessionForwarders('sess-reg-2')
  })

  it('registers a forwarder and reports it present', () => {
    expect(hasSessionForwarders('sess-reg-1')).toBe(false)
    registerSessionForwarders('sess-reg-1', vi.fn(), [])
    expect(hasSessionForwarders('sess-reg-1')).toBe(true)
  })

  it('ignores a second registration and runs the duplicate stop', () => {
    const first = vi.fn()
    const second = vi.fn()
    registerSessionForwarders('sess-reg-2', first, [{ containerPort: 3000, hostPort: 19000 }])
    registerSessionForwarders('sess-reg-2', second, [{ containerPort: 3000, hostPort: 19999 }])
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    // The first registration's ports stay authoritative.
    expect(getSessionPorts('sess-reg-2')).toEqual([{ containerPort: 3000, hostPort: 19000 }])
  })

  it('stopSessionForwarders invokes the stored stop and removes the entry', () => {
    const stop = vi.fn()
    registerSessionForwarders('sess-reg-1', stop, [])
    stopSessionForwarders('sess-reg-1')
    expect(stop).toHaveBeenCalledTimes(1)
    expect(hasSessionForwarders('sess-reg-1')).toBe(false)
  })
})

describe('getSessionPorts', () => {
  afterEach(() => {
    stopSessionForwarders('sess-ports-1')
  })

  it('returns [] for a session with no registered forwarders', () => {
    expect(getSessionPorts('sess-ports-unknown')).toEqual([])
  })

  it('returns the registered mappings and clears them on stop', () => {
    registerSessionForwarders('sess-ports-1', vi.fn(), [
      { containerPort: 8787, hostPort: 9787 },
      { containerPort: 5432, hostPort: 15432 },
    ])
    expect(getSessionPorts('sess-ports-1')).toEqual([
      { containerPort: 8787, hostPort: 9787 },
      { containerPort: 5432, hostPort: 15432 },
    ])
    stopSessionForwarders('sess-ports-1')
    expect(getSessionPorts('sess-ports-1')).toEqual([])
  })
})

describe('stopAllSessionForwarders', () => {
  afterEach(() => {
    stopAllSessionForwarders()
  })

  it('is a no-op when nothing is registered', () => {
    expect(() => stopAllSessionForwarders()).not.toThrow()
  })

  it('stops every registered forwarder and clears the registry', () => {
    const stopA = vi.fn()
    const stopB = vi.fn()
    registerSessionForwarders('sess-all-1', stopA, [])
    registerSessionForwarders('sess-all-2', stopB, [])
    expect(hasSessionForwarders('sess-all-1')).toBe(true)
    expect(hasSessionForwarders('sess-all-2')).toBe(true)

    stopAllSessionForwarders()

    expect(stopA).toHaveBeenCalledTimes(1)
    expect(stopB).toHaveBeenCalledTimes(1)
    expect(hasSessionForwarders('sess-all-1')).toBe(false)
    expect(hasSessionForwarders('sess-all-2')).toBe(false)
  })

  it('keeps stopping the rest even if one stop fn throws', () => {
    const stopA = vi.fn(() => { throw new Error('stuck relay') })
    const stopB = vi.fn()
    registerSessionForwarders('sess-all-3', stopA, [])
    registerSessionForwarders('sess-all-4', stopB, [])

    expect(() => stopAllSessionForwarders()).not.toThrow()

    expect(stopA).toHaveBeenCalledTimes(1)
    expect(stopB).toHaveBeenCalledTimes(1)
    expect(hasSessionForwarders('sess-all-3')).toBe(false)
    expect(hasSessionForwarders('sess-all-4')).toBe(false)
  })
})

describe('provisionSessionForwarders', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockRelayFactory.mockReturnValue(vi.fn() as never)
    mockStartForwarders.mockReturnValue(vi.fn())
  })

  afterEach(() => {
    stopSessionForwarders('sess-prov-1')
    stopSessionForwarders('sess-prov-2')
    stopSessionForwarders('sess-prov-3')
  })

  it('returns empty and refreshes status-right when no ports configured', async () => {
    const result = await provisionSessionForwarders(
      'proj', 'sess-prov-1', 'yaac-proj-sess-prov-1', undefined,
    )
    expect(result).toEqual([])
    expect(mockReserve).not.toHaveBeenCalled()
    expect(mockStartForwarders).not.toHaveBeenCalled()
    // Still refreshes tmux so any baked-in port info is cleared.
    expect(mockExec).toHaveBeenCalledTimes(1)
  })

  it('reserves, starts, registers and returns the port mappings', async () => {
    mockReserve
      .mockResolvedValueOnce(makeReservedPort(19500, 3000))
      .mockResolvedValueOnce(makeReservedPort(19501, 5432))

    const result = await provisionSessionForwarders(
      'proj', 'sess-prov-2', 'yaac-proj-sess-prov-2',
      [{ containerPort: 3000, hostPortStart: 3000 }, { containerPort: 5432, hostPortStart: 5432 }],
    )

    expect(mockReserve).toHaveBeenNthCalledWith(1, 3000, 3000)
    expect(mockReserve).toHaveBeenNthCalledWith(2, 5432, 5432)
    expect(mockRelayFactory).toHaveBeenCalledWith('sess-prov-2')
    expect(mockStartForwarders).toHaveBeenCalledTimes(1)
    expect(hasSessionForwarders('sess-prov-2')).toBe(true)
    // The registry serves the same mappings back for session-list rows.
    expect(getSessionPorts('sess-prov-2')).toEqual([
      { containerPort: 3000, hostPort: 19500 },
      { containerPort: 5432, hostPort: 19501 },
    ])
    expect(result).toEqual([
      { containerPort: 3000, hostPort: 19500 },
      { containerPort: 5432, hostPort: 19501 },
    ])
    // status-right refresh carries the real host ports.
    const statusCall = mockExec.mock.calls[0]?.[1] ?? ''
    expect(statusCall).toContain(':19500->3000')
    expect(statusCall).toContain(':19501->5432')
  })

  it('propagates reservation failures without registering or updating tmux', async () => {
    mockReserve.mockRejectedValue(new Error('no ports available'))
    await expect(
      provisionSessionForwarders('proj', 'sess-prov-3', 'yaac-proj-sess-prov-3', [
        { containerPort: 3000, hostPortStart: 3000 },
      ]),
    ).rejects.toThrow('no ports available')
    expect(mockExec).not.toHaveBeenCalled()
    expect(mockStartForwarders).not.toHaveBeenCalled()
    expect(hasSessionForwarders('sess-prov-3')).toBe(false)
  })
})
