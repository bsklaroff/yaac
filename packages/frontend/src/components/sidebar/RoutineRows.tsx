import { useState, type JSX } from 'react'
import { RoutineIcon } from '#lib/icons'
import type { ObjectRowProps } from '#components/sidebar/ObjectRow'
import { api } from '#lib/api'
import { clip } from '#lib/queued'
import { describeSchedule } from '#lib/routines'
import { useUiStore } from '#lib/store'
import { timeUntil, useNow, useTimeZone } from '#lib/time'
import { formatInZone } from '@yaac/shared/schedule'
import type { RoutineEntry } from '@yaac/shared/types'
import { YConfirm } from '#ui'

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
      <YConfirm
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

/**
 * A routine's sidebar row (docs/routines.md): its schedule in words and its
 * next run, or Paused. A red mark carries the error of a run that failed
 * to launch.
 */
export function useRoutineRow(routine: RoutineEntry): ObjectRowProps {
  const zone = useTimeZone()
  const now = useNow()
  const actions = useRoutineActions(routine)
  const failure = actions.error ?? routine.lastError
  const next = routine.nextRuns[0]
  const schedule = describeSchedule(routine.cron)
  return {
    icon: RoutineIcon,
    name: routine.name,
    detail: (
      <>
        <span className="truncate" title={`${schedule} (${routine.timeZone})`}>{schedule}</span>
        {routine.paused
          ? <span className="ml-auto shrink-0 rounded bg-line-strong px-1 text-xs">Paused</span>
          : next !== undefined && (
            <span className="ml-auto shrink-0" title={`${formatInZone(new Date(next), zone)} ${zone}`}>
              in ~{timeUntil(next, now)}
            </span>
          )}
      </>
    ),
    object: { kind: 'routine', id: routine.id },
    projectId: routine.projectId,
    items: [
      { label: 'Run now', onSelect: actions.run },
      { label: routine.paused ? 'Resume' : 'Pause', onSelect: () => actions.setPaused(!routine.paused) },
      { label: 'Edit…', onSelect: actions.edit },
      'separator',
      { label: 'Delete…', onSelect: actions.remove },
    ],
    action: { label: 'Run now', onClick: actions.run },
    ...(failure !== undefined ? { failure } : {}),
    dialogs: actions.dialog,
  }
}
