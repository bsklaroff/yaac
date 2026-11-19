import { useEffect, useMemo, useRef, useState, type ComponentProps, type JSX, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import clsx from 'clsx'
import {
  EditorView, runScopeHandlers, type Panel, type StateEffect, type Text, type ViewUpdate,
} from '@uiw/react-codemirror'
import {
  SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, search,
  setSearchQuery,
} from '@codemirror/search'
import { IS_MAC } from '#lib/platform'
import { COUNT_DEBOUNCE_MS, MatchCounter, NO_MATCHES, type Matches, type QuerySpec } from '#lib/matchCount'
import {
  ChevronIcon, CloseIcon, DropdownIcon, MatchCaseIcon, NextMatchIcon, PrevMatchIcon, RegexIcon, ReplaceAllIcon, ReplaceIcon,
  SearchIcon, WholeWordIcon,
} from '#lib/icons'
import { FIELD_BOX, YButton, YInput, YTip, YTooltip, YTooltipProvider } from '#ui'

type QueryFields = Partial<ConstructorParameters<typeof SearchQuery>[0]>

/** Whether two queries find the same thing (the replacement aside). */
const sameSearch = (a: SearchQuery, b: SearchQuery): boolean => a.search === b.search
  && a.caseSensitive === b.caseSensitive && a.wholeWord === b.wholeWord && a.regexp === b.regexp
  && a.literal === b.literal

/**
 * CodeMirror's search panel in the app's style: query with case / word /
 * regex toggles, a "3 of 12" count, previous / next, and a replace row.
 * Typing jumps to the first match after the cursor; Enter and Shift+Enter
 * step; Escape returns to the editor. The panel is its own React root.
 *
 * Match counting runs in a Worker (MatchCounter) so large files never stall
 * the page. A regex reaches the editor only once the worker has counted it
 * within its timeout, because the editor's highlighter runs it on the main
 * thread; a slower one shows "Too slow to count".
 */
class FindPanel implements Panel {
  readonly dom = document.createElement('div')
  readonly top = true
  private readonly root: Root = createRoot(this.dom)
  private readonly counter = new MatchCounter()
  private matches: Matches = NO_MATCHES
  /** The editor's last-seen query, and the bar's, which runs ahead while a
   *  regex awaits its count. */
  private seen: SearchQuery
  private query: SearchQuery
  private debounce: ReturnType<typeof setTimeout> | undefined
  /** Set by typing: select the first match from the cursor once counted. */
  private jump = false

  constructor(private readonly view: EditorView) {
    this.seen = this.query = getSearchQuery(view.state)
    this.recount()
    this.render()
  }

  update(update: ViewUpdate): void {
    const query = getSearchQuery(update.state)
    if (!query.eq(this.seen)) {
      this.seen = this.query = query
      this.recount()
    } else if (update.docChanged) {
      // Keep the old matches in step with the text until the recount lands.
      const map = (pos: number): number => update.changes.mapPos(pos)
      this.matches = { ...this.matches, froms: this.matches.froms.map(map), tos: this.matches.tos.map(map) }
      this.recount()
    } else if (!update.selectionSet) {
      return
    }
    this.render()
  }

  destroy(): void {
    clearTimeout(this.debounce)
    this.counter.dispose()
    // React refuses a synchronous unmount from inside the root's own click
    // handler, so defer it a tick.
    const root = this.root
    queueMicrotask(() => root.unmount())
  }

  /** Set the query from the bar; `jump` moves to its first match from the
   *  cursor once the count has found it. */
  private readonly commit = (fields: QueryFields, jump: boolean): void => {
    const { query } = this
    const next = new SearchQuery({
      search: query.search, caseSensitive: query.caseSensitive, literal: query.literal,
      regexp: query.regexp, wholeWord: query.wholeWord, replace: query.replace, ...fields,
    })
    this.jump = jump
    if (next.regexp && next.valid && !sameSearch(next, this.seen)) {
      this.query = next
      this.recount()
      this.render()
    } else {
      this.view.dispatch({ effects: setSearchQuery.of(next) })
    }
  }

  private recount(): void {
    clearTimeout(this.debounce)
    const { query } = this
    if (!query.valid) {
      this.matches = NO_MATCHES
      return
    }
    this.debounce = setTimeout(() => {
      const doc = this.view.state.doc
      const { search, caseSensitive, literal, regexp, wholeWord } = query
      this.counter.count(
        doc.toString(),
        { search, caseSensitive, literal, regexp, wholeWord },
        (matches) => this.counted(doc, query, matches),
      )
    }, COUNT_DEBOUNCE_MS)
  }

  private counted(doc: Text, query: SearchQuery, matches: Matches): void {
    // Stale count: a recount is on its way.
    if (this.view.state.doc !== doc || query !== this.query) return
    this.matches = matches
    if (matches.slow) {
      this.render()
      return
    }
    const effects: StateEffect<unknown>[] = query.eq(this.seen) ? [] : [setSearchQuery.of(query)]
    this.seen = query
    let at = -1
    if (this.jump && matches.froms.length > 0) {
      // The first match from the cursor, wrapping to the top.
      const { from } = this.view.state.selection.main
      at = Math.max(matches.froms.findIndex((f) => f >= from), 0)
      effects.push(EditorView.scrollIntoView(matches.froms[at], { y: 'center' }))
    }
    this.jump = false
    if (effects.length) {
      this.view.dispatch({
        effects,
        ...at !== -1 && { selection: { anchor: matches.froms[at], head: matches.tos[at] }, userEvent: 'select.search' },
      })
    }
    this.render()
  }

  private render(): void {
    const { main } = this.view.state.selection
    const { froms, tos } = this.matches
    const at = froms.findIndex((from, i) => from === main.from && tos[i] === main.to)
    this.root.render(
      <FindBar view={this.view} query={this.query} matches={this.matches} current={at + 1} commit={this.commit} />,
    )
  }
}

/** The editor extension that swaps in FindPanel (add to an editor's extensions). */
export const findPanel = search({ createPanel: (view) => new FindPanel(view) })

function FindBar({ view, query, matches, current, commit }: {
  view: EditorView
  query: SearchQuery
  matches: Matches
  /** 1-based index of the match the selection sits on; 0 when on none. */
  current: number
  commit: (fields: QueryFields, jump: boolean) => void
}): JSX.Element {
  // Local text so typing never waits on the editor; outside changes
  // (Mod-F over a new selection) still update it.
  const [text, setText] = useState(query.search)
  const [replacement, setReplacement] = useState(query.replace)
  const [replaceOpen, setReplaceOpen] = useState(query.replace !== '')
  useEffect(() => setText(query.search), [query.search])
  useEffect(() => setReplacement(query.replace), [query.replace])

  const findRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    findRef.current?.focus()
    findRef.current?.select()
  }, [])

  const onKeyDown = (e: KeyboardEvent): void => {
    // Run the editor's search keys (Escape, Mod-G, F3, Mod-F) first and stop
    // what they handle, so Escape does not also close a surrounding dialog.
    if (runScopeHandlers(view, e.nativeEvent, 'search-panel')) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    if (e.key !== 'Enter') return
    e.preventDefault()
    // No counted matches yet: nothing to step to.
    if (matches.froms.length === 0) return
    if (e.target === findRef.current) (e.shiftKey ? findPrevious : findNext)(view)
    else if (e.metaKey || e.ctrlKey) replaceAll(view)
    else replaceNext(view)
  }

  return (
    // One grid for both rows so the find and replace fields line up.
    <YTooltipProvider>
      <div
        onKeyDown={onKeyDown}
        className="grid grid-cols-[auto_minmax(0,380px)_auto] items-center justify-start gap-x-1 gap-y-1 bg-surface px-1.5 py-1
          font-sans text-sm text-muted"
      >
        <TipButton
          aria-label={replaceOpen ? 'Hide replace' : 'Show replace'}
          tip={replaceOpen ? 'Hide replace' : 'Replace…'}
          icon={replaceOpen ? DropdownIcon : ChevronIcon}
          onClick={() => setReplaceOpen(!replaceOpen)}
        />
        <FindControls
          inputRef={findRef}
          text={text}
          onText={(search) => {
            setText(search)
            commit({ search }, true)
          }}
          query={query}
          onToggle={(fields) => commit(fields, true)}
          matches={matches}
          current={current}
          onPrev={() => findPrevious(view)}
          onNext={() => findNext(view)}
          onClose={() => closeSearchPanel(view)}
        />
        {replaceOpen && (
          <>
            <span />
            <Field>
              <ReplaceIcon size={12} className="shrink-0 text-subtle" />
              <YInput
                bare
                value={replacement}
                onChange={(e) => {
                  setReplacement(e.target.value)
                  commit({ replace: e.target.value }, false)
                }}
                placeholder="Replace"
                aria-label="Replace"
                spellCheck={false}
                className="flex-1 py-0.5"
              />
            </Field>
            <div className="flex items-center">
              <TipButton
                aria-label="Replace"
                tip={<YTip title="Replace" hint="Replace this match and go to the next" keys="Enter" />}
                icon={ReplaceIcon}
                disabled={matches.froms.length === 0}
                onClick={() => replaceNext(view)}
              />
              <TipButton
                aria-label="Replace all"
                tip={<YTip title="Replace all" keys={`${IS_MAC ? '⌘' : 'Ctrl+'}Enter`} />}
                icon={ReplaceAllIcon}
                disabled={matches.froms.length === 0}
                onClick={() => replaceAll(view)}
              />
            </div>
          </>
        )}
      </div>
    </YTooltipProvider>
  )
}

