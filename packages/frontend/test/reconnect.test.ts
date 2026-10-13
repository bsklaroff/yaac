import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { reconnectingSocket } from '#lib/reconnect'
import { FakeSocket } from './harness'

beforeEach(() => {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** Accept, send one frame, and close. */
function frameThenClose(data: string): void {
  const sock = FakeSocket.latest()
  sock.open()
  sock.deliver(data)
  sock.close()
}

/** Time from a drop until the next attempt. */
function retryDelay(): number {
  const before = FakeSocket.instances.length
  let waited = 0
  while (FakeSocket.instances.length === before) {
    vi.advanceTimersByTime(100)
    waited += 100
  }
  return waited
}

describe('reconnectingSocket', () => {
  it('backs off through attaches that report a problem and close, and resets on a healthy one', () => {
    const sock = reconnectingSocket(() => '/api/x', { message: (d) => d === 'hello' })
    const delays: number[] = []
    for (let i = 0; i < 4; i++) {
      frameThenClose('health: down')
      delays.push(retryDelay())
    }
    expect(delays).toEqual([500, 1000, 2000, 4000])
    // Doubling stops at the ceiling.
    for (let i = 0; i < 3; i++) {
      frameThenClose('health: down')
      delays.push(retryDelay())
    }
    expect(delays.slice(4)).toEqual([8000, 10_000, 10_000])
    frameThenClose('hello')
    expect(retryDelay()).toBe(500)
    sock.close()
  })

  it('reconnects at once when the network returns, and not at all once closed', () => {
    const sock = reconnectingSocket(() => '/api/x', { message: () => false })
    for (let i = 0; i < 4; i++) {
      frameThenClose('nope')
      retryDelay()
    }
    FakeSocket.latest().close()
    const before = FakeSocket.instances.length
    window.dispatchEvent(new Event('online'))
    expect(FakeSocket.instances).toHaveLength(before + 1)
    sock.close()
    vi.advanceTimersByTime(60_000)
    window.dispatchEvent(new Event('online'))
    expect(FakeSocket.instances).toHaveLength(before + 1)
  })
})
