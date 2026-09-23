import { useState, type JSX, type KeyboardEvent, type ReactNode } from 'react'
import clsx from 'clsx'

/** One suggestion: what picking it yields, what it is shown and searched as,
 *  and an optional faint detail beside the label. */
export interface TypeaheadItem {
  value: string
  label: string
  detail?: string
}

/**
 * A bordered text input over a filtered suggestion list — the branch pickers
 * and the create form's model field. Purely presentational: the parent owns
 * the `query` text, the items, and what a selection does. `trailing` /
 * `belowInput` are slots for caller-specific chrome (e.g. the new-worktree
 * "pin as default" button and its error line).
 *
 * Filters on label and value alike, so a model is found by its name ("opus")
 * or its id ("claude-opus"). ↑/↓ move a highlight through the rows and Enter
 * picks the highlighted one — and only then: an Enter with nothing
 * highlighted is left to bubble, which is how the create form submits from
 * inside the field. `autoHighlight` highlights the first row as soon as the
 * user types, for a field whose typed text is a search rather than a value.
 * `freeEntry` adds a last row for text no item matches exactly (the model
 * field's "use this id").
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
  freeEntry,
  onBlur,
  trailing,
  belowInput,
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
  freeEntry?: (query: string) => TypeaheadItem | null
  /** Focus left the input — rows never take it (see their onMouseDown), so
   *  this is the user moving on, not picking. */
  onBlur?: () => void
  /** Accessory rendered to the right of the input box. */
  trailing?: ReactNode
  /** Node rendered between the input row and the suggestion list. */
  belowInput?: ReactNode
}): JSX.Element {
  const [highlight, setHighlight] = useState(-1)
  const needle = query.trim().toLowerCase()
  const matched = items
    .filter((i) => i.label.toLowerCase().includes(needle) || i.value.toLowerCase().includes(needle))
    .slice(0, limit)
  const free = needle !== '' && !items.some((i) => i.value === query.trim())
    ? freeEntry?.(query.trim()) ?? null
    : null
  const rows = free !== null ? [...matched, free] : matched
  const shown = showList && rows.length > 0
  const active = shown && highlight < rows.length ? highlight : -1

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (!shown) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setHighlight((h) => (Math.max(h, -1) + step + rows.length) % rows.length)
    } else if (e.key === 'Enter' && active >= 0 && !e.nativeEvent.isComposing) {
      // Taken here, so the form around the field does not also submit.
      e.preventDefault()
      e.stopPropagation()
      onSelect(rows[active].value)
    }
  }

  return (
    <>
      <div className={clsx('flex items-center gap-1', className)}>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2 py-1">
          {icon?.({ size: 12, className: 'shrink-0 text-text-faint' })}
          <input
            aria-label={ariaLabel}
            value={query}
            placeholder={placeholder}
            onChange={(e) => {
              onQueryChange(e.target.value)
              setHighlight(autoHighlight ? 0 : -1)
            }}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
            spellCheck={false}
            className="w-full min-w-0 bg-transparent font-mono text-xs text-text outline-none
              placeholder:text-text-faint"
          />
        </div>
        {trailing}
      </div>
      {belowInput}
      {shown && (
        <ul className="max-h-48 overflow-y-auto pb-1">
          {rows.map((item, i) => (
            <li key={item.value}>
              <button
                type="button"
                onClick={() => onSelect(item.value)}
                // Keep focus in the input, so picking a row is not first a
                // blur that could close the list under the click.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHighlight(i)}
                aria-selected={i === active}
                className={clsx(
                  'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left font-mono text-xs outline-none',
                  i === active ? 'bg-surface-3 text-text' : 'text-text-dim hover:bg-surface-3 hover:text-text',
                )}
              >
                {icon?.({ size: 11, className: 'shrink-0 text-text-faint' })}
                {/* The label is never cut off — it keeps its width, wrapping
                    only if even the whole row is too narrow — while the
                    detail gets what is left (truncating) and doubles as the
                    spacer that pushes the tag to the right edge. */}
                <span className="min-w-0 break-words">{item.label}</span>
                <span className="min-w-0 flex-1 truncate pl-2 text-right text-[10px] text-text-faint">
                  {item.detail}
                </span>
                {tag?.(item) && <span className="shrink-0 text-[10px] text-text-faint">{tag(item)}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
