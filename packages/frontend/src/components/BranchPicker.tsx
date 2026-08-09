import { type JSX, type ReactNode } from 'react'
import clsx from 'clsx'
import { BranchIcon } from '#lib/icons'

/**
 * The branch typeahead shared by the new-worktree popover and the Changes-view
 * base picker: a bordered text input over a filtered suggestion list. Purely
 * presentational — the parent owns the `query` text, the branch list, and what
 * a selection does. `trailing` / `belowInput` are slots for caller-specific
 * chrome (e.g. the new-worktree "pin as default" button and its error line),
 * kept in the same DOM order the inline markup used to have.
 */
export function BranchPicker({
  branches,
  defaultBranch,
  query,
  onQueryChange,
  onSelect,
  showList,
  placeholder,
  ariaLabel,
  limit = 8,
  className,
  trailing,
  belowInput,
}: {
  /** Full branch list; filtering by `query` happens here. */
  branches: string[]
  /** Branch that gets a "default" tag in the list. */
  defaultBranch?: string
  /** Text shown in the input (parent-controlled). */
  query: string
  onQueryChange: (query: string) => void
  /** A suggestion row was clicked. */
  onSelect: (branch: string) => void
  /** Whether to render the suggestion list at all. */
  showList: boolean
  placeholder?: string
  ariaLabel?: string
  /** Max suggestions shown (default 8). */
  limit?: number
  /** Extra classes on the input row (padding etc.). */
  className?: string
  /** Accessory rendered to the right of the input box. */
  trailing?: ReactNode
  /** Node rendered between the input row and the suggestion list. */
  belowInput?: ReactNode
}): JSX.Element {
  const filtered = branches
    .filter((b) => b.toLowerCase().includes(query.trim().toLowerCase()))
    .slice(0, limit)

  return (
    <>
      <div className={clsx('flex items-center gap-1', className)}>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2 py-1">
          <BranchIcon size={12} className="shrink-0 text-text-faint" />
          <input
            aria-label={ariaLabel}
            value={query}
            placeholder={placeholder}
            onChange={(e) => onQueryChange(e.target.value)}
            spellCheck={false}
            className="w-full min-w-0 bg-transparent font-mono text-xs text-text outline-none
              placeholder:text-text-faint"
          />
        </div>
        {trailing}
      </div>
      {belowInput}
      {showList && filtered.length > 0 && (
        <ul className="max-h-48 overflow-y-auto pb-1">
          {filtered.map((b) => (
            <li key={b}>
              <button
                type="button"
                onClick={() => onSelect(b)}
                className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left font-mono text-xs
                  text-text-dim outline-none hover:bg-surface-3 hover:text-text"
              >
                <BranchIcon size={11} className="shrink-0 text-text-faint" />
                <span className="truncate">{b}</span>
                {b === defaultBranch && (
                  <span className="ml-auto pl-2 text-[10px] text-text-faint">default</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
