import { useEffect, useRef, useState, type JSX, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import clsx from 'clsx'
import { Tooltip } from '@base-ui/react/tooltip'
import {
  EditorView, runScopeHandlers, type Panel, type StateEffect, type Text, type ViewUpdate,
} from '@uiw/react-codemirror'
import {
  SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, search,
  setSearchQuery,
} from '@codemirror/search'
import { IS_MAC } from '#lib/platform'
import { MatchCounter, NO_MATCHES, type Matches } from '#lib/matchCount'
import {
  ChevronIcon, CloseIcon, MatchCaseIcon, NextMatchIcon, PrevMatchIcon, RegexIcon, ReplaceAllIcon, ReplaceIcon,
  SearchIcon, WholeWordIcon,
} from '#lib/icons'

/** Quiet time after a keystroke or an edit before the count reruns. */
export const COUNT_DEBOUNCE_MS = 80

type QueryFields = Partial<ConstructorParameters<typeof SearchQuery>[0]>

/** Whether two queries find the same thing (the replacement aside). */
const sameSearch = (a: SearchQuery, b: SearchQuery): boolean => a.search === b.search
  && a.caseSensitive === b.caseSensitive && a.wholeWord === b.wholeWord && a.regexp === b.regexp
  && a.literal === b.literal

/**
 * CodeMirror's search panel, redrawn in the app's look: one row with the
 * query, its case / whole-word / regex toggles, a live "3 of 12" count and
 * previous / next, plus a replace row behind the chevron. Typing jumps to
 * the first match from the cursor, the way an IDE's find does; Enter and
 * Shift+Enter step, Escape closes back into the editor. The panel is a small
 * React root of its own, fed the editor's state on every update.
 *
 * Nothing on the typing or editing path scans the document: the count —
 * and the typing jump, which reads it — comes from a Worker (MatchCounter),
 * so a large file never stalls the page. A regex goes further: the editor's
 * own highlighter and next / previous run it on this thread, so it reaches
 * the editor only once the worker has counted it in time. One that
 * backtracks past the timeout stays in the bar as "Too slow to count".
 */
class FindPanel implements Panel {
  readonly dom = document.createElement('div')
  readonly top = true
  private readonly root: Root = createRoot(this.dom)
  private readonly counter = new MatchCounter()
  private matches: Matches = NO_MATCHES
  /** The editor's query as last seen, and the bar's — ahead of it while a
   *  regex waits on its count. */
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
    // Closing can come from a click inside this very root; unmounting it
    // synchronously there is refused, so it waits a tick.
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
    // Counted against text or a query that has since changed: a recount is
    // on its way.
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
  // Local text, so a keystroke never waits on the editor's round trip; an
  // outside change (Mod-F over a new selection) still lands in the box.
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
    // The editor's own search keys (Escape, Mod-G, F3, Mod-F) first. What
    // they handle stops here: a dialog around the editor dismisses on a
    // document-level Escape, and must not close along with the bar.
    if (runScopeHandlers(view, e.nativeEvent, 'search-panel')) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    if (e.key !== 'Enter') return
    e.preventDefault()
    // Nothing counted — no match, or a regex still unvetted — nothing to step to.
    if (matches.froms.length === 0) return
    if (e.target === findRef.current) (e.shiftKey ? findPrevious : findNext)(view)
    else if (e.metaKey || e.ctrlKey) replaceAll(view)
    else replaceNext(view)
  }

  const count = matches.froms.length
  const total = `${count}${matches.capped ? '+' : ''}`
  const status = !text ? ''
    : !query.valid ? 'Invalid pattern'
      : matches.slow ? 'Too slow to count'
        : count === 0 ? 'No results'
          : current > 0 ? `${current} of ${total}` : `${total} result${count === 1 ? '' : 's'}`
  const miss = text !== '' && (!query.valid || count === 0)

  const mod = IS_MAC ? '⌘' : 'Ctrl+'
  return (
    // One grid for both rows, so the replace field lines up under the find
    // field and each row's buttons sit right against its field.
    <Tooltip.Provider delay={400}>
      <div
        onKeyDown={onKeyDown}
        className="grid grid-cols-[auto_minmax(0,380px)_auto] items-center justify-start gap-x-1 gap-y-1 bg-surface px-1.5 py-1
          font-sans text-[11px] text-text-dim"
      >
        <IconButton
          label={replaceOpen ? 'Hide replace' : 'Show replace'}
          tip={replaceOpen ? 'Hide replace' : 'Replace…'}
          onClick={() => setReplaceOpen(!replaceOpen)}
        >
          <ChevronIcon size={12} className={clsx('transition-transform', replaceOpen && 'rotate-90')} />
        </IconButton>
        <Field invalid={miss}>
          <SearchIcon size={12} className="shrink-0 text-text-faint" />
          <input
            ref={findRef}
            {...{ 'main-field': 'true' }}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              commit({ search: e.target.value }, true)
            }}
            placeholder="Find"
            aria-label="Find"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent py-0.5 text-text outline-none placeholder:text-text-faint"
          />
          {/* The count lives in the field, as in a browser's find bar. */}
          <span role="status" className={clsx('shrink-0 tabular-nums', miss ? 'text-[#f85149]' : 'text-text-faint')}>
            {status}
          </span>
          <Toggle
            label="Match case"
            tip={<Tip title="Match case" hint="Only matches with the same capitalization" />}
            on={query.caseSensitive}
            onClick={() => commit({ caseSensitive: !query.caseSensitive }, true)}
          >
            <MatchCaseIcon size={14} />
          </Toggle>
          <Toggle
            label="Whole word"
            tip={<Tip title="Match whole word" hint="Skip matches inside longer words" />}
            on={query.wholeWord}
            onClick={() => commit({ wholeWord: !query.wholeWord }, true)}
          >
            <WholeWordIcon size={14} />
          </Toggle>
          <Toggle
            label="Regular expression"
            tip={<Tip title="Use regular expression" hint="Search for a pattern, like foo.*bar" />}
            on={query.regexp}
            onClick={() => commit({ regexp: !query.regexp }, true)}
          >
            <RegexIcon size={13} />
          </Toggle>
        </Field>
        <div className="flex items-center">
          <IconButton
            label="Previous match"
            tip={<Tip title="Previous match" keys="Shift+Enter" />}
            disabled={count === 0}
            onClick={() => findPrevious(view)}
          >
            <PrevMatchIcon size={13} />
          </IconButton>
          <IconButton
            label="Next match"
            tip={<Tip title="Next match" keys="Enter" />}
            disabled={count === 0}
            onClick={() => findNext(view)}
          >
            <NextMatchIcon size={13} />
          </IconButton>
          <IconButton label="Close" tip={<Tip title="Close" keys="Escape" />} onClick={() => closeSearchPanel(view)}>
            <CloseIcon size={13} />
          </IconButton>
        </div>
        {replaceOpen && (
          <>
            <span />
            <Field>
              <ReplaceIcon size={12} className="shrink-0 text-text-faint" />
              <input
                value={replacement}
                onChange={(e) => {
                  setReplacement(e.target.value)
                  commit({ replace: e.target.value }, false)
                }}
                placeholder="Replace"
                aria-label="Replace"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent py-0.5 text-text outline-none placeholder:text-text-faint"
              />
            </Field>
            <div className="flex items-center">
              <IconButton
                label="Replace"
                tip={<Tip title="Replace" hint="Replace this match and go to the next" keys="Enter" />}
                disabled={count === 0}
                onClick={() => replaceNext(view)}
              >
                <ReplaceIcon size={13} />
              </IconButton>
              <IconButton
                label="Replace all"
                tip={<Tip title="Replace all" keys={`${mod}Enter`} />}
                disabled={count === 0}
                onClick={() => replaceAll(view)}
              >
                <ReplaceAllIcon size={13} />
              </IconButton>
            </div>
          </>
        )}
      </div>
    </Tooltip.Provider>
  )
}

