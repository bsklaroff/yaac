import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { eventsWsUrl, startEventsMonitor, type EventsSocket } from '#events'
import type { ServerTarget } from '@yaac/shared/server-api'

const target = (port: number): ServerTarget =>
  ({ baseUrl: `http://127.0.0.1:${port}`, secret: `secret-${port}`, remote: false })

/** A scriptable fake socket that records its callbacks for the test to fire. */
class FakeSocket implements EventsSocket {
  message: ((data: string) => void) | null = null
  closeCb: (() => void) | null = null
  closed = false
  onMessage(cb: (data: string) => void): void { this.message = cb }
  onClose(cb: () => void): void { this.closeCb = cb }
  close(): void { this.closed = true }
}

describe('eventsWsUrl', () => {
  it('maps http → ws and appends /events', () => {
    expect(eventsWsUrl('http://127.0.0.1:8787')).toBe('ws://127.0.0.1:8787/events')
  })
  it('maps https → wss', () => {
    expect(eventsWsUrl('https://srv.example.ts.net')).toBe('wss://srv.example.ts.net/events')
  })
})

describe('startEventsMonitor', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** Wire a monitor around a queue of fake sockets, recording each open. */
  function harness(targets: ServerTarget[] = [target(8787)]) {
    const sockets: FakeSocket[] = []
    const opens: { url: string; bearer: string }[] = []
    const snapshots: unknown[] = []
    let call = 0
    const monitor = startEventsMonitor({
      resolveTarget: () => Promise.resolve(targets[Math.min(call++, targets.length - 1)]),
      openSocket: (url, bearer) => {
        opens.push({ url, bearer })
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
    expect(h.opens).toEqual([{ url: 'ws://127.0.0.1:8787/events', bearer: 'secret-8787' }])
    h.sockets[0].message?.(JSON.stringify({ type: 'snapshot', data: { sessions: [] } }))
    expect(h.snapshots).toHaveLength(1)
  })

  it('ignores malformed and non-snapshot frames', async () => {
    const h = harness()
    await vi.runOnlyPendingTimersAsync()
    h.sockets[0].message?.('{nope')
    h.sockets[0].message?.(JSON.stringify({ type: 'other', data: {} }))
    expect(h.snapshots).toHaveLength(0)
  })

  it('re-resolves the target on every reconnect (secret rotation heals)', async () => {
    const h = harness([target(8787), target(9999)])
    await vi.runOnlyPendingTimersAsync()
    h.sockets[0].closeCb?.()
    await vi.advanceTimersByTimeAsync(100)
    expect(h.opens).toHaveLength(2)
    expect(h.opens[1]).toEqual({ url: 'ws://127.0.0.1:9999/events', bearer: 'secret-9999' })
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