/** A pane find bar's state; see `useFindQuery`. */
export interface FindQuery {
  isOpen: boolean
  open: () => void
  close: () => void
  spec: QuerySpec
  /** The query is non-empty and parses. */
  valid: boolean
  commit: (fields: Partial<QuerySpec>) => void
  /** Set by every query change: the pane moves to the first match once the
   *  new count lands, and clears it. */
  jump: RefObject<boolean>
  /** Bumped by each `open`, to refocus the query field. */
  focusKey: number
}

const NO_QUERY: QuerySpec = { search: '', caseSensitive: false, literal: false, regexp: false, wholeWord: false }

/**
 * The state of a find bar over a pane's content (the Changes pane's diffs, a
 * conversation): whether it is open, and its query, which closing keeps for
 * the next open. The pane does its own counting; `PaneFindBar` draws it.
 */
export function useFindQuery(defaultOpen = false): FindQuery {
  const [isOpen, setOpen] = useState(defaultOpen)
  const [focusKey, setFocusKey] = useState(0)
  const [spec, setSpec] = useState(NO_QUERY)
  const valid = useMemo(() => new SearchQuery(spec).valid, [spec])
  const jump = useRef(false)
  return {
    isOpen,
    open: () => {
      setOpen(true)
      setFocusKey((n) => n + 1)
    },
    close: () => setOpen(false),
    spec,
    valid,
    commit: (fields) => {
      jump.current = true
      setSpec((cur) => ({ ...cur, ...fields }))
    },
    jump,
    focusKey,
  }
}

