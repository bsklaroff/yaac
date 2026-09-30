import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ProxyEventStream, type ProxyChangeSource } from '#drivers/k8s/egress/proxy-events'

/**
 * The server's side of the proxy change stream. Only the dial is faked, so
 * line framing, dispatch, catch-up and reconnect policy run for real.
 */

vi.mock('#log', () => ({ serverLog: vi.fn() }))

/**
 * A fake `fetch` response whose body yields `lines`, then closes or hangs.
 * Aborting the signal errors the body, as fetch does.
 */
function responseOf(
  lines: string[],
  opts: { status?: number; end?: 'close' | 'hang' } = {},
): (signal: AbortSignal) => Promise<Response> {
  return (signal) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        for (const l of lines) controller.enqueue(enc.encode(l))
        if ((opts.end ?? 'close') === 'close') {
          controller.close()
          return
        }
        signal.addEventListener('abort', () => {
          try {
            controller.error(new Error('aborted'))
          } catch {
            // already closed
          }
        }, { once: true })
      },
    })
    return Promise.resolve(new Response(body, { status: opts.status ?? 200 }))
  }
}

let changes: ProxyChangeSource[]
let streams: ProxyEventStream[]

beforeEach(() => {
  changes = []
  streams = []
})

afterEach(() => {
  for (const s of streams) s.stop()
})

/**
 * Run the stream until it has slept `stopAfterSleeps` times (reconnect
 * cycles), then stop it. Returns the requested delays, to observe backoff.
 */
async function run(
  open: (signal: AbortSignal) => Promise<Response>,
  opts: { stopAfterSleeps?: number; idleDeadlineMs?: number; connectDeadlineMs?: number } = {},
): Promise<number[]> {
  const limit = opts.stopAfterSleeps ?? 1
  const delays: number[] = []
  let started: ProxyEventStream | null = null
  const sleep = (ms: number): Promise<void> => {
    delays.push(ms)
    if (delays.length >= limit) started?.stop()
    return Promise.resolve()
  }
  const stream = new ProxyEventStream(
    (source) => changes.push(source),
    {
      open,
      sleep,
      ...(opts.idleDeadlineMs !== undefined ? { idleDeadlineMs: opts.idleDeadlineMs } : {}),
      ...(opts.connectDeadlineMs !== undefined
        ? { connectDeadlineMs: opts.connectDeadlineMs }
        : {}),
    },
  )
  started = stream
  streams.push(stream)
  stream.start()
  // Real timer ticks, so the real idle-deadline setTimeout can fire.
  for (let i = 0; i < 400 && delays.length < limit; i++) {
    await new Promise((r) => setTimeout(r, 1))
  }
  stream.stop()
  return delays
}

describe('ProxyEventStream', () => {
  it('turns a queued request into a reconcile trigger', async () => {
    await run(responseOf(['{"type":"mama"}\n{"type":"mama"}\n']))
    // Plus the one catch-up drain on connect.
    expect(changes).toEqual(['mama-requests', 'mama-requests', 'mama-requests'])
  })

  // Requests may have queued while disconnected, so every connect drains
  // once. A dropped connection then costs latency, not a lost request.
  it('fires a catch-up drain on every connect', async () => {
    const delays = await run(responseOf([]), { stopAfterSleeps: 2 })
    expect(delays).toHaveLength(2)
    expect(changes).toEqual(['mama-requests', 'mama-requests'])
  })

  // Pings only prove the stream is alive. Unknown types are ignored, since
  // a newer proxy may send types this server does not know; `blocked-hosts`
  // is a type older proxies send.
  it('ignores pings, unknown types, retired types and unparseable lines', async () => {
    await run(responseOf(['{"type":"ping"}\n{"type":"from-the-future"}\n{"type":"blocked-hosts"}\nnot json\n\n']))
    expect(changes).toEqual(['mama-requests'])
  })

  // The proxy writes whole lines but TCP does not deliver them that way.
  it('reassembles events split across chunks', async () => {
    await run(responseOf(['{"type":"ma', 'ma"}', '\n{"type":"ma', 'ma"}\n']))
    expect(changes).toEqual(['mama-requests', 'mama-requests', 'mama-requests'])
  })

  // The cap bounds how long proxy state can be stale. A proxy that accepts
  // and immediately closes must not reset the backoff, or the stream would
  // hot-loop at the base delay.
  it('backs off exponentially to a cap when connections deliver nothing', async () => {
    const delays = await run(responseOf([]), { stopAfterSleeps: 8 })
    expect(delays[0]).toBe(250)
    expect(delays[1]).toBe(500)
    expect(delays[2]).toBe(1000)
    expect(delays[delays.length - 1]).toBe(5000)
    expect(Math.max(...delays)).toBe(5000)
  })

  // Receiving data, not just connecting, resets the backoff. A healthy
  // proxy pings, so this happens promptly.
  it('resets the backoff once a stream delivers something', async () => {
    const delays = await run(responseOf(['{"type":"ping"}\n']), { stopAfterSleeps: 4 })
    expect(delays).toEqual([250, 250, 250, 250])
  })

  // The idle deadline is armed only once the stream is live, so a peer
  // that accepts but never sends headers needs a separate connect deadline,
  // or the stream would hang forever.
  it('reconnects when the dial itself hangs before returning headers', async () => {
    const delays = await run(
      (signal) => new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
      { stopAfterSleeps: 2, connectDeadlineMs: 10 },
    )
    expect(delays).toEqual([250, 500])
    // Never connected, so no catch-up drain.
    expect(changes).toEqual([])
  })

  // A 404 is a dead stream too, and a failed connect fires no catch-up.
  it.each([404, 500])('treats status %i as a stream death', async (status) => {
    const delays = await run(responseOf([], { status }), { stopAfterSleeps: 1 })
    expect(delays).toEqual([250])
    expect(changes).toEqual([])
  })

  it('reconnects when a dial throws', async () => {
    const delays = await run(() => Promise.reject(new Error('proxy is gone')), { stopAfterSleeps: 2 })
    expect(delays).toEqual([250, 500])
    expect(changes).toEqual([])
  })

  // A connection can wedge without TCP noticing. The proxy's pings make
  // that visible as silence past the idle deadline.
  it('reconnects when a held-open stream goes quiet past the idle deadline', async () => {
    const delays = await run(responseOf([], { end: 'hang' }), {
      stopAfterSleeps: 1,
      idleDeadlineMs: 10,
    })
    expect(delays).toEqual([250])
    // It connected, so the catch-up fired.
    expect(changes).toEqual(['mama-requests'])
  })

  // The held-open request keeps a connection alive, so stop must end it.
  it('stops for good once stopped', async () => {
    let opens = 0
    const stream = new ProxyEventStream((s) => changes.push(s), {
      open: (signal) => { opens += 1; return responseOf([], { end: 'hang' })(signal) },
      sleep: async () => {},
    })
    streams.push(stream)
    stream.start()
    for (let i = 0; i < 20 && opens === 0; i++) await new Promise((r) => setImmediate(r))
    stream.stop()
    const after = opens
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r))
    expect(opens).toBe(after)

    // start() after stop() does not restart it.
    stream.start()
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
    expect(opens).toBe(after)
  })
})
