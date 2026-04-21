import { EventEmitter } from 'node:events'
import type net from 'node:net'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/container/runtime', () => ({
  shellPodmanWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  podman: {
    listContainers: vi.fn(),
  },
}))

vi.mock('@/lib/container/port', () => ({
  reserveAvailablePort: vi.fn(),
  startPortForwarders: vi.fn(),
  podmanRelay: vi.fn(),
}))

import { shellPodmanWithRetry } from '@/lib/container/runtime'
import { podmanRelay, reserveAvailablePort, startPortForwarders } from '@/lib/container/port'
import type { ReservedPort } from '@/lib/container/port'
import {
  buildStatusRight,
  hasSessionForwarders,
  provisionSessionForwarders,
  registerSessionForwarders,
  setSessionStatusRight,
  stopSessionForwarders,
} from '@/lib/session/port-forwarders'

const mockExecPodman = vi.mocked(shellPodmanWithRetry)
const mockReserve = vi.mocked(reserveAvailablePort)
const mockStartForwarders = vi.mocked(startPortForwarders)
const mockPodmanRelay = vi.mocked(podmanRelay)

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

  it('issues a podman exec tmux set-option command with the rendered value', async () => {
    await setSessionStatusRight('yaac-proj-123', 'proj', 'abcdef0123456789', [
      { hostPort: 19001, containerPort: 3000 },
    ])
    expect(mockExecPodman).toHaveBeenCalledTimes(1)
    const arg = mockExecPodman.mock.calls[0]?.[0]
    expect(arg).toContain('podman exec yaac-proj-123 tmux set-option -t yaac status-right')
    expect(arg).toContain(':19001->3000')
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
    registerSessionForwarders('sess-reg-1', vi.fn())
    expect(hasSessionForwarders('sess-reg-1')).toBe(true)
  })

  it('ignores a second registration and runs the duplicate stop', () => {
    const first = vi.fn()
    const second = vi.fn()
    registerSessionForwarders('sess-reg-2', first)
    registerSessionForwarders('sess-reg-2', second)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('stopSessionForwarders invokes the stored stop and removes the entry', () => {
    const stop = vi.fn()
    registerSessionForwarders('sess-reg-1', stop)
    stopSessionForwarders('sess-reg-1')
    expect(stop).toHaveBeenCalledTimes(1)
    expect(hasSessionForwarders('sess-reg-1')).toBe(false)
  })
})

describe('provisionSessionForwarders', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockPodmanRelay.mockReturnValue(vi.fn() as never)
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
    expect(mockExecPodman).toHaveBeenCalledTimes(1)
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
    expect(mockPodmanRelay).toHaveBeenCalledWith('yaac-proj-sess-prov-2')
    expect(mockStartForwarders).toHaveBeenCalledTimes(1)
    expect(hasSessionForwarders('sess-prov-2')).toBe(true)
    expect(result).toEqual([
      { containerPort: 3000, hostPort: 19500 },
      { containerPort: 5432, hostPort: 19501 },
    ])
    // status-right refresh carries the real host ports.
    const statusCall = mockExecPodman.mock.calls[0]?.[0] ?? ''
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
    expect(mockExecPodman).not.toHaveBeenCalled()
    expect(mockStartForwarders).not.toHaveBeenCalled()
    expect(hasSessionForwarders('sess-prov-3')).toBe(false)
  })
})
