/**
 * Round-trip time to the server, measured with the terminal sockets'
 * ping/pong frames: each ping carries a timestamp the server echoes back.
 * This lets the UI tell a slow link from a slow agent.
 *
 * There is one store for the whole app, since every socket crosses the same
 * link.
 */

/** How often each open terminal socket sends a ping. */
export const RTT_PROBE_INTERVAL_MS = 10_000

/** Weight of a new sample in the smoothed value: low enough to ignore one
 *  hiccup, high enough to follow a real change within a few pings. */
export const RTT_SMOOTHING = 0.25

/** The smoothed round trip after adding `sample`. The first sample is used
 *  as-is; seeding from zero would report a fast link for several pings. */
export function nextSmoothed(
  prev: number | null,
  sample: number,
  alpha: number = RTT_SMOOTHING,
): number {
  if (prev === null) return sample
  return prev * (1 - alpha) + sample * alpha
}

/**
 * The round trip a pong reports, or null if `text` isn't a timed pong. The
 * PTY socket also delivers errors and the CLI's pongs without a timestamp,
 * which return null.
 */
export function parsePongRtt(text: string, now: number): number | null {
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const msg = obj as { type?: unknown; t?: unknown }
  if (msg.type !== 'pong') return null
  if (typeof msg.t !== 'number' || !Number.isFinite(msg.t)) return null
  const rtt = now - msg.t
  return rtt >= 0 ? rtt : null
}

export interface LinkQuality {
  /** The most recent round trip, in ms. */
  lastMs: number | null
  /** The smoothed round trip, in ms. Consumers should read this one. */
  smoothedMs: number | null
}

let quality: LinkQuality = { lastMs: null, smoothedMs: null }
const listeners = new Set<() => void>()

/** Add one round-trip sample and notify subscribers. */
export function recordRtt(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return
  quality = { lastMs: ms, smoothedMs: nextSmoothed(quality.smoothedMs, ms) }
  for (const cb of listeners) cb()
}

/** The current estimate. The same object until it changes, so it is safe as
 *  a `useSyncExternalStore` snapshot. */
export function linkQuality(): LinkQuality {
  return quality
}

export function subscribeLinkQuality(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** Drop every measurement. */
export function resetLinkQuality(): void {
  quality = { lastMs: null, smoothedMs: null }
  for (const cb of listeners) cb()
}
