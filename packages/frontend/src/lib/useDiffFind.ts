/**
 * Cmd/Ctrl-F over the Changes pane's diffs: one query across every shown
 * file's diff lines, counted off the main thread like the editor's find
 * (`MatchCounter`), with a current match to step through. Stepping walks
 * the counted matches, so the count is not capped; the server cuts the
 * diff body at 1 MB, which bounds it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SearchQuery } from '@codemirror/search'
import type { DiffLine } from '#lib/diff'
import { COUNT_DEBOUNCE_MS, MatchCounter, NO_MATCHES, type Matches } from '#lib/matchCount'

/** One file's diff, in the order the pane shows them. */
export interface SearchedDiff {
  path: string
  lines: DiffLine[]
}

/** A match: the file, the index of its diff line, and the span in that
 *  line's text. */
export interface DiffMatch {
  path: string
  line: number
  from: number
  to: number
}

type QueryFields = Partial<ConstructorParameters<typeof SearchQuery>[0]>

/**
 * Every diff line as one document, a line per line, so the counter's offsets
 * map back to a file and line. Hunk headers are blank lines: they are git's,
 * not the files'.
 */
function searchIndex(diffs: SearchedDiff[]): { text: string; starts: number[]; owners: [string, number][] } {
  const texts: string[] = []
  const starts: number[] = []
  const owners: [string, number][] = []
  let at = 0
  for (const { path, lines } of diffs) {
    lines.forEach((l, i) => {
      const text = l.kind === 'hunk' ? '' : l.text
      texts.push(text)
      starts.push(at)
      owners.push([path, i])
      at += text.length + 1
    })
  }
  return { text: texts.join('\n'), starts, owners }
}

/** The matches as file lines, each cut at its line's end, empty ones
 *  dropped. */
function locate({ starts, owners }: ReturnType<typeof searchIndex>, matches: Matches): DiffMatch[] {
  const out: DiffMatch[] = []
  let k = 0
  matches.froms.forEach((from, i) => {
    while (k + 1 < starts.length && starts[k + 1] <= from) k++
    const end = k + 1 < starts.length ? starts[k + 1] - 1 : Infinity
    const to = Math.min(matches.tos[i], end)
    if (to > from) out.push({ path: owners[k][0], line: owners[k][1], from: from - starts[k], to: to - starts[k] })
  })
  return out
}

/**
 * The find bar's state over `diffs`. `reveal` runs with the match each move
 * lands on, in the same update, so the pane can unfold it before `moved`
 * (bumped per move) asks it to scroll there.
 */
export function useDiffFind(diffs: SearchedDiff[], reveal: (match: DiffMatch) => void): {
  isOpen: boolean
  open: () => void
  close: () => void
  query: SearchQuery
  commit: (fields: QueryFields, jump: boolean) => void
  /** The count, for the bar's status. */
  matches: Matches
  located: DiffMatch[]
  /** Index into `located`, or -1. */
  current: number
  step: (dir: 1 | -1) => void
  moved: number
  focusKey: number
} {
  const [isOpen, setOpen] = useState(false)
  const [query, setQuery] = useState(() => new SearchQuery({ search: '' }))
  const [found, setFound] = useState<{ matches: Matches; located: DiffMatch[] }>({ matches: NO_MATCHES, located: [] })
  const [current, setCurrent] = useState(-1)
  const [moved, setMoved] = useState(0)
  const [focusKey, setFocusKey] = useState(0)
  const jump = useRef(false)
  const revealRef = useRef(reveal)
  revealRef.current = reveal
  const counter = useMemo(() => new MatchCounter(), [])
  useEffect(() => () => counter.dispose(), [counter])
  // Built only while the bar is open: the diffs change on every poll.
  const index = useMemo(() => (isOpen ? searchIndex(diffs) : null), [isOpen, diffs])

  const moveTo = useCallback((located: DiffMatch[], at: number): void => {
    setCurrent(at)
    if (at === -1) return
    revealRef.current(located[at])
    setMoved((n) => n + 1)
  }, [])

  useEffect(() => {
    if (!index || !query.valid || query.search === '') {
      setFound({ matches: NO_MATCHES, located: [] })
      setCurrent(-1)
      return
    }
    let live = true
    const timer = setTimeout(() => {
      const { search, caseSensitive, literal, regexp, wholeWord } = query
      counter.count(index.text, { search, caseSensitive, literal, regexp, wholeWord }, (matches) => {
        if (!live) return
        const located = matches.slow ? [] : locate(index, matches)
        setFound({ matches: { ...matches, froms: located.map((m) => m.from), tos: located.map((m) => m.to) }, located })
        // A new query lands on its first match; a new diff keeps the place.
        if (jump.current) moveTo(located, located.length ? 0 : -1)
        else setCurrent((c) => Math.min(c, located.length - 1))
        jump.current = false
      }, Infinity)
    }, COUNT_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [query, index, counter, moveTo])

  return {
    isOpen,
    open: () => {
      setOpen(true)
      setFocusKey((n) => n + 1)
    },
    close: () => setOpen(false),
    query,
    commit: (fields, jumpTo) => {
      jump.current = jumpTo
      setQuery((q) => new SearchQuery({
        search: q.search, caseSensitive: q.caseSensitive, literal: q.literal, regexp: q.regexp,
        wholeWord: q.wholeWord, ...fields,
      }))
    },
    matches: found.matches,
    located: found.located,
    current,
    step: (dir) => {
      const n = found.located.length
      if (n > 0) moveTo(found.located, current === -1 ? (dir > 0 ? 0 : n - 1) : (current + dir + n) % n)
    },
    moved,
    focusKey,
  }
}
