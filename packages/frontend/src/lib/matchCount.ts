import { SearchQuery } from '@codemirror/search'
import { Text } from '@codemirror/state'

/** Delay after a keystroke or edit before the match count reruns. */
export const COUNT_DEBOUNCE_MS = 80
/** Past this many matches the count reads "N+" rather than walking on. */
export const MAX_COUNTED = 9999
/** A count still running after this long is killed and reported as slow. */
export const COUNT_TIMEOUT_MS = 1500

/** What the find bar's count needs from a query. */
export interface QuerySpec {
  search: string
  caseSensitive: boolean
  literal: boolean
  regexp: boolean
  wholeWord: boolean
}

export interface Matches {
  froms: number[]
  tos: number[]
  capped: boolean
  /** The count ran past COUNT_TIMEOUT_MS and was abandoned. */
  slow?: boolean
}

export const NO_MATCHES: Matches = { froms: [], tos: [], capped: false }

/** Every match of `spec` in `doc`, up to `limit`. Uses CodeMirror's
 *  cursor so the count agrees with what the editor highlights. */
export function countMatches(doc: string, spec: QuerySpec, limit = MAX_COUNTED): Matches {
  const query = new SearchQuery(spec)
  const froms: number[] = []
  const tos: number[] = []
  if (query.valid) {
    const cursor = query.getCursor(Text.of(doc.split('\n')))
    for (let m = cursor.next(); !m.done && froms.length < limit; m = cursor.next()) {
      froms.push(m.value.from)
      tos.push(m.value.to)
    }
  }
  return { froms, tos, capped: froms.length === limit }
}

/**
 * Counts matches in a Worker. A backtracking regex can run forever and
 * `RegExp.exec` can't be interrupted, so the worker is terminated when it
 * passes COUNT_TIMEOUT_MS or a newer count replaces it. The worker is reused
 * between counts.
 */
export class MatchCounter {
  private worker: Worker | null = null
  private running: { id: number; timer: ReturnType<typeof setTimeout> } | null = null
  private seq = 0

  count(doc: string, spec: QuerySpec, done: (matches: Matches) => void, limit = MAX_COUNTED): void {
    // A running count is stale and may be stuck, so kill its worker.
    if (this.running) this.dispose()
    const id = ++this.seq
    const worker = this.worker ??= new Worker(new URL('./matchCount.worker.ts', import.meta.url), { type: 'module' })
    const timer = setTimeout(() => {
      this.dispose()
      done({ ...NO_MATCHES, slow: true })
    }, COUNT_TIMEOUT_MS)
    this.running = { id, timer }
    worker.onmessage = (e: MessageEvent<{ id: number; matches: Matches }>) => {
      if (e.data.id !== id) return
      clearTimeout(timer)
      this.running = null
      done(e.data.matches)
    }
    worker.postMessage({ id, doc, spec, limit })
  }

  dispose(): void {
    clearTimeout(this.running?.timer)
    this.running = null
    this.worker?.terminate()
    this.worker = null
  }
}
