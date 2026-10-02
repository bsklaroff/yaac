// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  INITIAL_RECONNECT_DELAY_MS, MAX_RECONNECT_DELAY_MS, nextReconnectDelay, reconnectingSocket,
} from '#lib/reconnect'

describe('nextReconnectDelay', () => {
  it('doubles from the initial delay up to the cap, and stays there', () => {
    let delay = INITIAL_RECONNECT_DELAY_MS
    const seen = [delay]
    for (let i = 0; i < 10; i++) seen.push(delay = nextReconnectDelay(delay))
    expect(seen.slice(0, 6)).toEqual([500, 1000, 2000, 4000, 8000, MAX_RECONNECT_DELAY_MS])
    expect(delay).toBe(MAX_RECONNECT_DELAY_MS)
  })
})

/** A WebSocket the test opens, feeds and closes by hand. */
class FakeSocket {
  static instances: FakeSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  readyState = 0
  binaryType = 'blob'
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) { FakeSocket.instances.push(this) }
  send(): void {}
  close(): void { this.readyState = 3; this.onclose?.() }
  /** Accept, send one frame, and close. */
  frameThenClose(data: unknown): void {
    this.readyState = 1
    this.onopen?.()
    this.onmessage?.({ data })
    this.close()
  }
}

const latest = (): FakeSocket => FakeSocket.instances[FakeSocket.instances.length - 1]

beforeEach(() => {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

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
      latest().frameThenClose('health: down')
      delays.push(retryDelay())
    }
    expect(delays).toEqual([500, 1000, 2000, 4000])
    latest().frameThenClose('hello')
    expect(retryDelay()).toBe(500)
    sock.close()
  })

  it('reconnects at once when the network returns, and not at all once closed', () => {
    const sock = reconnectingSocket(() => '/api/x', { message: () => false })
    for (let i = 0; i < 4; i++) {
      latest().frameThenClose('nope')
      retryDelay()
    }
    latest().close()
    const before = FakeSocket.instances.length
    window.dispatchEvent(new Event('online'))
    expect(FakeSocket.instances).toHaveLength(before + 1)
    sock.close()
    vi.advanceTimersByTime(MAX_RECONNECT_DELAY_MS * 2)
    window.dispatchEvent(new Event('online'))
    expect(FakeSocket.instances).toHaveLength(before + 1)
  })
})
