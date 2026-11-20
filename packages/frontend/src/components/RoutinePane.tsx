import { useState, type JSX, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import { ContainerlessBadge } from '#components/ContainerlessBadge'
import { useRoutineActions } from '#components/sidebar/RoutineRows'
import { agentLabel } from '#lib/agentLabel'
import { api } from '#lib/api'
import { MoreIcon, RoutineIcon } from '#lib/icons'
import { describeSchedule } from '#lib/routines'
import { useSnapshotSelect } from '#lib/useSnapshot'
import { useUiStore } from '#lib/store'
import { timeUntil, useNow, useTimeZone } from '#lib/time'
import { describeWorkspaceDeathReason } from '@yaac/shared/death-reason'
import { formatDuration, formatInZone } from '@yaac/shared/schedule'
import { PERMISSION_MODE_COPY, effortLabel, type RoutineEntry, type RoutineRunEntry } from '@yaac/shared/types'
import {
  cn, YBadge, YButton, YEmptyState, YListRow, YMenu, YMenuItem, YMenuPopup, YPageBody, YSection, YSettingGroup, YSettingRow, YStatus,
  type YStatusKind,
} from '#ui'

/**
 * A routine in the main pane (docs/routines.md), opened from its sidebar
 * row or a run's header. The bar holds its name, Pause or Resume, Run now,
 * and Edit and Delete. The body shows its schedule in words over its cron
 * (unless the words are only the cron), its next runs (in the routine's own
 * zone, which its schedule is written in), what each run is started with,
 * and its runs newest first, each opening its workspace.
 */
export function RoutinePane({ routine, bar }: {
  routine: RoutineEntry
  /** The header element to render the name and controls into. */
  bar: HTMLElement | null
}): JSX.Element {
  const actions = useRoutineActions(routine)
  const [promptOpen, setPromptOpen] = useState(false)
  const group = useSnapshotSelect((s) => s?.workspaceGroups.find((g) => g.groupId === routine.groupId))
  const project = useSnapshotSelect((s) => s?.projects.find((p) => p.id === routine.projectId))
  const schedule = describeSchedule(routine.cron)

  return (
    <div className="flex h-full flex-col bg-surface">
      {bar !== null && createPortal(
        <>
          <span className="titlebar-drag flex min-w-0 flex-1 items-center gap-1.5">
            <RoutineIcon size={12} className="shrink-0 text-subtle" />
            <h2 className="min-w-0 truncate font-medium text-text">{routine.name}</h2>
            {actions.error !== null && <span className="truncate text-danger" title={actions.error}>{actions.error}</span>}
          </span>
          <ContainerlessBadge />
          <YButton
            variant="ghost"
            size="sm"
            onClick={() => actions.setPaused(!routine.paused)}
            title={routine.paused ? 'Resume its schedule' : 'Stop starting runs until resumed'}
            className="no-drag"
          >
            {routine.paused ? 'Resume' : 'Pause'}
          </YButton>
          <YButton variant="ghost" size="sm" onClick={actions.run} title="Start a run now, outside the schedule" className="no-drag">
            Run now
          </YButton>
          <YMenu.Root>
            <YMenu.Trigger
              render={<YButton variant="ghost" size="sm" icon={MoreIcon} aria-label="Routine actions" title="Routine actions" className="no-drag" />}
            />
            <YMenuPopup side="bottom" align="end" sideOffset={4} className="min-w-[140px]">
              <YMenuItem onClick={actions.edit}>Edit…</YMenuItem>
              <YMenuItem onClick={actions.remove}>Delete…</YMenuItem>
            </YMenuPopup>
          </YMenu.Root>
          {actions.dialog}
        </>,
        bar,
      )}
      <YPageBody>
        <YSection title="Schedule">
          <YSettingGroup>
            <Fact label={schedule} hint={schedule !== routine.cron && <span className="font-mono">{routine.cron}</span>}>
              {routine.timeZone}
            </Fact>
            <YSettingRow label="Next runs">
              {routine.paused ? <YBadge tone="warning">Paused</YBadge>
                : <span className="text-md text-muted">{routine.nextRuns.map((r) => formatInZone(new Date(r), routine.timeZone)).join(', ')}</span>}
            </YSettingRow>
            {routine.lastError !== undefined && (
              <YSettingRow label="Last run failed" hint={<span className="text-danger">{routine.lastError}</span>} />
            )}
          </YSettingGroup>
        </YSection>

        <YSection title="Settings" description="What each run starts with.">
          <YSettingGroup>
            <Fact label="Agent">{agentLabel(routine.tool, routine)}</Fact>
            <Fact label="UI">{routine.mode === 'acp' ? 'Chat' : 'Terminal'}</Fact>
            <Fact label="Permissions">{PERMISSION_MODE_COPY[routine.permissionMode]}</Fact>
            {routine.effort !== undefined && <Fact label="Effort">{effortLabel(routine.effort)}</Fact>}
            {routine.selection.repos.length === 0 && <Fact label="Repos">None</Fact>}
            {routine.selection.repos.map((r) => {
              const dir = project?.repos.find((p) => p.id === r.repo)?.dir ?? r.repo.slice(0, 8)
              const at = r.commit !== undefined ? <span className="font-mono">{r.commit.slice(0, 12)}</span> : r.branch
              return routine.selection.repos.length === 1
                ? <Fact key={r.repo} label={r.commit !== undefined ? 'Commit' : 'Base branch'}>{at}</Fact>
                : <Fact key={r.repo} label={<span className="font-mono">{dir}</span>}>{at}</Fact>
            })}
            <Fact label="Group">{group?.name ?? 'None'}</Fact>
            <Fact label="Stops">
              {routine.timeoutMinutes !== undefined ? `after ${formatDuration(routine.timeoutMinutes)}` : 'at the next run'}
            </Fact>
            <YSettingRow label="Prompt" stacked>
              <p className={cn('whitespace-pre-wrap break-words text-md text-muted', !promptOpen && 'line-clamp-4')}>
                {routine.prompt ?? '(non-interactive)'}
              </p>
              {(routine.prompt ?? '').split('\n').length > 4 || (routine.prompt ?? '').length > 300 ? (
                <YButton variant="link" onClick={() => setPromptOpen(!promptOpen)} className="mt-1 text-sm">
                  {promptOpen ? 'Show less' : 'Show all'}
                </YButton>
              ) : null}
            </YSettingRow>
          </YSettingGroup>
        </YSection>

        <YSection title="Runs" description="Newest first. Each opens its workspace.">
          <RoutineRuns routine={routine} />
        </YSection>
      </YPageBody>
    </div>
  )
}

/** A read-only setting: its name, and its value on the right. */
function Fact({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }): JSX.Element {
  return <YSettingRow label={label} hint={hint}><span className="text-md text-muted">{children}</span></YSettingRow>
}

/**
 * A routine's runs, newest first, a page at a time. They are not in the
 * snapshot, so a version built from the routine's workspaces and entries
 * there refetches them whenever a run starts, stops or fails.
 */
function RoutineRuns({ routine }: { routine: RoutineEntry }): JSX.Element {
  const openWorkspace = useUiStore((s) => s.openWorkspace)
  const zone = useTimeZone()
  const now = useNow()
  const version = useSnapshotSelect((s) => [
    routine.lastRunAt, routine.lastError,
    ...(s?.workspaces ?? []).filter((w) => w.routineId === routine.id).map((w) => `${w.workspaceId}:${w.deadline}`),
    ...(s?.queuedWorkspaces ?? []).filter((e) => e.routineId === routine.id).map((e) => `${e.id}:${e.launchError}`),
  ].join(','))
  const runs = useInfiniteQuery({
    queryKey: ['routine-runs', routine.id, version],
    queryFn: ({ pageParam }) => api.routine.runs.$get({ query: { id: routine.id, ...(pageParam ? { cursor: pageParam } : {}) } }),
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  })
  const entries = runs.data?.pages.flatMap((p) => p.runs) ?? []

  if (runs.isError) return <p className="text-md text-danger">Runs could not be loaded: {runs.error.message}</p>
  if (runs.isPending) return <p className="text-md text-subtle">Loading…</p>
  if (entries.length === 0) return <YEmptyState compact title="No runs yet" className="py-4" />
  return (
    <div className="flex flex-col items-start gap-2">
      <div className="w-full border-t border-line">
        {entries.map((run) => {
          const when = run.startAt !== undefined ? formatInZone(new Date(run.startAt), zone) : '—'
          const workspaceId = run.workspaceId
          return (
            <YListRow
              key={run.id}
              label={`Open the run of ${when}`}
              {...(workspaceId !== undefined ? { onSelect: () => openWorkspace(routine.projectId, workspaceId) } : {})}
              leading={<>
                <YStatus kind={RUN_STATUS[run.state]} className="ml-1.5" />
                <span className="w-28 shrink-0 text-md text-subtle">{when}</span>
              </>}
              title={run.title ?? routine.name}
              sub={runState(run, now)}
            />
          )
        })}
      </div>
      {runs.hasNextPage && (
        <YButton variant="ghost" size="sm" onClick={() => void runs.fetchNextPage()} disabled={runs.isFetchingNextPage}>
          {runs.isFetchingNextPage ? 'Loading…' : 'Show older runs'}
        </YButton>
      )}
    </div>
  )
}

const RUN_STATUS: Record<RoutineRunEntry['state'], YStatusKind> = {
  running: 'work', stopped: 'stop', ended: 'done', 'timed-out': 'stop', died: 'fail', failed: 'fail',
  'awaiting-approval': 'need', waiting: 'later',
}

/** What became of a run, in words. */
function runState(run: RoutineRunEntry, now: number): ReactNode {
  switch (run.state) {
    case 'running': return run.deadline !== undefined ? `stops in ${timeUntil(run.deadline, now)}` : 'running'
    case 'stopped': return 'stopped'
    case 'ended': return 'ended at next run'
    case 'timed-out': return 'timed out'
    case 'died': return `died: ${run.deathReason !== undefined ? describeWorkspaceDeathReason(run.deathReason) : 'unknown'}`
    case 'failed': return <span className="text-danger">failed: {run.launchError}</span>
    case 'awaiting-approval': return <span className="text-warning">awaiting approval: review it from its menu in the sidebar</span>
    case 'waiting': return 'waiting'
  }
}
