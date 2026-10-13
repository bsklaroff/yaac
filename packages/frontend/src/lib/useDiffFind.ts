/**
 * Cmd/Ctrl-F over the Changes pane's diffs: one query across every shown
 * file's diff lines, counted off the main thread like the editor's find
 * (`MatchCounter`), with a current match to step through. It counts the
 * parsed diffs, not the rendered page as a conversation's find does,
 * because a long diff mounts only the chunks near the screen. Stepping walks
 * the counted matches, so the count is not capped; the server cuts the
 * diff body at 1 MB, which bounds it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FindQuery } from '#components/ui/FindPanel'
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
 * The matches of `find`'s query over `diffs`, and the current one. `reveal`
 * runs with the match each move lands on, in the same update, so the pane
 * can unfold it before `moved` (bumped per move) asks it to scroll there.
 */
export function useDiffFind(diffs: SearchedDiff[], find: FindQuery, reveal: (match: DiffMatch) => void): {
  /** The count, for the bar's status. */
  matches: Matches
  located: DiffMatch[]
  /** Index into `located`, or -1. */
  current: number
  step: (dir: 1 | -1) => void
  moved: number
} {
  const { isOpen, spec, valid, jump } = find
  const [found, setFound] = useState<{ matches: Matches; located: DiffMatch[] }>({ matches: NO_MATCHES, located: [] })
  const [current, setCurrent] = useState(-1)
  const [moved, setMoved] = useState(0)
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
    if (!index || !valid) {
      setFound({ matches: NO_MATCHES, located: [] })
      setCurrent(-1)
      return
    }
    let live = true
    const timer = setTimeout(() => {
      counter.count(index.text, spec, (matches) => {
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
  }, [spec, valid, index, counter, moveTo, jump])

  return {
    matches: found.matches,
    located: found.located,
    current,
    step: (dir) => {
      const n = found.located.length
      if (n > 0) moveTo(found.located, current === -1 ? (dir > 0 ? 0 : n - 1) : (current + dir + n) % n)
    },
    moved,
  }
}
