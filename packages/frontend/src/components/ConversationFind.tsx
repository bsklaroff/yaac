import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type RefObject } from 'react'
import { Tooltip } from '@base-ui/react/tooltip'
import { SearchQuery } from '@codemirror/search'
import { groupFindText, type Found, type Group } from '#components/AcpTranscript'
import { FindControls } from '#components/ui/FindPanel'
import { dialogHoldsFocus } from '#lib/dialogFocus'
import { COUNT_DEBOUNCE_MS, MatchCounter, NO_MATCHES, type Matches, type QuerySpec } from '#lib/matchCount'
import { chordMatches, claimChord, findChord } from '#lib/shortcuts'
import { shortcutsSuspended, useUiStore } from '#lib/store'

/**
 * Cmd/Ctrl-F over a conversation (docs/agent-modes.md, "Find"). The search
 * covers the whole conversation, including what its rows hide until opened
 * (tool output, thinking, a condensed view's folded runs), in two passes,
 * each counted in a Worker (MatchCounter) so a slow regex never stalls the
 * page:
 *
 * - the conversation's groups, to find the rows holding a match, which the
 *   transcript then shows open (`Found`);
 * - the rendered text of the scrolling element, which is what the count,
 *   previous / next and the highlights work on, so they always agree with
 *   what is on screen. It reruns as the DOM changes (a live turn streaming).
 *
 * Highlights use the CSS Custom Highlight API, so the transcript's DOM is
 * never touched. Closing keeps only the current match's row open.
 */

/** What the find bar is asked to do by its pane. */
export interface FindOptions {
  /** Whether Cmd/Ctrl-F opens the bar: the pane is the one the user is in. */
  chord: boolean
  defaultOpen?: boolean
  /** Called after the bar closes, to put focus back. */
  onClose?: () => void
}

/** Run `onFind` on Cmd/Ctrl-F while `enabled`. Captured on window, so the
 *  chord is consumed before a terminal or the browser's own find sees it. */
export function useFindChord(enabled: boolean, onFind: () => void): void {
  const latest = useRef(onFind)
  latest.current = onFind
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (!chordMatches(findChord(), e) || dialogHoldsFocus() || shortcutsSuspended(useUiStore.getState())) return
      claimChord(e)
      latest.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [enabled])
}

/** Separates the pieces of the reveal pass's text, so no match spans two. */
const SEP = '\n\u0000\n'

/** Groups found by the reveal pass, with the query they were found for. */
type Revealed = Found & { spec: QuerySpec; slow?: true }

