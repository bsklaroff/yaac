import { type JSX, type ReactNode } from 'react'
import { BranchIcon } from '#lib/icons'
import { Typeahead } from '#components/ui/Typeahead'

/**
 * The branch typeahead shared by the new-worktree popover, the Changes-view
 * base picker and the skills picker: `Typeahead` over branch names, each row
 * a branch glyph and the default branch tagged. The parent owns the `query`
 * text, the branch list, and what a selection does; typed text is a valid
 * branch as-is, so nothing is highlighted until an arrow key asks for it.
 */
export function BranchPicker({
  branches,
  defaultBranch,
  ...rest
}: {
  /** Full branch list; filtering by `query` happens here. */
  branches: string[]
  /** Branch that gets a "default" tag in the list. */
  defaultBranch?: string
  /** Text shown in the input (parent-controlled). */
  query: string
  onQueryChange: (query: string) => void
  /** A suggestion row was picked. */
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
  return (
    <Typeahead
      {...rest}
      items={branches.map((b) => ({ value: b, label: b }))}
      icon={(p) => <BranchIcon {...p} />}
      tag={(item) => item.value === defaultBranch && <span>default</span>}
    />
  )
}