/**
 * The bar `useFindQuery` drives, across the top of its pane. Enter and
 * Shift+Enter step; Escape closes without reaching the pane, where it may
 * mean leaving the view. `caseOnly` drops the whole-word and regex toggles,
 * for a search that has only case to offer (a preview's page).
 */
export function PaneFindBar({ find, matches, current, onStep, onClose, caseOnly = false }: {
  find: FindQuery
  matches: Matches
  /** Index of the current match, or -1. */
  current: number
  onStep: (dir: 1 | -1) => void
  onClose: () => void
  caseOnly?: boolean
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [find.focusKey])
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
    } else if (e.key === 'Enter' && e.target === inputRef.current) {
      e.preventDefault()
      onStep(e.shiftKey ? -1 : 1)
    }
  }
  return (
    <YTooltipProvider>
      <div
        onKeyDown={onKeyDown}
        className="grid shrink-0 grid-cols-[minmax(0,380px)_auto] items-center justify-start gap-x-1 border-b
          border-line bg-surface px-1.5 py-1 font-sans text-sm text-muted"
      >
        <FindControls
          inputRef={inputRef}
          text={find.spec.search}
          onText={(search) => find.commit({ search })}
          query={{ ...find.spec, valid: find.valid }}
          onToggle={find.commit}
          matches={matches}
          current={current + 1}
          onPrev={() => onStep(-1)}
          onNext={() => onStep(1)}
          onClose={onClose}
          caseOnly={caseOnly}
        />
      </div>
    </YTooltipProvider>
  )
}

/** The query flags the find toggles flip. */
type FindFlags = Pick<SearchQuery, 'caseSensitive' | 'wholeWord' | 'regexp'>

