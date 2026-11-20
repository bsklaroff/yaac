import type { JSX, ReactNode } from 'react'
import clsx from 'clsx'
import { ChevronIcon, RunIcon, type Icon } from '#lib/icons'
import type { RowMenuItem } from '#components/sidebar/RowMenu'
import { SidebarRow } from '#components/sidebar/SidebarRow'
import { useUiStore, type SelectedObject } from '#lib/store'
import { useReadOnly } from '#lib/viewer'
import { YButton } from '#ui'

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
 * nest under it, and the header counts them as a group's does
 * (docs/workspace-groups.md "Owned groups"). Its icon turns into the caret
 * that shows or hides them while the row is hovered or keyboard-focused, or
 * the runs are shown; on touch, tapping the icon toggles them. The caret
 * takes the icon's place rather than a column of its own, so it never sits
 * left of its section's caret.
 */
export function ObjectRow({ icon: RowIcon, name, detail, object, projectId, items, action, failure, dialogs, runs }: ObjectRowProps & {
  runs?: ObjectRuns
}): JSX.Element {
  const selected = useUiStore((s) => s.selectedObject?.kind === object.kind && s.selectedObject.id === object.id)
  const openObject = useUiStore((s) => s.openObject)
  const readOnly = useReadOnly()
  return (
    <>
      <SidebarRow
        label={name}
        onSelect={readOnly && object.kind === 'routine' ? undefined : () => openObject(projectId, object)}
        selected={selected}
        className="pl-4"
        mark={runs !== undefined ? (
          <YButton
            variant="bare"
            onClick={() => runs.onToggle(!runs.expanded)}
            aria-label={runs.expanded ? `Hide ${name}'s runs` : `Show ${name}'s runs`}
            aria-expanded={runs.expanded}
            className="pointer-events-auto flex size-3.5 items-center justify-center text-subtle transition hover:text-text"
          >
            <RowIcon size={11} className={runs.expanded ? 'hidden' : 'group-hover/row:hidden group-has-focus-visible/row:hidden'} />
            <ChevronIcon
              size={11}
              className={clsx('transition-transform', runs.expanded ? 'rotate-90' : 'hidden group-hover/row:block group-has-focus-visible/row:block')}
            />
          </YButton>
        ) : <RowIcon size={11} className="text-subtle" />}
        title={name}
        trailing={(
          <>
            {failure !== undefined && (
              <span role="img" aria-label={`Last run failed: ${failure}`} title={failure} className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
            )}
            {runs !== undefined && (runs.live > 0 || runs.limit !== undefined) && (
              <span
                className={clsx('shrink-0', runs.limit !== undefined && runs.live >= runs.limit ? 'text-warning/80' : 'text-subtle/70')}
                title={runs.limit !== undefined ? `${runs.live} running of a limit of ${runs.limit}` : `${runs.live} running`}
              >
                ({runs.live}{runs.limit !== undefined && `/${runs.limit}`})
              </span>
            )}
            {runs !== undefined && runs.died > 0 && <span className="shrink-0 text-danger">{runs.died} died</span>}
          </>
        )}
        meta={detail}
        actions={action !== undefined && !readOnly && (
          <YButton
            variant="ghost"
            size="sm"
            icon={RunIcon}
            onClick={action.onClick}
            title={action.label}
            aria-label={`${action.label}: ${name}`}
            className="max-md:size-7"
          />
        )}
        menu={{ label: `${KIND_LABEL[object.kind]} actions`, items }}
      />
      {dialogs}
    </>
  )
}
