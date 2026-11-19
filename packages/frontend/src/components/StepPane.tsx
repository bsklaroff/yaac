import { useState, type JSX, type ReactNode } from 'react'
import clsx from 'clsx'
import { api } from '#lib/api'
import { ErrorBoundary } from '#components/ErrorBoundary'
import { StepLog } from '#components/StepLog'
import { WorkspaceTerminal } from '#components/WorkspaceTerminal'
import { RestartIcon, StopIcon } from '#lib/icons'
import { isLocked, stepLive, stepLogFile, stepShortName } from '#lib/steps'
import { useReadOnly } from '#lib/viewer'
import { stepSettled, type StepGraph, type WorkspaceStep } from '@yaac/shared/steps'
import type { WorkspaceListEntry } from '@yaac/shared/types'
import { YButton } from '#ui'

/** A step's state as a short line: `failed (exit 2)`. */
export function stepStateText(step: Pick<WorkspaceStep, 'state' | 'exitCode'>): string {
  return step.exitCode !== undefined && step.state === 'failed' ? `failed (exit ${step.exitCode})` : step.state
}

/**
 * One step's pane (docs/workspace-steps.md): its state, a rerun or cancel
 * (not on a locked workspace, which nothing may change), its workflow's
 * graph as this life ran it, folded, and below, while it runs in a
 * workspace that is not locked, its live window, else its log, followed
 * while it can still grow. It stays open when its step finishes, until it
 * is closed.
 */
export function StepPane({ workspace, name, visible, focusKey }: {
  workspace: WorkspaceListEntry
  name: string
  visible: boolean
  focusKey?: number
}): JSX.Element {
  const readOnly = useReadOnly()
  const [error, setError] = useState<string | null>(null)
  const step = workspace.steps?.find((s) => s.name === name)
  if (step === undefined) {
    return (
      <p className="flex h-full items-center justify-center bg-sunken text-md text-subtle">
        This run of the workspace has no step “{name}”.
      </p>
    )
  }
  const live = stepLive(step)
  const showWindow = live && step.target !== undefined && !isLocked(workspace)
  const act = (action: 'rerun' | 'cancel'): void => {
    setError(null)
    api.workspace[':id'].steps[':name'][action].$post({ param: { id: workspace.workspaceId, name } })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }
  const { life, file } = stepLogFile(step)
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-md bg-sunken">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line px-2 text-sm">
        <span className="min-w-0 truncate font-mono text-muted" title={step.spec.run.join('\n')}>{name}</span>
        <span className={clsx(step.state === 'failed' ? 'text-danger' : 'text-subtle')}>{stepStateText(step)}</span>
        {error !== null && <span className="min-w-0 truncate text-danger" title={error}>{error}</span>}
        {!readOnly && !isLocked(workspace) && (
          <span className="ml-auto flex items-center">
            {stepSettled(step.state)
              ? <YButton variant="ghost" size="sm" icon={RestartIcon} onClick={() => act('rerun')}>Rerun</YButton>
              : <YButton variant="ghost" size="sm" icon={StopIcon} onClick={() => act('cancel')}>Cancel</YButton>}

          </span>
        )}
      </div>
      <GraphOverLog
        workflow={step.workflow}
        graph={Object.fromEntries((workspace.steps ?? []).filter((s) => s.workflow === step.workflow).map((s) => [stepShortName(s), s.spec]))}
      >
        {showWindow ? (
          <ErrorBoundary key={step.target}>
            <WorkspaceTerminal
              workspaceId={workspace.workspaceId}
              target={step.target ?? ''}
              visible={visible}
              {...(focusKey !== undefined ? { focusKey } : {})}
            />
          </ErrorBoundary>
        ) : (
          <StepLog key={`${life}/${file}`} workspaceId={workspace.workspaceId} life={life} file={file} follow={live} />
        )}
      </GraphOverLog>
    </div>
  )
}

/**
 * A log under its workflow's graph as a life ran it, folded, in the JSON a
 * workflow is written in: the specs its steps ran rather than the named
 * workflow, which may have been edited since. The graph opens at full
 * length and the two scroll together. The log keeps at least three
 * quarters of the height, so with a long graph open some of it stays in
 * view to scroll back up by, since the log takes the wheel for its own
 * scrollback. The log clips what overflows it: xterm's input textarea
 * keeps its place from before a refit until the cursor moves, and would
 * otherwise leave blank space below the log to scroll into.
 */
export function GraphOverLog({ workflow, graph, logClassName, children }: {
  workflow: string
  /** Absent for a window that ran no workflow. */
  graph: StepGraph | undefined
  logClassName?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {graph !== undefined && (
        <details className="shrink-0 border-b border-line text-sm">
          <summary className="cursor-pointer px-2 py-1 text-subtle">{workflow !== '' ? `Workflow ${workflow}` : 'Steps'}</summary>
          <pre className="overflow-x-auto px-2.5 pb-1.5 font-mono text-muted">{JSON.stringify(graph, null, 2)}</pre>
        </details>
      )}
      <div className={clsx('min-h-[75%] flex-1 overflow-hidden px-2.5 py-1.5', logClassName)}>{children}</div>
    </div>
  )
}
