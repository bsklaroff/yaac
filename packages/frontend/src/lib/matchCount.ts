import { SearchQuery } from '@codemirror/search'
import { Text } from '@codemirror/state'

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

/** Every match of `spec` in `doc`, up to MAX_COUNTED — CodeMirror's own
 *  cursor, so the count always agrees with what the editor highlights. */
export function countMatches(doc: string, spec: QuerySpec): Matches {
  const query = new SearchQuery(spec)
  const froms: number[] = []
  const tos: number[] = []
  if (query.valid) {
    const cursor = query.getCursor(Text.of(doc.split('\n')))
    for (let m = cursor.next(); !m.done && froms.length < MAX_COUNTED; m = cursor.next()) {
      froms.push(m.value.from)
      tos.push(m.value.to)
    }
  }
  return { froms, tos, capped: froms.length === MAX_COUNTED }
}

/**
 * Counts matches off the main thread. Counting a large file takes time, and
 * a regex that backtracks can take forever — a single `RegExp.exec` cannot
 * be interrupted — so the work runs in a Worker that is terminated when it
 * runs past COUNT_TIMEOUT_MS or a newer count supersedes it mid-run. One
 * worker is kept warm between counts.
 */
export class MatchCounter {
  private worker: Worker | null = null
  private running: { id: number; timer: ReturnType<typeof setTimeout> } | null = null
  private seq = 0

  count(doc: string, spec: QuerySpec, done: (matches: Matches) => void): void {
    // A count still running is stale now; it may be stuck, so it goes.
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
    worker.postMessage({ id, doc, spec })
  }

  dispose(): void {
    clearTimeout(this.running?.timer)
    this.running = null
    this.worker?.terminate()
    this.worker = null
  }
}
