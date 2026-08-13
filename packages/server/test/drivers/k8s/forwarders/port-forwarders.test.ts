import { EventEmitter } from 'node:events'
import type net from 'node:net'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('#drivers/k8s/substrate/stream-relay', () => ({
  podExec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  relayTcpFactory: vi.fn(),
}))

vi.mock('#lib/port', () => ({
  reserveAvailablePort: vi.fn(),
  startPortForwarders: vi.fn(),
}))

import { relayTcpFactory, podExec } from '#drivers/k8s/substrate/stream-relay'
import { reserveAvailablePort, startPortForwarders } from '#lib/port'
import type { ReservedPort } from '#lib/port'
import {
  MAX_FORWARDS_PER_SESSION,
  addWorktreeForwarder,
  getWorktreePorts,
  hasWorktreeForwarders,
  registerWorktreeForwarders,
  stopAllWorktreeForwarders,
  stopWorktreeForwarders,
} from '#drivers/k8s/forwarders/port-forwarders'
import { onWorktreeListChanged, _resetWorktreeListChangedForTests } from '#notify'

const mockExec = vi.mocked(podExec)
const mockReserve = vi.mocked(reserveAvailablePort)
const mockStartForwarders = vi.mocked(startPortForwarders)
const mockRelayFactory = vi.mocked(relayTcpFactory)

function makeReservedPort(hostPort: number, containerPort: number): ReservedPort {
  const server = Object.assign(new EventEmitter(), { close: vi.fn() }) as unknown as net.Server
  return { containerPort, hostPort, server }
}

