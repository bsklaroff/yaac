import { useEffect, useRef, type JSX, type ReactNode } from 'react'
import { Combobox } from '@base-ui/react/combobox'
import clsx from 'clsx'

/** One suggestion: what picking it yields, what it is shown and searched as,
 *  and an optional faint detail beside the label. */
export interface TypeaheadItem {
  value: string
  label: string
  detail?: string
}

/**
 * The items matching `query` by label or value, so a model matches "opus" or
 * "claude-opus". Ranked as a TUI's completion ranks them: an exact match,
 * then prefix matches, then the rest, each group in input order. Enter acts
 * on the first row, so typing a whole name must put that name first.
 */
export function filterSuggestions(
  items: readonly TypeaheadItem[],
  query: string,
  limit: number,
): TypeaheadItem[] {
  const needle = query.trim().toLowerCase()
  const rank = (i: TypeaheadItem): number => {
    const label = i.label.toLowerCase()
    const value = i.value.toLowerCase()
    if (label === needle || value === needle) return 0
    if (label.startsWith(needle) || value.startsWith(needle)) return 1
    return label.includes(needle) || value.includes(needle) ? 2 : 3
  }
  // Array.prototype.sort is stable, so input order holds within a rank.
  return items.map((item) => ({ item, rank: rank(item) }))
    .filter((r) => r.rank < 3)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map((r) => r.item)
}

/** The element id of a `SuggestionList` row, for `aria-activedescendant`. */
export function suggestionId(listId: string, index: number): string {
  return `${listId}-${String(index)}`
}

/**
 * A text input over a filtered suggestion list (branch pickers, the create
 * form's model and branch fields, the provider picker), on Base UI's
 * Combobox with the list rendered inline below the input. The parent owns
 * the query, the items and what a selection does, so the combobox never
 * holds a value, and only typing (not Base UI syncing the input to a pick)
 * reaches `onQueryChange`.
 *
 * Filters with `filterSuggestions`. ↑/↓ move a highlight and Enter picks
 * it; with nothing highlighted Enter bubbles, so the create form can submit.
 * `autoHighlight` highlights the first row on typing. Only items can be
 * picked, never free text. Escape with the list open calls `onDismiss` and
 * stops there, so a surrounding dialog stays open.
 */
export function Typeahead({
  items,
  query,
  onQueryChange,
  onSelect,
  showList,
  placeholder,
  ariaLabel,
  limit = 8,
  className,
  icon,
  tag,
  autoHighlight = false,
  onBlur,
  onDismiss,
}: {
  items: readonly TypeaheadItem[]
  /** Text shown in the input (parent-controlled). */
  query: string
  onQueryChange: (query: string) => void
  /** A suggestion was picked (clicked, or Enter on the highlighted row). */
  onSelect: (value: string) => void
  /** Whether to render the suggestion list at all. */
  showList: boolean
  placeholder?: string
  ariaLabel?: string
  /** Max suggestions shown (default 8). */
  limit?: number
  /** Extra classes on the input row (padding etc.). */
  className?: string
  /** Leading glyph, in the input and on every row. */
  icon?: (props: { size: number; className: string }) => ReactNode
  /** A trailing tag for a row (e.g. "default"). */
  tag?: (item: TypeaheadItem) => ReactNode
  autoHighlight?: boolean
  /** Focus left the input. Rows never take focus, so this is not a pick. */
  onBlur?: () => void
  /** Escape was pressed with the list open — close it. */
  onDismiss?: () => void
}): JSX.Element {
  const rows = filterSuggestions(items, query, limit)
  const shown = showList && rows.length > 0
  return (
    <Combobox.Root<TypeaheadItem>
      inline
      open={shown}
      value={null}
      onValueChange={(item) => { if (item) onSelect(item.value) }}
      inputValue={query}
      onInputValueChange={(q, { reason }) => { if (reason === 'input-change') onQueryChange(q) }}
      autoHighlight={autoHighlight}
    >
      <div className={clsx('flex items-center', className)}>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2 py-1">
          {icon?.({ size: 12, className: 'shrink-0 text-text-faint' })}
          <Combobox.Input
            aria-label={ariaLabel}
            // An inline list always reads as expanded; this one can be hidden.
            aria-expanded={shown}
            placeholder={placeholder}
            onKeyDown={(e) => {
              if (e.key !== 'Escape' || !showList || onDismiss === undefined) return
              e.preventDefault()
              e.stopPropagation()
              onDismiss()
            }}
            onBlur={onBlur}
            className="w-full min-w-0 bg-transparent font-mono text-xs text-text outline-none
              placeholder:text-text-faint"
          />
        </div>
      </div>
      {showList && rows.length === 0 && query.trim() !== '' && (
        <div className="px-2 py-1 text-[11px] text-text-faint">No matches</div>
      )}
      {shown && (
        <Combobox.List className="max-h-48 overflow-y-auto pb-1">
          {rows.map((item) => (
            <Combobox.Item
              key={item.value}
              value={item}
              className={clsx(ROW, 'text-text-dim data-[highlighted]:bg-surface-3 data-[highlighted]:text-text')}
            >
              <RowContent item={item} icon={icon} tag={tag} />
            </Combobox.Item>
          ))}
        </Combobox.List>
      )}
    </Combobox.Root>
  )
}

