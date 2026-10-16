import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EVENTS_HEARTBEAT_MS, startEventsMonitor, type EventsSocket } from '#events'
import type { ServerTarget } from '#server-api'

const target = (port: number): ServerTarget =>
  ({ baseUrl: `http://127.0.0.1:${port}` })

/** A scriptable fake socket that records its callbacks for the test to fire. */
class FakeSocket implements EventsSocket {
  message: ((data: string) => void) | null = null
  closeCb: (() => void) | null = null
  pongCb: (() => void) | null = null
  closed = false
  open = true
  pings = 0
  onMessage(cb: (data: string) => void): void { this.message = cb }
  onClose(cb: () => void): void { this.closeCb = cb }
  onPong(cb: () => void): void { this.pongCb = cb }
  ping(): boolean {
    if (this.open) this.pings++
    return this.open
  }
  close(): void { this.closed = true }
  /** Like `ws`, terminating emits close. */
  terminate(): void {
    this.closed = true
    this.closeCb?.()
  }
}

describe('startEventsMonitor', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** Wire a monitor around a queue of fake sockets, recording each open. */
  function harness(targets: ServerTarget[] = [target(8787)]) {
    const sockets: FakeSocket[] = []
    const opens: string[] = []
    const snapshots: unknown[] = []
    let call = 0
    const monitor = startEventsMonitor({
      resolveTarget: () => Promise.resolve(targets[Math.min(call++, targets.length - 1)]),
      openSocket: (url) => {
        opens.push(url)
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
      onSnapshot: (s) => snapshots.push(s),
      reconnectDelayMs: 100,
    })
    return { monitor, sockets, opens, snapshots }
  }

  it('connects with the resolved target and forwards snapshot frames', async () => {
    const h = harness()
    await vi.runOnlyPendingTimersAsync()
    expect(h.opens).toEqual(['ws://127.0.0.1:8787/api/events'])
    h.sockets[0].message?.(JSON.stringify({ type: 'snapshot', data: { workspaces: [] } }))
    expect(h.snapshots).toHaveLength(1)
  })

  it('ignores malformed and non-snapshot frames', async () => {
    const h = harness()
    await vi.runOnlyPendingTimersAsync()
    h.sockets[0].message?.('{nope')
    h.sockets[0].message?.(JSON.stringify({ type: 'other', data: {} }))
    expect(h.snapshots).toHaveLength(0)
  })

  it('re-resolves the target on every reconnect (a re-pointed machine follows)', async () => {
    const h = harness([target(8787), target(9999)])
    await vi.runOnlyPendingTimersAsync()
    h.sockets[0].closeCb?.()
    await vi.advanceTimersByTimeAsync(100)
    expect(h.opens).toHaveLength(2)
    expect(h.opens[1]).toBe('ws://127.0.0.1:9999/api/events')
  })

  it('schedules only one reconnect when close fires twice (error + close)', async () => {
    const h = harness()
    await vi.runOnlyPendingTimersAsync()
    h.sockets[0].closeCb?.()
    h.sockets[0].closeCb?.()
    await vi.advanceTimersByTimeAsync(500)
    expect(h.opens).toHaveLength(2)
  })

  it('retries after a failed resolve (server still starting)', async () => {
    const sockets: FakeSocket[] = []
    let calls = 0
    startEventsMonitor({
      resolveTarget: () => {
        calls++
        if (calls === 1) return Promise.reject(new Error('no live server lock'))
        return Promise.resolve(target(8787))
      },
      openSocket: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
      onSnapshot: () => { /* ignore */ },
      reconnectDelayMs: 100,
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(calls).toBe(2)
    expect(sockets).toHaveLength(1)
  })

  it('drops a connection whose ping goes unanswered and reconnects', async () => {
    const h = harness()
    await vi.advanceTimersByTimeAsync(0)
    // A socket still connecting at a tick is not held to a pong it was
    // never asked for.
    h.sockets[0].open = false
    await vi.advanceTimersByTimeAsync(EVENTS_HEARTBEAT_MS)
    h.sockets[0].open = true
    await vi.advanceTimersByTimeAsync(EVENTS_HEARTBEAT_MS)
    expect(h.sockets[0].closed).toBe(false)
    expect(h.sockets[0].pings).toBe(1)
    // An answered ping keeps the connection.
    h.sockets[0].pongCb?.()
    await vi.advanceTimersByTimeAsync(EVENTS_HEARTBEAT_MS)
    expect(h.sockets[0].pings).toBe(2)
    expect(h.sockets[0].closed).toBe(false)
    // The next tick finds no pong, as after a sleep.
    await vi.advanceTimersByTimeAsync(EVENTS_HEARTBEAT_MS + 100)
    expect(h.sockets[0].closed).toBe(true)
    expect(h.opens).toHaveLength(2)
    // The dead socket's heartbeat stopped with it.
    await vi.advanceTimersByTimeAsync(EVENTS_HEARTBEAT_MS * 3)
    expect(h.sockets[0].pings).toBe(2)
  })

  it('reconnect() drops the connection and opens a fresh one', async () => {
    const h = harness()
    await vi.runOnlyPendingTimersAsync()
    h.monitor.reconnect()
    expect(h.sockets[0].closed).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(h.opens).toHaveLength(2)
  })

  it('stop() closes the socket and cancels reconnects', async () => {
    const h = harness()
    await vi.runOnlyPendingTimersAsync()
    h.monitor.stop()
    expect(h.sockets[0].closed).toBe(true)
    h.sockets[0].closeCb?.()
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.opens).toHaveLength(1)
  })
})