/**
 * A find bar's query field (with its count and case / word / regex toggles)
 * followed by previous / next / close, as two siblings so the caller lays
 * them out. Shared by the editor's find panel, the conversation's and the
 * Changes pane's.
 */
export function FindControls({
  inputRef, text, onText, query, onToggle, matches, current, onPrev, onNext, onClose, caseOnly = false,
}: {
  inputRef: RefObject<HTMLInputElement | null>
  text: string
  onText: (text: string) => void
  query: FindFlags & { valid: boolean }
  onToggle: (flags: Partial<FindFlags>) => void
  matches: Matches
  /** 1-based index of the current match; 0 when on none. */
  current: number
  onPrev: () => void
  onNext: () => void
  onClose: () => void
  caseOnly?: boolean
}): JSX.Element {
  const count = matches.froms.length
  const total = `${count}${matches.capped ? '+' : ''}`
  const status = !text ? ''
    : !query.valid ? 'Invalid pattern'
      : matches.slow ? 'Too slow to count'
        : count === 0 ? 'No results'
          : current > 0 ? `${current} of ${total}` : `${total} result${count === 1 ? '' : 's'}`
  const miss = text !== '' && (!query.valid || count === 0)
  return (
    <>
      <Field invalid={miss}>
        <SearchIcon size={12} className="shrink-0 text-subtle" />
        <YInput
          bare
          ref={inputRef}
          {...{ 'main-field': 'true' }}
          value={text}
          onChange={(e) => onText(e.target.value)}
          placeholder="Find"
          aria-label="Find"
          spellCheck={false}
          className="flex-1 py-0.5"
        />
        <span role="status" className={clsx('shrink-0 tabular-nums', miss ? 'text-danger' : 'text-subtle')}>
          {status}
        </span>
        <TipButton
          aria-label="Match case"
          tip={<YTip title="Match case" hint="Only matches with the same capitalization" />}
          icon={MatchCaseIcon}
          aria-pressed={query.caseSensitive}
          onClick={() => onToggle({ caseSensitive: !query.caseSensitive })}
        />
        {!caseOnly && (
          <>
            <TipButton
              aria-label="Whole word"
              tip={<YTip title="Match whole word" hint="Skip matches inside longer words" />}
              icon={WholeWordIcon}
              aria-pressed={query.wholeWord}
              onClick={() => onToggle({ wholeWord: !query.wholeWord })}
            />
            <TipButton
              aria-label="Regular expression"
              tip={<YTip title="Use regular expression" hint="Search for a pattern, like foo.*bar" />}
              icon={RegexIcon}
              aria-pressed={query.regexp}
              onClick={() => onToggle({ regexp: !query.regexp })}
            />
          </>
        )}
      </Field>
      <div className="flex items-center">
        <TipButton
          aria-label="Previous match"
          tip={<YTip title="Previous match" keys="Shift+Enter" />}
          icon={PrevMatchIcon}
          disabled={count === 0}
          onClick={onPrev}
        />
        <TipButton
          aria-label="Next match"
          tip={<YTip title="Next match" keys="Enter" />}
          icon={NextMatchIcon}
          disabled={count === 0}
          onClick={onNext}
        />
        <TipButton aria-label="Close" tip={<YTip title="Close" keys="Escape" />} icon={CloseIcon} onClick={onClose} />
      </div>
    </>
  )
}

/** The find and replace fields: an icon, a bare input and, for find, its
 *  count and toggles, in one sunken box. */
function Field({ invalid = false, children }: { invalid?: boolean; children: ReactNode }): JSX.Element {
  return (
    <div className={clsx(
      FIELD_BOX, 'flex h-6 min-w-0 items-center gap-1.5 pl-1.5 pr-0.5',
      invalid && 'outline-1 -outline-offset-1 outline-danger/60 focus-within:outline-danger/60!',
    )}>
      {children}
    </div>
  )
}

/** An icon button with a tooltip; with `aria-pressed` it is a toggle,
 *  tinted while on. */
function TipButton({ tip, ...button }: { tip: ReactNode } & ComponentProps<typeof YButton>): JSX.Element {
  return (
    <YTooltip tip={tip}>
      <YButton variant="ghost" size="sm" {...button} className="aria-pressed:bg-accent-soft aria-pressed:text-accent" />
    </YTooltip>
  )
}
