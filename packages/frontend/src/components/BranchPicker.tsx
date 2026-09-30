import { type ComponentProps, type JSX } from 'react'
import { BranchIcon } from '#lib/icons'
import { Typeahead } from '#components/ui/Typeahead'

/**
 * `Typeahead` over branch names, with the default branch tagged. The parent
 * owns the query text, the branch list and what a selection does.
 */
export function BranchPicker({
  branches,
  defaultBranch,
  ...rest
}: Omit<ComponentProps<typeof Typeahead>, 'items' | 'icon' | 'tag'> & {
  /** Full branch list; filtering by `query` happens in the typeahead. */
  branches: string[]
  /** Branch that gets a "default" tag in the list. */
  defaultBranch?: string
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
