/**
 * The link-quality store. `parsePongRtt` sees every text frame on a PTY
 * socket, so it is tested with the real frame shapes, including ones that
 * aren't measurements.
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
    // A zero round trip is still a measurement.
    expect(parsePongRtt('{"type":"pong","t":100}', 100)).toBe(0)
  })

  it('ignores every other frame the socket delivers', () => {
    for (const frame of [
      // The CLI's keepalive pong has no timestamp.
      '{"type":"pong"}',
      // The route's own error frame, sent when a workspace can't be resolved.
      '{"type":"error","message":"session not found or not running"}',
      // Junk and non-objects must not throw out of an onmessage handler.
      'not json', '', '42', 'null', '[]',
      // A pong with an unusable timestamp.
      '{"type":"pong","t":"soon"}',
      '{"type":"pong","t":null}',
      // A timestamp in the future would give a negative round trip.
      '{"type":"pong","t":500}',
    ]) expect(parsePongRtt(frame, 400), frame).toBeNull()
  })
})

describe('nextSmoothed', () => {
  it('takes the first sample whole, then eases toward later ones', () => {
    // The first sample is the estimate; starting from zero would report a
    // fast link for several pings.
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

    // A new object on each change, for useSyncExternalStore.
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
