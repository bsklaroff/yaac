import { useState, type JSX, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import { Menu } from '@base-ui/react/menu'
import { ContainerlessBadge } from '#components/ContainerlessBadge'
import { useRoutineActions } from '#components/sidebar/RoutineRows'
import { MENU_ITEM, MenuPopup } from '#components/ui/menu'
import { agentLabel } from '#lib/agentLabel'
import { api } from '#lib/api'
import { MoreIcon, RoutineIcon } from '#lib/icons'
import { describeSchedule } from '#lib/routines'
import { useSnapshot } from '#lib/useSnapshot'
import { useUiStore } from '#lib/store'
import { timeUntil, useNow, useTimeZone } from '#lib/time'
import { describeWorkspaceDeathReason } from '@yaac/shared/death-reason'
import { formatDuration, formatInZone } from '@yaac/shared/schedule'
import { PERMISSION_MODE_COPY, effortLabel, type RoutineEntry, type RoutineRunEntry } from '@yaac/shared/types'

const BAR_BUTTON = 'no-drag flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] text-text-dim '
  + 'transition hover:bg-surface-2 hover:text-text'

/**
 * A routine in the main pane (docs/routines.md), opened from its sidebar
 * row or a run's header. The bar holds its name, a Paused toggle, Run now,
 * and Edit and Delete. The body shows its schedule and next runs (in the
 * routine's own zone, which its schedule is written in), what each run is
 * started with, and its runs newest first, each opening its workspace.
 */
export function RoutinePane({ routine, bar }: {
  routine: RoutineEntry
  /** The header element to render the name and controls into. */
  bar: HTMLElement | null
}): JSX.Element {
  const snapshot = useSnapshot()
  const actions = useRoutineActions(routine)
  const [promptOpen, setPromptOpen] = useState(false)
  const group = snapshot?.workspaceGroups.find((g) => g.groupId === routine.groupId)

  return (
    <div className="h-full overflow-y-auto bg-bg px-4 py-4">
      {bar !== null && createPortal(
        <>
          <span className="titlebar-drag flex min-w-0 flex-1 items-center gap-1.5">
            <RoutineIcon size={12} className="shrink-0 text-text-faint" />
            <h2 className="min-w-0 truncate font-medium text-text">{routine.name}</h2>
            {actions.error !== null && <span className="truncate text-danger" title={actions.error}>{actions.error}</span>}
          </span>
          <ContainerlessBadge />
          <button
            type="button"
            aria-pressed={routine.paused}
            onClick={() => actions.setPaused(!routine.paused)}
            title={routine.paused ? 'Resume its schedule' : 'Stop starting runs until resumed'}
            className={clsx(BAR_BUTTON, routine.paused && 'bg-surface-3 text-text')}
          >
            Paused
          </button>
          <button type="button" onClick={actions.run} title="Start a run now, outside the schedule" className={BAR_BUTTON}>
            Run now
          </button>
          <Menu.Root>
            <Menu.Trigger aria-label="Routine actions" title="Routine actions" className={BAR_BUTTON}>
              <MoreIcon size={14} />
            </Menu.Trigger>
            <MenuPopup side="bottom" align="end" sideOffset={4} className="min-w-[140px]">
              <Menu.Item className={MENU_ITEM} onClick={actions.edit}>Edit…</Menu.Item>
              <Menu.Item className={MENU_ITEM} onClick={actions.remove}>Delete…</Menu.Item>
            </MenuPopup>
          </Menu.Root>
          {actions.dialog}
        </>,
        bar,
      )}
      <div className="mx-auto flex max-w-xl flex-col gap-5 text-xs">
        <Section title="Schedule">
          <p className="text-text">{describeSchedule(routine.cron)} <span className="text-text-faint">· {routine.timeZone}</span></p>
          <p className="text-text-dim">
            {routine.paused ? 'Paused'
              : `Next: ${routine.nextRuns.map((r) => formatInZone(new Date(r), routine.timeZone)).join(' · ')}`}
          </p>
          {routine.lastError !== undefined && <p className="text-danger">Last run failed: {routine.lastError}</p>}
        </Section>

        <Section title="Settings">
          <dl className="grid grid-cols-[96px_1fr] gap-x-2 gap-y-1">
            <Fact label="Agent">{agentLabel(routine.tool, routine)}</Fact>
            <Fact label="UI">{routine.mode === 'acp' ? 'Chat' : 'Terminal'}</Fact>
            <Fact label="Permissions">{PERMISSION_MODE_COPY[routine.permissionMode]}</Fact>
            {routine.effort !== undefined && <Fact label="Effort">{effortLabel(routine.effort)}</Fact>}
            <Fact label="Base branch">{routine.branch}</Fact>
            <Fact label="Group">{group?.name ?? 'None'}</Fact>
            <Fact label="Stops">
              {routine.timeoutMinutes !== undefined ? `after ${formatDuration(routine.timeoutMinutes)}` : 'at the next run'}
            </Fact>
          </dl>
          <p className={clsx('mt-2 whitespace-pre-wrap break-words text-text-dim', !promptOpen && 'line-clamp-4')}>
            {routine.prompt}
          </p>
          {routine.prompt.split('\n').length > 4 || routine.prompt.length > 300 ? (
            <button type="button" onClick={() => setPromptOpen(!promptOpen)} className="self-start text-text-faint underline hover:text-text-dim">
              {promptOpen ? 'Show less' : 'Show all'}
            </button>
          ) : null}
        </Section>

        <Section title="Runs">
          <RoutineRuns routine={routine} />
        </Section>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-text-faint">{title}</h3>
      {children}
    </section>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <>
      <dt className="text-text-faint">{label}</dt>
      <dd className="min-w-0 truncate text-text-dim">{children}</dd>
    </>
  )
}

/**
 * A routine's runs, newest first, a page at a time. They are not in the
 * snapshot, so a version built from the routine's workspaces and entries
 * there refetches them whenever a run starts, stops or fails.
 */
function RoutineRuns({ routine }: { routine: RoutineEntry }): JSX.Element {
  const snapshot = useSnapshot()
  const openWorkspace = useUiStore((s) => s.openWorkspace)
  const zone = useTimeZone()
  const now = useNow()
  const version = [
    routine.lastRunAt, routine.lastError,
    ...(snapshot?.workspaces ?? []).filter((w) => w.routineId === routine.id).map((w) => `${w.workspaceId}:${w.deadline}`),
    ...(snapshot?.queuedWorkspaces ?? []).filter((e) => e.routineId === routine.id).map((e) => `${e.id}:${e.launchError}`),
  ].join(',')
  const runs = useInfiniteQuery({
    queryKey: ['routine-runs', routine.id, version],
    queryFn: ({ pageParam }) => api.routine.runs.$get({ query: { id: routine.id, ...(pageParam ? { cursor: pageParam } : {}) } }),
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  })
  const entries = runs.data?.pages.flatMap((p) => p.runs) ?? []

  const state = (run: RoutineRunEntry): ReactNode => {
    switch (run.state) {
      case 'running': return run.deadline !== undefined ? `stops in ${timeUntil(run.deadline, now)}` : 'running'
      case 'stopped': return 'stopped'
      case 'timed-out': return 'timed out'
      case 'died': return `died: ${run.deathReason !== undefined ? describeWorkspaceDeathReason(run.deathReason) : 'unknown'}`
      case 'failed': return <span className="text-danger">failed: {run.launchError}</span>
      case 'waiting': return 'waiting'
    }
  }

  if (runs.isError) return <p className="text-danger">Runs could not be loaded: {runs.error.message}</p>
  if (runs.isPending) return <p className="text-text-faint">Loading…</p>
  if (entries.length === 0) return <p className="text-text-faint">No runs yet.</p>
  return (
    <>
      <ul className="flex flex-col">
        {entries.map((run) => (
          <li key={run.id}>
            <button
              type="button"
              disabled={run.workspaceId === undefined}
              onClick={() => { if (run.workspaceId !== undefined) openWorkspace(routine.projectId, run.workspaceId) }}
              className="flex w-full items-center gap-3 rounded-md px-1.5 py-1 text-left transition enabled:hover:bg-surface-2"
            >
              <span className="w-28 shrink-0 text-text-faint">
                {run.startAt !== undefined ? formatInZone(new Date(run.startAt), zone) : '—'}
              </span>
              <span className="min-w-0 flex-1 truncate text-text-dim">{run.title ?? routine.name}</span>
              <span className="shrink-0 text-text-faint">{state(run)}</span>
            </button>
          </li>
        ))}
      </ul>
      {runs.hasNextPage && (
        <button
          type="button"
          onClick={() => void runs.fetchNextPage()}
          disabled={runs.isFetchingNextPage}
          className="self-start text-text-faint underline hover:text-text-dim"
        >
          {runs.isFetchingNextPage ? 'Loading…' : 'Show older runs'}
        </button>
      )}
    </>
  )
}