const ROW = 'flex w-full cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-left font-mono text-xs'

/** A suggestion row's inside: glyph, label, faint detail, trailing tag. */
function RowContent({ item, icon, tag }: {
  item: TypeaheadItem
  icon?: (props: { size: number; className: string }) => ReactNode
  tag?: (item: TypeaheadItem) => ReactNode
}): JSX.Element {
  const t = tag?.(item)
  return (
    <>
      {icon?.({ size: 11, className: 'shrink-0 text-text-faint' })}
      {/* The label keeps its width; the detail truncates and pushes
          the tag to the right edge. */}
      <span className="min-w-0 break-words">{item.label}</span>
      <span className="min-w-0 flex-1 truncate pl-2 text-right text-[10px] text-text-faint">
        {item.detail}
      </span>
      {t && <span className="shrink-0 text-[10px] text-text-faint">{t}</span>}
    </>
  )
}

/**
 * The rows of a suggestion list; the parent owns the input, the highlight and
 * the keys. Rows never take focus, so typing carries on in the input, which
 * names the list (`aria-controls`) and its highlighted row
 * (`aria-activedescendant`, see `suggestionId`) for a screen reader. The
 * highlighted row is kept scrolled into view.
 */
export function SuggestionList({
  id,
  rows,
  active,
  onSelect,
  onHover,
  icon,
  tag,
  className = 'max-h-48 pb-1',
}: {
  id: string
  rows: readonly TypeaheadItem[]
  active: number
  onSelect: (value: string) => void
  onHover: (index: number) => void
  icon?: (props: { size: number; className: string }) => ReactNode
  tag?: (item: TypeaheadItem) => ReactNode
  className?: string
}): JSX.Element {
  const activeRef = useRef<HTMLLIElement>(null)
  useEffect(() => {
    // jsdom has no scrollIntoView.
    activeRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [active])
  return (
    <ul id={id} role="listbox" className={clsx('overflow-y-auto', className)}>
      {rows.map((item, i) => (
        <li
          key={item.value}
          id={suggestionId(id, i)}
          ref={i === active ? activeRef : undefined}
          role="option"
          aria-selected={i === active}
          onClick={() => onSelect(item.value)}
          // Keep focus in the input so a blur cannot close the list
          // mid-click.
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onHover(i)}
          className={clsx(ROW, i === active ? 'bg-surface-3 text-text' : 'text-text-dim hover:bg-surface-3 hover:text-text')}
        >
          <RowContent item={item} icon={icon} tag={tag} />
        </li>
      ))}
    </ul>
  )
}