describe('registry: register/stop/hasWorktreeForwarders', () => {
  afterEach(() => {
    // Clean up any registrations left by prior tests so they don't
    // bleed across it() calls.
    stopWorktreeForwarders('sess-reg-1')
    stopWorktreeForwarders('sess-reg-2')
    _resetWorktreeListChangedForTests()
  })

  it('registers a forwarder and reports it present', () => {
    expect(hasWorktreeForwarders('sess-reg-1')).toBe(false)
    registerWorktreeForwarders('sess-reg-1', vi.fn(), [])
    expect(hasWorktreeForwarders('sess-reg-1')).toBe(true)
  })

  it('merges a second registration — nothing is torn down, stop stops both', () => {
    // The create batch can land after a reactive addWorktreeForwarder made
    // the entry (forward-port during the create window); dropping either
    // side would kill live forwards, so registration merges.
    const first = vi.fn()
    const second = vi.fn()
    registerWorktreeForwarders('sess-reg-2', first, [{ containerPort: 3000, hostPort: 19000 }])
    registerWorktreeForwarders('sess-reg-2', second, [{ containerPort: 8080, hostPort: 19999 }])
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
    expect(getWorktreePorts('sess-reg-2')).toEqual([
      { containerPort: 3000, hostPort: 19000 },
      { containerPort: 8080, hostPort: 19999 },
    ])
    stopWorktreeForwarders('sess-reg-2')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('stopWorktreeForwarders invokes the stored stop and removes the entry', () => {
    const stop = vi.fn()
    registerWorktreeForwarders('sess-reg-1', stop, [])
    stopWorktreeForwarders('sess-reg-1')
    expect(stop).toHaveBeenCalledTimes(1)
    expect(hasWorktreeForwarders('sess-reg-1')).toBe(false)
  })

  // This registry is what the snapshot's `forwardedPorts` reads, so both
  // ends of a forward's life announce themselves here rather than at the
  // route that happened to ask for it.
  it('pushes a fresh snapshot when the forward set changes', () => {
    let pushes = 0
    _resetWorktreeListChangedForTests()
    onWorktreeListChanged(() => { pushes += 1 })

    registerWorktreeForwarders('sess-reg-1', vi.fn(), [{ containerPort: 3000, hostPort: 19000 }])
    expect(pushes).toBe(1)
    // A merge is a change too — it adds ports to the entry.
    registerWorktreeForwarders('sess-reg-1', vi.fn(), [{ containerPort: 8080, hostPort: 19001 }])
    expect(pushes).toBe(2)
    stopWorktreeForwarders('sess-reg-1')
    expect(pushes).toBe(3)
    // Nothing left to tear down: no entry, no change, no push.
    stopWorktreeForwarders('sess-reg-1')
    expect(pushes).toBe(3)
  })
})

describe('getWorktreePorts', () => {
  afterEach(() => {
    stopWorktreeForwarders('sess-ports-1')
  })

  it('returns [] for a session with no registered forwarders', () => {
    expect(getWorktreePorts('sess-ports-unknown')).toEqual([])
  })

  it('returns the registered mappings and clears them on stop', () => {
    registerWorktreeForwarders('sess-ports-1', vi.fn(), [
      { containerPort: 8787, hostPort: 9787 },
      { containerPort: 5432, hostPort: 15432 },
    ])
    expect(getWorktreePorts('sess-ports-1')).toEqual([
      { containerPort: 8787, hostPort: 9787 },
      { containerPort: 5432, hostPort: 15432 },
    ])
    stopWorktreeForwarders('sess-ports-1')
    expect(getWorktreePorts('sess-ports-1')).toEqual([])
  })
})

describe('stopAllWorktreeForwarders', () => {
  afterEach(() => {
    stopAllWorktreeForwarders()
  })

  it('is a no-op when nothing is registered', () => {
    expect(() => stopAllWorktreeForwarders()).not.toThrow()
  })

  it('stops every registered forwarder and clears the registry', () => {
    const stopA = vi.fn()
    const stopB = vi.fn()
    registerWorktreeForwarders('sess-all-1', stopA, [])
    registerWorktreeForwarders('sess-all-2', stopB, [])
    expect(hasWorktreeForwarders('sess-all-1')).toBe(true)
    expect(hasWorktreeForwarders('sess-all-2')).toBe(true)

    stopAllWorktreeForwarders()

    expect(stopA).toHaveBeenCalledTimes(1)
    expect(stopB).toHaveBeenCalledTimes(1)
    expect(hasWorktreeForwarders('sess-all-1')).toBe(false)
    expect(hasWorktreeForwarders('sess-all-2')).toBe(false)
  })

  it('keeps stopping the rest even if one stop fn throws', () => {
    const stopA = vi.fn(() => { throw new Error('stuck relay') })
    const stopB = vi.fn()
    registerWorktreeForwarders('sess-all-3', stopA, [])
    registerWorktreeForwarders('sess-all-4', stopB, [])

    expect(() => stopAllWorktreeForwarders()).not.toThrow()

    expect(stopA).toHaveBeenCalledTimes(1)
    expect(stopB).toHaveBeenCalledTimes(1)
    expect(hasWorktreeForwarders('sess-all-3')).toBe(false)
    expect(hasWorktreeForwarders('sess-all-4')).toBe(false)
  })
})

describe('addWorktreeForwarder', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockRelayFactory.mockReturnValue(vi.fn() as never)
    mockStartForwarders.mockReturnValue(vi.fn())
  })

  afterEach(() => {
    stopWorktreeForwarders('sess-add-1')
    stopWorktreeForwarders('sess-add-2')
    stopWorktreeForwarders('sess-add-3')
    stopWorktreeForwarders('sess-add-4')
  })

  it('reserves starting at the container port, starts one relay, and creates the entry', async () => {
    mockReserve.mockResolvedValueOnce(makeReservedPort(8090, 8090))

    const mapping = await addWorktreeForwarder('proj', 'sess-add-1', 'yaac-proj-sess-add-1', 8090)

    expect(mockReserve).toHaveBeenCalledWith(8090, 8090)
    expect(mockRelayFactory).toHaveBeenCalledWith('sess-add-1')
    expect(mockStartForwarders).toHaveBeenCalledTimes(1)
    expect(mapping).toEqual({ containerPort: 8090, hostPort: 8090 })
    expect(getWorktreePorts('sess-add-1')).toEqual([{ containerPort: 8090, hostPort: 8090 }])
    // status-right refresh carries the new mapping.
    expect(mockExec.mock.calls[0]?.[1] ?? '').toContain(':8090->8090')
  })

  it('appends to an existing entry and stop tears down both registrations', async () => {
    const batchStop = vi.fn()
    registerWorktreeForwarders('sess-add-2', batchStop, [{ containerPort: 3000, hostPort: 3000 }])
    const appendStop = vi.fn()
    mockStartForwarders.mockReturnValue(appendStop)
    mockReserve.mockResolvedValueOnce(makeReservedPort(19091, 8091))

    await addWorktreeForwarder('proj', 'sess-add-2', 'yaac-proj-sess-add-2', 8091)
    expect(getWorktreePorts('sess-add-2')).toEqual([
      { containerPort: 3000, hostPort: 3000 },
      { containerPort: 8091, hostPort: 19091 },
    ])

    stopWorktreeForwarders('sess-add-2')
    expect(batchStop).toHaveBeenCalledTimes(1)
    expect(appendStop).toHaveBeenCalledTimes(1)
  })

  it('is idempotent per container port', async () => {
    mockReserve.mockResolvedValueOnce(makeReservedPort(8092, 8092))
    const first = await addWorktreeForwarder('proj', 'sess-add-3', 'yaac-proj-sess-add-3', 8092)
    const second = await addWorktreeForwarder('proj', 'sess-add-3', 'yaac-proj-sess-add-3', 8092)
    expect(second).toEqual(first)
    expect(mockReserve).toHaveBeenCalledTimes(1)
    expect(mockStartForwarders).toHaveBeenCalledTimes(1)
  })

  it('concurrent requests for the same port converge on one forward', async () => {
    // Both calls pass the pre-await checks; the loser must detect the
    // winner's registration after its reservation lands, release the
    // reserved socket, and return the winner's mapping.
    const firstClose = vi.fn()
    const secondClose = vi.fn()
    const asReserved = (hostPort: number, close: () => void): ReservedPort => ({
      containerPort: 8094,
      hostPort,
      server: Object.assign(new EventEmitter(), { close }) as unknown as net.Server,
    })
    mockReserve
      .mockResolvedValueOnce(asReserved(8094, firstClose))
      .mockResolvedValueOnce(asReserved(18094, secondClose))

    const [a, b] = await Promise.all([
      addWorktreeForwarder('proj', 'sess-add-5', 'yaac-proj-sess-add-5', 8094),
      addWorktreeForwarder('proj', 'sess-add-5', 'yaac-proj-sess-add-5', 8094),
    ])

    expect(a).toEqual(b)
    expect(mockStartForwarders).toHaveBeenCalledTimes(1)
    expect(getWorktreePorts('sess-add-5')).toHaveLength(1)
    // Exactly one reservation (the loser's) was released.
    expect(firstClose.mock.calls.length + secondClose.mock.calls.length).toBe(1)
    stopWorktreeForwarders('sess-add-5')
  })

  it('rejects once the per-session forward cap is reached', async () => {
    registerWorktreeForwarders(
      'sess-add-4',
      vi.fn(),
      Array.from({ length: MAX_FORWARDS_PER_SESSION }, (_, i) => ({
        containerPort: 9000 + i, hostPort: 9000 + i,
      })),
    )
    await expect(
      addWorktreeForwarder('proj', 'sess-add-4', 'yaac-proj-sess-add-4', 8093),
    ).rejects.toThrow(/already holds/)
    expect(mockReserve).not.toHaveBeenCalled()
  })
})
