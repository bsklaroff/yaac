import type { JSX, ReactNode } from 'react'
import clsx from 'clsx'
import { ChevronIcon, RunIcon, type Icon } from '#lib/icons'
import { RowMenu, type RowMenuItem } from '#components/sidebar/RowMenu'
import { useUiStore, type SelectedObject } from '#lib/store'
import { useReadOnly } from '#lib/viewer'

const KIND_LABEL: Record<SelectedObject['kind'], string> = { routine: 'Routine', workflow: 'Workflow', site: 'Site' }

/** The runs under an object's row: its owned group's counts, and the caret
 *  that shows or hides them (`GroupSection`). */
export interface ObjectRuns {
  expanded: boolean
  onToggle: (open: boolean) => void
  live: number
  limit?: number
  stopped: number
  died: number
}

/** What an object row shows and does, before its group adds the runs. */
export interface ObjectRowProps {
  icon: Icon
  name: string
  /** The second line: its schedule, state or repos. */
  detail: ReactNode
  /** The pane this row opens. */
  object: SelectedObject
  projectId: string
  items: RowMenuItem[]
  /** A one-click action shown on hover, left of the menu. */
  action?: { label: string; onClick: () => void }
  /** Why its last run or deploy failed. */
  failure?: string
  /** Dialogs its actions open. */
  dialogs?: ReactNode
}

/**
 * A named workflow, routine or site in the sidebar: its name and a line of
 * state, opening its pane on click. With `runs` its owned group's runs
 * nest under it, shown and hidden by the caret, and the header counts them
 * as a group's does (docs/workspace-groups.md "Owned groups").
 */
export function ObjectRow({ icon: RowIcon, name, detail, object, projectId, items, action, failure, dialogs, runs }: ObjectRowProps & {
  runs?: ObjectRuns
}): JSX.Element {
  const selected = useUiStore((s) => s.selectedObject?.kind === object.kind && s.selectedObject.id === object.id)
  const openObject = useUiStore((s) => s.openObject)
  const readOnly = useReadOnly()
  return (
    <div className="group relative mx-2">
      {runs !== undefined && (
        <button
          type="button"
          onClick={() => runs.onToggle(!runs.expanded)}
          aria-label={runs.expanded ? `Hide ${name}'s runs` : `Show ${name}'s runs`}
          aria-expanded={runs.expanded}
          className="absolute left-0 top-1.5 flex h-5 w-4 items-center justify-center text-text-faint transition hover:text-text"
        >
          <ChevronIcon size={11} className={clsx('transition-transform', runs.expanded && 'rotate-90')} />
        </button>
      )}
      <button
        type="button"
        onClick={() => openObject(projectId, object)}
        disabled={readOnly && object.kind === 'routine'}
        className={clsx('flex w-full flex-col gap-0.5 rounded-lg py-1.5 pl-4 pr-2.5 text-left text-sm transition',
          selected ? 'bg-surface-2' : 'hover:bg-surface-2/60')}
      >
        <span className={clsx('flex items-center gap-2 max-md:pr-16', action !== undefined ? 'group-hover:pr-14' : 'group-hover:pr-8')}>
          <RowIcon size={11} className="shrink-0 text-text-faint" />
          <span className="truncate text-text-dim">{name}</span>
          {failure !== undefined && (
            <span role="img" aria-label={`Last run failed: ${failure}`} title={failure} className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
          )}
          {runs !== undefined && (runs.live > 0 || runs.limit !== undefined) && (
            <span
              className={clsx('shrink-0 text-xs', runs.limit !== undefined && runs.live >= runs.limit ? 'text-amber-400/80' : 'text-text-faint/70')}
              title={runs.limit !== undefined ? `${runs.live} running of a limit of ${runs.limit}` : `${runs.live} running`}
            >
              ({runs.live}{runs.limit !== undefined && `/${runs.limit}`})
            </span>
          )}
          {runs !== undefined && runs.died > 0 && <span className="shrink-0 text-xs text-danger">· {runs.died} died</span>}
        </span>
        <span className="flex items-center gap-2 text-xs text-text-faint">{detail}</span>
      </button>
      {action !== undefined && !readOnly && (
        <button
          type="button"
          onClick={action.onClick}
          title={action.label}
          aria-label={`${action.label}: ${name}`}
          className="pointer-events-none absolute right-8 top-2 flex h-5 w-5 items-center justify-center rounded text-text-faint
            opacity-0 transition hover:bg-surface-3 hover:text-accent group-hover:pointer-events-auto group-hover:opacity-100
            focus-visible:pointer-events-auto focus-visible:opacity-100 max-md:pointer-events-auto max-md:right-10 max-md:h-7
            max-md:w-7 max-md:opacity-100"
        >
          <RunIcon size={12} />
        </button>
      )}
      <RowMenu label={`${KIND_LABEL[object.kind]} actions`} items={items} />
      {dialogs}
    </div>
  )
}
