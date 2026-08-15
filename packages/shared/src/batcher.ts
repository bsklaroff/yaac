/**
 * Output micro-batcher: coalesces a stream's many small bursts into fewer,
 * larger writes.
 *
 * A tmux redraw (a copy-mode scroll step, a TUI repaint) reaches a PTY
 * consumer as a run of small data events; writing each one individually means
 * every hop downstream carries one message per event, and the browser terminal
 * parses and paints each fragment separately. Painting a fragment that ends
 * mid-redraw is what makes the cursor flash across the screen while scrolling:
 * the hide-cursor…show-cursor pair wrapping the redraw gets split across
 * frames. The same shape applies to keystrokes going the other way, where a
 * burst of one-character sockets sends becomes one.
 *
 * Policy — leading edge immediate, then throttle:
 *  - a push after ≥ batchMs of quiet flushes immediately (a lone keystroke,
 *    and its echo, pay zero added latency);
 *  - pushes within batchMs of the last flush accumulate and flush together
 *    when the window closes, so a sustained burst settles into one write per
 *    batchMs;
 *  - an accumulation reaching maxChars flushes at once (memory bound, and big
 *    transfers shouldn't wait out the timer).
 *
 * `dockerfiles/streamd/batcher.js` is the in-pod mirror of this module —
 * plain JS over Buffers, because the image has no workspace resolver — and
 * carries the same policy and the same constants. Change the two together,
 * the same arrangement `stream-frames.ts` and `dockerfiles/streamd/framing.js`
 * already use.
 */

/** One flush window. Well under a 60Hz frame, so batching never becomes the
 *  pacing item, while still spanning the burst of events one tmux redraw (or
 *  one autorepeat run) produces. */
export const BATCH_MS = 8
/** Flush-at-once threshold, in string length. A flush can carry up to this
 *  plus the push that crossed it (and a single larger push passes through
 *  whole). The pod-side mirror bounds Buffer bytes at the same number; both
 *  are just "don't let an accumulation balloon or wait out the timer". */
export const MAX_BATCH_CHARS = 64 * 1024

export interface OutputBatcher {
  /** Add a chunk, flushing per the policy above. */
  push(chunk: string): void
  /** Drain everything now — an ordering barrier (e.g. before a close). */
  flush(): void
  /** Stop for good: drop pending output and any timer (stream closed). */
  dispose(): void
}

export function createOutputBatcher(
  write: (chunk: string) => void,
  {
    batchMs = BATCH_MS,
    maxChars = MAX_BATCH_CHARS,
    now = Date.now,
  }: { batchMs?: number; maxChars?: number; now?: () => number } = {},
): OutputBatcher {
  let pending: string[] = []
  let pendingChars = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastFlushAt = -Infinity
  let disposed = false

  const flushNow = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (pendingChars === 0) return
    const chunk = pending.length === 1 ? pending[0] : pending.join('')
    pending = []
    pendingChars = 0
    lastFlushAt = now()
    write(chunk)
  }

  return {
    push(chunk: string): void {
      if (disposed || chunk === '') return
      pending.push(chunk)
      pendingChars += chunk.length
      if (pendingChars >= maxChars) {
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
      // A daemon must not be held alive by a pending flush. (`unref` is
      // Node-only; the browser's timer handle has no such method.)
      ;(timer as { unref?: () => void }).unref?.()
    },
    flush: flushNow,
    dispose(): void {
      disposed = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      pending = []
      pendingChars = 0
    },
  }
}