export function useConversationFind({ groups, scrollRef, chord, defaultOpen = false, onClose }: FindOptions & {
  groups: Group[]
  /** The scrolling element whose text is searched and highlighted. */
  scrollRef: RefObject<HTMLElement | null>
}): { bar: JSX.Element | null; found: Found | undefined } {
  const [open, setOpen] = useState(defaultOpen)
  const [focusNonce, setFocusNonce] = useState(0)
  const [text, setText] = useState('')
  const [flags, setFlags] = useState({ caseSensitive: false, wholeWord: false, regexp: false })
  const spec = useMemo<QuerySpec>(() => ({ search: text, literal: false, ...flags }), [text, flags])
  const parses = new SearchQuery(spec).valid
  const valid = text !== '' && parses
  const [revealed, setRevealed] = useState<Revealed>()
  const [matches, setMatches] = useState<Matches>(NO_MATCHES)
  const [current, setCurrent] = useState(-1)
  const ranges = useRef<Range[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  /** Set by a new query: move to its first match once counted. */
  const jump = useRef(false)
  const specRef = useRef(spec)
  specRef.current = spec
  const currentRef = useRef(current)
  currentRef.current = current

  /** This bar's ranges in the shared highlights. */
  const painted = useRef<Range[]>([])
  const paint = (found: Range[], at: number): void => {
    const hl = highlights()
    if (hl === null) return
    for (const r of painted.current) {
      hl.all.delete(r)
      hl.current.delete(r)
    }
    painted.current = found
    for (const [i, r] of found.entries()) (i === at ? hl.current : hl.all).add(r)
  }
  useEffect(() => () => paint([], -1), [])

  useFindChord(chord, () => {
    setOpen(true)
    setFocusNonce((n) => n + 1)
  })
  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [open, focusNonce])

  const revealCounter = useMemo(() => new MatchCounter(), [])
  const domCounter = useMemo(() => new MatchCounter(), [])
  useEffect(() => () => {
    revealCounter.dispose()
    domCounter.dispose()
  }, [revealCounter, domCounter])

  // The reveal pass: which groups hold a match, shown or hidden.
  useEffect(() => {
    if (!open) return
    if (!valid) {
      setRevealed(undefined)
      return
    }
    const timer = setTimeout(() => {
      const pieces = groups.flatMap(groupFindText)
      const starts: number[] = []
      let doc = ''
      for (const piece of pieces) {
        starts.push(doc.length)
        doc += piece + SEP
      }
      revealCounter.count(doc, spec, (m) => {
        const any = new Set<number>()
        const hidden = new Set<number>()
        let piece = 0
        for (const from of m.froms) {
          while (piece + 1 < starts.length && starts[piece + 1] <= from) piece++
          const { seq } = groups[piece >> 1]
          any.add(seq)
          if (piece % 2 === 1) hidden.add(seq)
        }
        setRevealed({ spec, any, hidden, ...(m.slow ? { slow: true } : {}) })
      })
    }, COUNT_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [open, valid, spec, groups, revealCounter])

  // The highlight pass, over the text on screen once the found rows opened.
  useEffect(() => {
    const el = scrollRef.current
    if (!open || !el || revealed === undefined || revealed.slow) {
      ranges.current = []
      paint([], -1)
      setCurrent(-1)
      setMatches(open && revealed?.slow ? { ...NO_MATCHES, slow: true } : NO_MATCHES)
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const recount = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const { doc, nodes, starts } = textOf(el)
        domCounter.count(doc, revealed.spec, (m) => {
          const found = rangesOf(m, nodes, starts)
          ranges.current = found
          setMatches(m)
          let at = -1
          if (found.length > 0) {
            if (jump.current && revealed.spec === specRef.current) {
              // The first match from the top of the view down, wrapping.
              const top = el.getBoundingClientRect().top
              at = Math.max(found.findIndex((r) => r.getBoundingClientRect().bottom >= top), 0)
              jump.current = false
              scrollToRange(found[at], el)
            } else {
              at = Math.min(Math.max(currentRef.current, 0), found.length - 1)
            }
          }
          setCurrent(at)
          paint(found, at)
        })
      }, COUNT_DEBOUNCE_MS)
    }
    recount()
    const observer = new MutationObserver(recount)
    observer.observe(el, { childList: true, subtree: true, characterData: true })
    return () => {
      clearTimeout(timer)
      observer.disconnect()
    }
  }, [open, revealed, scrollRef, domCounter])

  const step = (delta: number): void => {
    const found = ranges.current
    const el = scrollRef.current
    if (found.length === 0 || !el) return
    const at = (current + delta + found.length) % found.length
    setCurrent(at)
    paint(found, at)
    scrollToRange(found[at], el)
  }

  const close = (): void => {
    // Keep the row the reader was looking at open.
    const row = ranges.current[current]?.startContainer.parentElement?.closest('[data-seq]')
    const seq = row ? Number(row.getAttribute('data-seq')) : undefined
    setRevealed(seq === undefined ? undefined : { spec: specRef.current, any: new Set([seq]), hidden: new Set([seq]) })
    ranges.current = []
    setOpen(false)
    onClose?.()
  }

  const query = (search: string, next: Partial<typeof flags>): void => {
    setText(search)
    setFlags((cur) => ({ ...cur, ...next }))
    jump.current = true
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      // Not also the pane's Escape (leaving a subagent's view).
      e.stopPropagation()
      close()
    } else if (e.key === 'Enter' && e.target === inputRef.current) {
      e.preventDefault()
      step(e.shiftKey ? -1 : 1)
    }
  }

  const bar = open ? (
    <Tooltip.Provider>
      <div
        onKeyDown={onKeyDown}
        className="grid shrink-0 grid-cols-[minmax(0,380px)_auto] items-center justify-start gap-x-1 border-b
          border-hairline bg-surface px-1.5 py-1 font-sans text-[11px] text-text-dim"
      >
        <FindControls
          inputRef={inputRef}
          text={text}
          onText={(search) => query(search, {})}
          query={{ ...flags, valid: parses }}
          onToggle={(next) => query(text, next)}
          matches={matches}
          current={current + 1}
          onPrev={() => step(-1)}
          onNext={() => step(1)}
          onClose={close}
        />
      </div>
    </Tooltip.Provider>
  ) : null
  return { bar, found: revealed }
}

