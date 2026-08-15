/**
 * Output micro-batcher for `pty` streams: coalesces the child's many small
 * write bursts into fewer, larger data frames.
 *
 * A tmux redraw (a copy-mode scroll step, a TUI repaint) reaches node-pty
 * as a run of small data events; framing each one individually means every
 * hop downstream — relay TCP, SPDY port-forward, WebSocket — carries one
 * message per event, and the browser terminal parses and paints each
 * fragment separately. Painting a fragment that ends mid-redraw is what
 * makes the cursor flash across the screen while scrolling: the
 * hide-cursor…show-cursor pair wrapping the redraw gets split across
 * frames.
 *
 * Policy — leading edge immediate, then throttle:
 *  - a push after ≥ batchMs of quiet flushes immediately (keystroke echo
 *    pays zero added latency);
 *  - pushes within batchMs of the last flush accumulate and flush together
 *    when the window closes, so a sustained burst settles into one frame
 *    per batchMs;
 *  - an accumulation reaching maxBytes flushes at once (memory bound, and
 *    big transfers shouldn't wait out the timer).
 *
 * `packages/shared/src/batcher.ts` is the host-side mirror of this module —
 * same policy, same constants, over strings rather than Buffers — used by the
 * server's PTY bridge and the webapp's keystroke path. This copy exists
 * separately because the image has no workspace resolver. Change both
 * together, the same arrangement framing.js and stream-frames.ts already use.
 */

/** One flush window. Well under a 60Hz frame, so batching never becomes
 *  the pacing item, while still spanning the burst of pty events one tmux
 *  redraw produces. */
const BATCH_MS = 8
/** Flush-at-once threshold. A flush can carry up to this plus the push
 *  that crossed it (and a single larger push passes through whole) —
 *  worst cases far under the codec's 1MB frame cap. */
const MAX_BATCH_BYTES = 64 * 1024

export function createOutputBatcher(write, { batchMs = BATCH_MS, maxBytes = MAX_BATCH_BYTES, now = Date.now } = {}) {
  let pending = []
  let pendingBytes = 0
  let timer = null
  let lastFlushAt = -Infinity
  let disposed = false

  const flushNow = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (pendingBytes === 0) return
    const buf = pending.length === 1 ? pending[0] : Buffer.concat(pending)
    pending = []
    pendingBytes = 0
    lastFlushAt = now()
    write(buf)
  }

  return {
    push(buf) {
      // Empty pushes are dropped rather than parked: flushNow's
      // `pendingBytes === 0` return would otherwise leave a zero-length
      // buffer sitting in `pending` until some later real byte flushed it.
      // node-pty does not emit them, so this is about keeping the policy
      // identical to the host-side mirror rather than a live case.
      if (disposed || buf.length === 0) return
      pending.push(buf)
      pendingBytes += buf.length
      if (pendingBytes >= maxBytes) {
        flushNow()
        return
      }
      if (timer !== null) return
      const sinceFlush = now() - lastFlushAt
      if (sinceFlush >= batchMs) {
        flushNow()
        return
      }
      timer = setTimeout(flushNow, batchMs - sinceFlush)
      // A bare-node daemon must not be held alive by a pending flush.
      if (typeof timer.unref === 'function') timer.unref()
    },
    /** Drain everything now (ordering barrier — e.g. before an exit frame). */
    flush: flushNow,
    /** Stop for good: drop pending output and any timer (stream closed). */
    dispose() {
      disposed = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      pending = []
      pendingBytes = 0
    },
  }
}
