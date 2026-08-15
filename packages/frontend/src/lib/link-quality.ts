/**
 * How slow the link to the server currently is, measured on the terminal
 * sockets.
 *
 * Nothing in the webapp knew this before: a laggy pane and a fast one look
 * identical from here, so "the terminal feels slow" could never be told from
 * "the agent is thinking". Every terminal socket already speaks a ping/pong
 * control frame, so the measurement rides that — each ping carries a stamp
 * the server echoes back, and the round trip lands here.
 *
 * One store for the whole app rather than one per pane: every socket crosses
 * the same link, so samples from all of them describe the same thing, and a
 * consumer wants that one number rather than whichever pane it happens to sit
 * next to.
 */

/** How often each open terminal socket probes. Long enough to be nothing on
 *  any link (one tiny frame per pane per interval), short enough that a
 *  connection going bad is visible within a few samples. */
export const RTT_PROBE_INTERVAL_MS = 10_000

/** Weight of a new sample in the smoothed value. Low enough that one
 *  scheduling hiccup doesn't swing it, high enough to follow a link that
 *  actually changed within a handful of probes. */
export const RTT_SMOOTHING = 0.25

/** The smoothed round trip after folding in `sample`. Pure, for testing and
 *  because the seeding rule matters: the first sample IS the estimate — an
 *  EWMA seeded from zero would spend several probes climbing to the truth
 *  and report a fast link during exactly the window a user is asking why
 *  things are slow. */
export function nextSmoothed(
  prev: number | null,
  sample: number,
  alpha: number = RTT_SMOOTHING,
): number {
  if (prev === null) return sample
  return prev * (1 - alpha) + sample * alpha
}

/**
 * The round trip a pong reports, or null if `text` isn't one of ours.
 *
 * Tolerant by design: this reads every text frame the PTY socket delivers,
 * which also carries errors and the CLI's stamp-less pong. Only a pong with
 * a finite stamp that isn't in the future is a measurement.
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
  /** The smoothed round trip, in ms — what a consumer should read. */
  smoothedMs: number | null
}

let quality: LinkQuality = { lastMs: null, smoothedMs: null }
const listeners = new Set<() => void>()

/** Fold one round-trip sample in and notify subscribers. */
export function recordRtt(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return
  quality = { lastMs: ms, smoothedMs: nextSmoothed(quality.smoothedMs, ms) }
  for (const cb of listeners) cb()
}

/** The current estimate. A stable object between changes, so it is safe as a
 *  `useSyncExternalStore` snapshot. */
export function linkQuality(): LinkQuality {
  return quality
}

export function subscribeLinkQuality(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** Drop every measurement (tests, and a deliberate re-probe). */
export function resetLinkQuality(): void {
  quality = { lastMs: null, smoothedMs: null }
  for (const cb of listeners) cb()
}