/** The two highlights every find bar adds its ranges to, styled in
 *  index.css; null where the API is missing (jsdom). */
let shared: { all: Highlight; current: Highlight } | null | undefined
function highlights(): { all: Highlight; current: Highlight } | null {
  if (shared !== undefined) return shared
  if (typeof Highlight === 'undefined' || typeof CSS === 'undefined' || !('highlights' in CSS)) return (shared = null)
  shared = { all: new Highlight(), current: new Highlight() }
  CSS.highlights.set('find-match', shared.all)
  CSS.highlights.set('find-current', shared.current)
  return shared
}

/** Elements whose text starts a new line in the searched text, so a match
 *  never joins the end of one paragraph to the start of the next. */
const BLOCK = new Set(['DIV', 'P', 'PRE', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'TABLE', 'TR', 'TD', 'TH', 'BUTTON',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6'])

/**
 * The text under `root` as the reader sees it, with each text node's start
 * in it. Text the reader cannot select (line numbers, a `$ ` prompt) is
 * left out, and a newline separates text in different blocks.
 */
function textOf(root: HTMLElement): { doc: string; nodes: Text[]; starts: number[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  const starts: number[] = []
  let doc = ''
  let block: Element | null = null
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const parent = n.parentElement
    if (parent === null || parent.closest('.select-none, [aria-hidden="true"]') !== null) continue
    let b: Element = parent
    while (!BLOCK.has(b.tagName) && b !== root && b.parentElement !== null) b = b.parentElement
    if (block !== null && b !== block) doc += '\n'
    block = b
    nodes.push(n as Text)
    starts.push(doc.length)
    doc += (n as Text).data
  }
  return { doc, nodes, starts }
}

/** Each match as a DOM range over the text nodes it spans. */
function rangesOf({ froms, tos }: Matches, nodes: Text[], starts: number[]): Range[] {
  let a = 0
  return froms.map((from, i) => {
    // A match may start on a block's separating newline, past its node.
    while (a + 1 < nodes.length && from >= starts[a] + nodes[a].length) a++
    let b = a
    while (b + 1 < nodes.length && starts[b + 1] < tos[i]) b++
    const range = document.createRange()
    range.setStart(nodes[a], Math.max(0, from - starts[a]))
    range.setEnd(nodes[b], Math.min(nodes[b].length, Math.max(0, tos[i] - starts[b])))
    return range
  })
}

/** Scroll each scroller from the match out to `root` so the match is in
 *  view, centering it in any that had it out of view. */
function scrollToRange(range: Range, root: HTMLElement): void {
  for (let el = range.startContainer.parentElement; el !== null && root.contains(el); el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth) continue
    const r = range.getBoundingClientRect()
    const box = el.getBoundingClientRect()
    if (r.top < box.top || r.bottom > box.bottom) el.scrollTop += r.top - box.top - (box.height - r.height) / 2
    if (r.left < box.left || r.right > box.right) el.scrollLeft += r.left - box.left - (box.width - r.width) / 2
  }
}
