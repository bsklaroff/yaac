/**
 * Coalesces a stream's many small writes into fewer, larger ones.
 *
 * A tmux redraw arrives as many small data events. Painting each one
 * separately in the browser terminal splits the hide-cursor/show-cursor
 * pair around a redraw across frames, so the cursor flickers. Keystrokes
 * going the other way are batched the same way.
 *
 * Policy:
 *  - a push after at least batchMs of quiet flushes immediately, so a lone
 *    keystroke adds no latency;
 *  - pushes within batchMs of the last flush are held and flushed together
 *    when the window ends;
 *  - once maxChars are held they flush at once.
 *
 * `dockerfiles/streamd/batcher.js` is the in-pod copy of this module (plain
 * JS over Buffers) with the same policy and constants; change both
 * together.
 */

/** One flush window: well under a 60Hz frame, but long enough to span one
 *  tmux redraw. */
export const BATCH_MS = 8
/** Held output, in string length, that triggers an immediate flush. */
export const MAX_BATCH_CHARS = 64 * 1024

export interface OutputBatcher {
  push(chunk: string): void
  /** Write everything held now (e.g. before a close). */
  flush(): void
  /** Drop held output and any timer, and ignore later pushes. */
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
      // Don't keep a Node process alive for a pending flush (no-op in browsers).
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
