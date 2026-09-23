/** The find bar's match count, run off the main thread (see MatchCounter). */
import { countMatches, type QuerySpec } from '#lib/matchCount'

self.onmessage = (e: MessageEvent<{ id: number; doc: string; spec: QuerySpec }>) => {
  self.postMessage({ id: e.data.id, matches: countMatches(e.data.doc, e.data.spec) })
}
