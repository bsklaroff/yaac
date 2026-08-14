import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ProxyEventStream, type ProxyChangeSource } from '#drivers/k8s/egress/proxy-events'
import { onWorktreeListChanged, _resetWorktreeListChangedForTests } from '#notify'

vi.mock('#log', () => ({ serverLog: vi.fn() }))

/**
 * The server's half of the proxy change stream. Mocked at the process
 * boundary — the dial — so the line framing, the dispatch, the catch-up and
 * the respawn policy all run for real.
 */

/** A fake `fetch` response whose body yields `lines` and then behaves as
 *  `end` says. Aborting the signal errors the body, exactly as fetch does. */
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

let notified: number
let changes: ProxyChangeSource[]
let streams: ProxyEventStream[]

beforeEach(() => {
  _resetWorktreeListChangedForTests()
  notified = 0
  changes = []
  streams = []
  onWorktreeListChanged(() => { notified += 1 })
})

afterEach(() => {
  for (const s of streams) s.stop()
  _resetWorktreeListChangedForTests()
})

/**
 * Run the stream until it has slept `stopAfterSleeps` times (i.e. survived
 * that many reconnect cycles), then stop it. Returns the delays it asked
 * for, which is how the backoff policy is observed.
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
  // Real timer ticks, not setImmediate: the idle deadline is a real
  // setTimeout, so a loop that only drains microtasks would finish before
  // it could ever fire.
  for (let i = 0; i < 400 && delays.length < limit; i++) {
    await new Promise((r) => setTimeout(r, 1))
  }
  stream.stop()
  return delays
}

describe('ProxyEventStream', () => {
  // Blocked hosts and git-auth failures are snapshot inputs the server
  // re-reads off /data. They owe the reconciler nothing, so they must not
  // dirty a pass — only push.
  it('turns a state event into a snapshot push and nothing else', async () => {
    await run(responseOf(['{"type":"blocked-hosts"}\n{"type":"git-auth-failures"}\n']))
    // Two events, plus the one catch-up push on connect.
    expect(notified).toBe(3)
    expect(changes).toEqual(['mama-requests', 'proxy-reconnect'])
  })

  it('turns a queued spawn into a reconcile trigger', async () => {
    await run(responseOf(['{"type":"spawn"}\n']))
    expect(changes).toEqual(['mama-requests', 'proxy-reconnect', 'mama-requests'])
  })

  // Attaching says nothing about what happened while we were away, so the
  // stream assumes everything did. One catch-up per source is what makes a
  // dropped connection cost latency instead of a lost update.
  it('fires a full catch-up on every connect', async () => {
    const delays = await run(responseOf([]), { stopAfterSleeps: 2 })
    expect(delays).toHaveLength(2)
    // Once per connect: two connects, two catch-ups.
    expect(notified).toBe(2)
    expect(changes).toEqual([
      'mama-requests', 'proxy-reconnect',
      'mama-requests', 'proxy-reconnect',
    ])
  })

  // Pings exist so silence is distinguishable from death; they are not a
  // change. Garbage is ignored rather than fatal — a newer proxy may send
  // event types this server has never heard of.
  it('ignores pings, unknown types and unparseable lines', async () => {
    await run(responseOf(['{"type":"ping"}\n{"type":"from-the-future"}\nnot json\n\n']))
    expect(notified).toBe(1) // the catch-up alone
    expect(changes).toEqual(['mama-requests', 'proxy-reconnect'])
  })

  // The proxy writes whole lines but TCP does not deliver them that way.
  it('reassembles events split across chunks', async () => {
    await run(responseOf(['{"type":"bl', 'ocked-hosts"}', '\n{"type":"spa', 'wn"}\n']))
    expect(notified).toBe(2) // catch-up + the reassembled blocked-hosts
    expect(changes).toEqual(['mama-requests', 'proxy-reconnect', 'mama-requests'])
  })

  // Bounded so a wedged proxy can't outpace the resync by much: this is the
  // whole window in which proxy-owned state is stale.
  //
  // A proxy that ACCEPTS and immediately closes is the case this guards:
  // treating a bare attach as success would reset the backoff every cycle
  // and hot-loop at the base delay forever.
  it('backs off exponentially to a cap when connections deliver nothing', async () => {
    const delays = await run(responseOf([]), { stopAfterSleeps: 8 })
    expect(delays[0]).toBe(250)
    expect(delays[1]).toBe(500)
    expect(delays[2]).toBe(1000)
    expect(delays[delays.length - 1]).toBe(5000)
    expect(Math.max(...delays)).toBe(5000)
  })

  // Carrying traffic is what proves the connection was real, so that — not
  // attaching — is what earns the reset. A healthy proxy pings, so a stream
  // that merely goes quiet still reconnects promptly.
  it('resets the backoff once a stream delivers something', async () => {
    const delays = await run(responseOf(['{"type":"ping"}\n']), { stopAfterSleeps: 4 })
    expect(delays).toEqual([250, 250, 250, 250])
  })

  // The dial is the bare fetch, so nothing else bounds it. A relay that
  // accepts the connection but never returns headers is precisely the hang
  // the idle deadline exists for — but that timer is only armed once the
  // stream is live, so without a connect deadline the await would never
  // return and the stream would be dead for the rest of the server's life.
  it('reconnects when the dial itself hangs before returning headers', async () => {
    const delays = await run(
      (signal) => new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
      { stopAfterSleeps: 2, connectDeadlineMs: 10 },
    )
    expect(delays).toEqual([250, 500])
    // Never attached, so nothing is claimed to have caught up.
    expect(notified).toBe(0)
    expect(changes).toEqual([])
  })

  // Including a 404 — an unreachable route is a dead stream like any other,
  // and nothing is claimed to have caught up on a connection that never
  // attached.
  it.each([404, 500])('treats status %i as a stream death', async (status) => {
    const delays = await run(responseOf([], { status }), { stopAfterSleeps: 1 })
    expect(delays).toEqual([250])
    expect(notified).toBe(0)
    expect(changes).toEqual([])
  })

  it('reconnects when a dial throws', async () => {
    const delays = await run(() => Promise.reject(new Error('proxy is gone')), { stopAfterSleeps: 2 })
    expect(delays).toEqual([250, 500])
    expect(notified).toBe(0)
  })

  // A tunnel can wedge without TCP noticing — an exec relay whose apiserver
  // stopped answering looks exactly like an idle stream. The proxy's pings
  // are what make the difference observable, and this is what acts on it.
  it('reconnects when a held-open stream goes quiet past the idle deadline', async () => {
    const delays = await run(responseOf([], { end: 'hang' }), {
      stopAfterSleeps: 1,
      idleDeadlineMs: 10,
    })
    expect(delays).toEqual([250])
    // It got as far as attaching, so the catch-up fired.
    expect(notified).toBe(1)
  })

  // The held-open request keeps an exec relay (and a kubectl child) alive,
  // so shutdown has to actually end it.
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

    // And a start() after stop() does not resurrect it.
    stream.start()
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
    expect(opens).toBe(after)
  })
})
