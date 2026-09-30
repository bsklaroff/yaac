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
 * A text input over a filtered suggestion list (branch pickers, the create
 * form's model and branch fields). The parent owns the query, the items and
 * what a selection does.
 *
 * Filters on label and value, so a model matches "opus" or "claude-opus".
 * ↑/↓ move a highlight and Enter picks it; with nothing highlighted Enter
 * bubbles, so the create form can submit. `autoHighlight` highlights the
 * first row on typing. Only items can be picked, never free text. Escape
 * with the list open calls `onDismiss` and stops there, so a surrounding
 * dialog stays open.
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
  const [highlight, setHighlight] = useState(-1)
  const needle = query.trim().toLowerCase()
  const rows = items
    .filter((i) => i.label.toLowerCase().includes(needle) || i.value.toLowerCase().includes(needle))
    .slice(0, limit)
  const shown = showList && rows.length > 0
  const active = shown && highlight < rows.length ? highlight : -1

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape' && showList && onDismiss !== undefined) {
      e.preventDefault()
      e.stopPropagation()
      onDismiss()
      return
    }
    if (!shown) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setHighlight((h) => (Math.max(h, -1) + step + rows.length) % rows.length)
    } else if (e.key === 'Enter' && active >= 0 && !e.nativeEvent.isComposing) {
      // Keep the surrounding form from also submitting.
      e.preventDefault()
      e.stopPropagation()
      onSelect(rows[active].value)
    }
  }

  return (
    <>
      <div className={clsx('flex items-center', className)}>
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
      </div>
      {showList && rows.length === 0 && needle !== '' && (
        <div className="px-2 py-1 text-[11px] text-text-faint">No matches</div>
      )}
      {shown && (
        <ul className="max-h-48 overflow-y-auto pb-1">
          {rows.map((item, i) => (
            <li key={item.value}>
              <button
                type="button"
                onClick={() => onSelect(item.value)}
                // Keep focus in the input so a blur cannot close the list
                // mid-click.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHighlight(i)}
                aria-selected={i === active}
                className={clsx(
                  'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left font-mono text-xs outline-none',
                  i === active ? 'bg-surface-3 text-text' : 'text-text-dim hover:bg-surface-3 hover:text-text',
                )}
              >
                {icon?.({ size: 11, className: 'shrink-0 text-text-faint' })}
                {/* The label keeps its width; the detail truncates and pushes
                    the tag to the right edge. */}
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
