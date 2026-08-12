import { EventEmitter } from 'node:events'
import type net from 'node:net'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mocked at the process boundary only: the relay spawns a subprocess per
// connection and a reservation is a real bound socket. The registry the
// handoff lands in is a sibling module and stays REAL — it is in-memory,
// so what a caller can read back out of it afterwards is the honest
// assertion, and mocking it would only prove this file calls a function.
vi.mock('#runtime/k8s/substrate/stream-relay', () => ({
  relayTcpFactory: vi.fn(),
  podExec: vi.fn(),
}))
vi.mock('#lib/port', () => ({
  startPortForwarders: vi.fn(),
  reserveAvailablePort: vi.fn(),
}))

import { relayTcpFactory } from '#runtime/k8s/substrate/stream-relay'
import { startPortForwarders } from '#lib/port'
import type { ReservedPort } from '#lib/port'
import {
  getWorktreePorts,
  hasWorktreeForwarders,
  stopAllWorktreeForwarders,
  stopWorktreeForwarders,
} from '#runtime/k8s/forwarders/port-forwarders'
import { adoptWorktreeForwarders } from '#runtime/k8s/forwarders/adopt'

const mockRelayFactory = vi.mocked(relayTcpFactory)
const mockStart = vi.mocked(startPortForwarders)

function reserved(hostPort: number, containerPort: number): ReservedPort {
  const server = Object.assign(new EventEmitter(), { close: vi.fn() }) as unknown as net.Server
  return { containerPort, hostPort, server }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRelayFactory.mockReturnValue((() => ({})) as never)
  mockStart.mockReturnValue(vi.fn())
})

// The registry is process-local and outlives a test — clear it so one
// case's worktree can't answer the next one's read.
afterEach(stopAllWorktreeForwarders)

describe('adoptWorktreeForwarders', () => {
  it('relays the caller\'s own bound sockets, and holds the result for the worktree', () => {
    // The sockets were bound before the pod existed — that is the whole
    // reason this takes them instead of reserving its own — so what
    // reaches the relay must be those objects, not copies of their numbers.
    const ports = [reserved(3001, 3000), reserved(5433, 5432)]

    adoptWorktreeForwarders('sess-1', ports)

    expect(mockRelayFactory).toHaveBeenCalledWith('sess-1')
    expect(mockStart).toHaveBeenCalledWith(mockRelayFactory.mock.results[0]?.value, ports)
    // Read back out of the real registry: this is what the worktree
    // listing reports as the ports a worktree holds.
    expect(hasWorktreeForwarders('sess-1')).toBe(true)
    expect(getWorktreePorts('sess-1')).toEqual([
      { containerPort: 3000, hostPort: 3001 },
      { containerPort: 5432, hostPort: 5433 },
    ])
  })

  it('registers the batch under one stop, so the set comes down together', () => {
    // A leaked forward outlives its pod and holds a host port, which is
    // why a worktree's forwards are torn down as one set.
    const stop = vi.fn()
    mockStart.mockReturnValue(stop)

    adoptWorktreeForwarders('sess-1', [reserved(3001, 3000), reserved(5433, 5432)])
    stopWorktreeForwarders('sess-1')

    expect(stop).toHaveBeenCalledTimes(1)
    expect(hasWorktreeForwarders('sess-1')).toBe(false)
  })

  it('registers nothing for a worktree that forwards no ports', () => {
    // An empty entry would still read to the listing as "this worktree
    // holds forwards".
    adoptWorktreeForwarders('sess-1', [])

    expect(mockStart).not.toHaveBeenCalled()
    expect(hasWorktreeForwarders('sess-1')).toBe(false)
  })
})