function Field({ invalid = false, children }: { invalid?: boolean; children: ReactNode }): JSX.Element {
  return (
    <div className={clsx(
      'flex h-6 min-w-0 items-center gap-1.5 rounded border bg-bg pl-1.5 pr-0.5 transition',
      invalid ? 'border-[#f85149]/60' : 'border-border focus-within:border-border-strong',
    )}>
      {children}
    </div>
  )
}

/** A tooltip's body: what the control does, why, and its key. */
function Tip({ title, hint, keys }: { title: string; hint?: string; keys?: string }): JSX.Element {
  return (
    <>
      <span className="text-text">{title}</span>
      {keys && <kbd className="ml-2 font-sans text-text-faint">{keys}</kbd>}
      {hint && <span className="block text-text-dim">{hint}</span>}
    </>
  )
}

/** A styled hover tooltip — quicker and more legible than `title`. */
function WithTip({ tip, children }: { tip: ReactNode; children: ReactElement }): JSX.Element {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner side="bottom" sideOffset={6}>
          <Tooltip.Popup
            className="z-50 max-w-[240px] rounded-md border border-border bg-surface-2 px-2 py-1 text-[11px] leading-snug
              shadow-[0_8px_24px_var(--shadow-color)] transition-opacity duration-100
              data-[starting-style]:opacity-0 data-[ending-style]:opacity-0"
          >
            {tip}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

function Toggle({ label, tip, on, onClick, children }: {
  label: string
  tip: ReactNode
  on: boolean
  onClick: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <WithTip tip={tip}>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-pressed={on}
        className={clsx('flex h-5 w-5 shrink-0 items-center justify-center rounded transition',
          on ? 'bg-accent/20 text-accent' : 'text-text-faint hover:bg-surface-2 hover:text-text')}
      >
        {children}
      </button>
    </WithTip>
  )
}

function IconButton({ label, tip, disabled, onClick, children }: {
  label: string
  tip: ReactNode
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <WithTip tip={tip}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-dim transition
          hover:bg-surface-2 hover:text-text disabled:pointer-events-none disabled:opacity-35"
      >
        {children}
      </button>
    </WithTip>
  )
}
