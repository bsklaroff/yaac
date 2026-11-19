import { useState, type JSX } from 'react'
import clsx from 'clsx'
import { api } from '#lib/api'
import { ErrorBoundary } from '#components/ErrorBoundary'
import { StepLog } from '#components/StepLog'
import { WorkspaceTerminal } from '#components/WorkspaceTerminal'
import { RestartIcon, StopIcon } from '#lib/icons'
import { isLocked, stepLive, stepLogFile } from '#lib/steps'
import { useReadOnly } from '#lib/viewer'
import { stepSettled, type WorkspaceStep } from '@yaac/shared/steps'
import type { WorkspaceListEntry } from '@yaac/shared/types'
import { YButton } from '#ui'

/** A step's state as a short line: `failed (exit 2)`. */
export function stepStateText(step: Pick<WorkspaceStep, 'state' | 'exitCode'>): string {
  return step.exitCode !== undefined && step.state === 'failed' ? `failed (exit ${step.exitCode})` : step.state
}

/**
 * One step's pane (docs/workspace-steps.md): its state, a rerun or cancel
 * (not on a locked workspace, which nothing may change), and below, while
 * it runs in a workspace that is not locked, its live window, else
 * its log, followed while it can still grow. It stays open when its step
 * finishes, until it is closed.
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
      <div className="min-h-0 flex-1 px-2.5 py-1.5">
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
      </div>
    </div>
  )
}
