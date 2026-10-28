import { useState, type JSX } from 'react'
import clsx from 'clsx'
import { RoutineIcon } from '#lib/icons'
import { RowMenu, type RowMenuItem } from '#components/sidebar/RowMenu'
import { SidebarSection } from '#components/sidebar/QueuedRows'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import { api } from '#lib/api'
import { clip } from '#lib/queued'
import { describeSchedule } from '#lib/routines'
import { useUiStore } from '#lib/store'
import { timeUntil, useNow, useTimeZone } from '#lib/time'
import { useReadOnly } from '#lib/viewer'
import { formatInZone } from '@yaac/shared/schedule'
import type { RoutineEntry } from '@yaac/shared/types'

/** What can be done to a routine, from its sidebar row or its pane. */
export interface RoutineActions {
  run: () => void
  setPaused: (paused: boolean) => void
  edit: () => void
  /** Ask, then delete. */
  remove: () => void
  /** Why the last action failed. */
  error: string | null
  /** The delete confirmation, to render beside the controls. */
  dialog: JSX.Element
}

/** A routine's actions. Edit reopens the new-workspace pane on it. */
export function useRoutineActions(routine: RoutineEntry): RoutineActions {
  const openNewWorkspace = useUiStore((s) => s.openNewWorkspace)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const act = (op: Promise<unknown>): void => {
    setError(null)
    op.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }
  const json = { json: { id: routine.id } }
  return {
    run: () => act(api.routine.run.$post(json)),
    setPaused: (paused) => act(paused ? api.routine.pause.$post(json) : api.routine.resume.$post(json)),
    edit: () => openNewWorkspace({ projectId: routine.projectId, routineId: routine.id }),
    remove: () => setConfirmDelete(true),
    error,
    dialog: (
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete routine?"
        description={`“${clip(routine.name)}” will start no more runs. Runs already started keep going until their stop time.`}
        onConfirm={() => {
          setConfirmDelete(false)
          act(api.routine.delete.$post(json))
        }}
      />
    ),
  }
}

/** The project's routines, in a collapsible section at the top of the list. */
export function RoutinesSection({ routines }: { routines: RoutineEntry[] }): JSX.Element {
  return (
    <SidebarSection label="Routines" count={routines.length}>
      {routines.map((r) => <RoutineRow key={r.id} routine={r} />)}
    </SidebarSection>
  )
}

/**
 * A routine (docs/routines.md): its name, its schedule in words and its
 * next run, or Paused. A red mark carries the error of a run that failed to
 * launch. Clicking it opens its pane.
 */
function RoutineRow({ routine }: { routine: RoutineEntry }): JSX.Element {
  const selected = useUiStore((s) => s.selectedRoutineId === routine.id)
  const openRoutine = useUiStore((s) => s.openRoutine)
  const readOnly = useReadOnly()
  const zone = useTimeZone()
  const now = useNow()
  const actions = useRoutineActions(routine)
  const failure = actions.error ?? routine.lastError
  const next = routine.nextRuns[0]
  const schedule = describeSchedule(routine.cron)
  const items: RowMenuItem[] = [
    { label: 'Run now', onSelect: actions.run },
    { label: routine.paused ? 'Resume' : 'Pause', onSelect: () => actions.setPaused(!routine.paused) },
    { label: 'Edit…', onSelect: actions.edit },
    'separator',
    { label: 'Delete…', onSelect: actions.remove },
  ]

  return (
    <div className="group relative mx-2">
      <button
        type="button"
        onClick={() => openRoutine(routine.projectId, routine.id)}
        disabled={readOnly}
        className={clsx('flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition',
          selected ? 'bg-surface-2' : 'hover:bg-surface-2/60')}
      >
        <span className="flex items-center gap-2 group-hover:pr-8 max-md:pr-10">
          <RoutineIcon size={11} className="shrink-0 text-text-faint" />
          <span className="truncate text-text-dim">{routine.name}</span>
          {failure !== undefined && (
            <span role="img" aria-label={`Last run failed: ${failure}`} title={failure}
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
          )}
        </span>
        <span className="flex items-center gap-2 text-xs text-text-faint">
          <span className="truncate" title={`${schedule} (${routine.timeZone})`}>{schedule}</span>
          {routine.paused
            ? <span className="ml-auto shrink-0 rounded bg-surface-3 px-1 text-[10px]">Paused</span>
            : next !== undefined && (
              <span className="ml-auto shrink-0" title={`${formatInZone(new Date(next), zone)} ${zone}`}>
                in ~{timeUntil(next, now)}
              </span>
            )}
        </span>
      </button>
      <RowMenu label="Routine actions" items={items} />
      {actions.dialog}
    </div>
  )
}
