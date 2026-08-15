/**
 * The link-quality store — what the terminal sockets' ping/pong measures.
 *
 * The parsing half matters most: `parsePongRtt` reads every text frame a PTY
 * socket delivers, which includes frames that are not measurements at all, so
 * the tests drive it with the real shapes that channel carries.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  nextSmoothed,
  parsePongRtt,
  recordRtt,
  linkQuality,
  subscribeLinkQuality,
  resetLinkQuality,
  RTT_SMOOTHING,
} from '#lib/link-quality'

beforeEach(() => { resetLinkQuality() })

describe('parsePongRtt', () => {
  it('reads the round trip out of a stamped pong', () => {
    expect(parsePongRtt('{"type":"pong","t":100}', 350)).toBe(250)
    // A round trip too fast to measure is still a measurement, not a miss.
    expect(parsePongRtt('{"type":"pong","t":100}', 100)).toBe(0)
  })

  it('ignores every other frame the socket delivers', () => {
    for (const frame of [
      // The CLI's keepalive pong carries no stamp, and the server echoes it
      // stamp-less; it is a liveness signal, not a measurement.
      '{"type":"pong"}',
      // The route's own error frame, sent when a worktree can't be resolved.
      '{"type":"error","message":"session not found or not running"}',
      // Junk and non-objects must not throw out of an onmessage handler.
      'not json', '', '42', 'null', '[]',
      // A pong whose stamp is unusable: not ours to interpret.
      '{"type":"pong","t":"soon"}',
      '{"type":"pong","t":null}',
      // A stamp in the future means the clock moved under us (or the frame
      // is not from this page's socket) — a negative "round trip" would
      // poison the average.
      '{"type":"pong","t":500}',
    ]) expect(parsePongRtt(frame, 400), frame).toBeNull()
  })
})

describe('nextSmoothed', () => {
  it('takes the first sample whole, then eases toward later ones', () => {
    // Seeding from the first sample rather than from zero is the point: an
    // average that started at zero would report a fast link for several
    // probes, which is exactly the window someone is asking why it's slow.
    expect(nextSmoothed(null, 200)).toBe(200)
    // A later sample moves the estimate by its weight, not all the way.
    expect(nextSmoothed(200, 400)).toBeCloseTo(200 + 200 * RTT_SMOOTHING)
    // A single outlier can't swing it far…
    const blip = nextSmoothed(50, 5000)
    expect(blip).toBeLessThan(1500)
    // …but a link that really did change is followed within a few probes.
    let est = 50
    for (let i = 0; i < 12; i++) est = nextSmoothed(est, 400)
    expect(est).toBeGreaterThan(350)
  })
})

describe('recordRtt', () => {
  it('publishes each sample and the running estimate to subscribers', () => {
    const seen: Array<number | null> = []
    const unsubscribe = subscribeLinkQuality(() => seen.push(linkQuality().smoothedMs))

    expect(linkQuality()).toEqual({ lastMs: null, smoothedMs: null })
    recordRtt(120)
    expect(linkQuality()).toEqual({ lastMs: 120, smoothedMs: 120 })
    recordRtt(220)
    expect(linkQuality().lastMs).toBe(220)
    expect(linkQuality().smoothedMs).toBeCloseTo(nextSmoothed(120, 220))
    expect(seen).toHaveLength(2)

    // The snapshot object is replaced, never mutated, so a
    // useSyncExternalStore consumer sees a change by identity.
    const before = linkQuality()
    recordRtt(130)
    expect(linkQuality()).not.toBe(before)

    unsubscribe()
    recordRtt(140)
    expect(seen).toHaveLength(3)
  })

  it('drops a sample that cannot be a round trip', () => {
    recordRtt(100)
    for (const bad of [-1, NaN, Infinity]) recordRtt(bad)
    expect(linkQuality()).toEqual({ lastMs: 100, smoothedMs: 100 })
  })
})
