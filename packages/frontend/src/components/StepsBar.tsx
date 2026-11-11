import { useState, type JSX } from 'react'
import clsx from 'clsx'
import { byWorkflow, foldSteps, stepShortName } from '#lib/steps'
import { useUiStore } from '#lib/store'
import { stepStateText } from '#components/StepPane'
import type { WorkspaceListEntry } from '@yaac/shared/types'
import type { StepState } from '@yaac/shared/steps'

const DOT: Record<StepState, string> = {
  pending: 'bg-text-faint/40',
  running: 'bg-accent animate-pulse',
  ready: 'bg-accent',
  succeeded: 'bg-success',
  failed: 'bg-danger',
  skipped: 'bg-text-faint/40',
  cancelled: 'bg-warning',
  interrupted: 'bg-warning',
}

const CHIP = 'no-drag flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] text-text-dim transition '
  + 'hover:bg-surface-2 hover:text-text'

/**
 * The workspace bar's steps (docs/workspace-steps.md), grouped under their
 * workflow: each step still pending or running, and each that failed or was
 * cancelled, on its own; the ones that succeeded or were skipped folded
 * into "N done" per workflow, which expands on a click. A step's pane opens
 * only when it is picked.
 */
export function StepsBar({ workspace }: { workspace: WorkspaceListEntry }): JSX.Element | null {
  const steps = workspace.steps ?? []
  if (steps.length === 0) return null
  return (
    <div className="flex min-w-0 shrink items-center gap-1.5 overflow-x-auto" aria-label="Steps">
      {byWorkflow(steps, (s) => s.name).map((g) => (
        <WorkflowSteps key={g.workflow} workspaceId={workspace.workspaceId} workflow={g.workflow} steps={g.items} />
      ))}
    </div>
  )
}

/** One workflow's steps in the workspace bar, under its name. */
function WorkflowSteps({ workspaceId, workflow, steps }: {
  workspaceId: string
  workflow: string
  steps: NonNullable<WorkspaceListEntry['steps']>
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const openStep = useUiStore((s) => s.openStep)
  const { shown, done } = foldSteps(steps)
  const chip = (s: typeof steps[number]): JSX.Element => (
    <button
      key={s.name}
      type="button"
      onClick={() => openStep(workspaceId, s.name)}
      title={`${s.name}: ${stepStateText(s)}`}
      className={CHIP}
    >
      <span aria-hidden="true" className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', DOT[s.state])} />
      <span className={clsx('max-w-32 truncate font-mono', s.state === 'skipped' && 'line-through')}>{stepShortName(s)}</span>
      {s.state === 'failed' && s.exitCode !== undefined && <span className="text-danger">{s.exitCode}</span>}
    </button>
  )
  return (
    <div className="flex shrink-0 items-center gap-0.5" role="group" {...(workflow !== '' ? { 'aria-label': `Workflow ${workflow}` } : {})}>
      {workflow !== '' && <span className="max-w-24 truncate font-mono text-[10px] text-text-faint">{workflow}</span>}
      {shown.map(chip)}
      {done.length > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          title={expanded ? 'Fold the finished steps' : done.map((s) => `${s.name}: ${s.state}`).join('\n')}
          className={clsx(CHIP, 'text-text-faint')}
        >
          <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
          {done.length} done
        </button>
      )}
      {expanded && done.map(chip)}
    </div>
  )
}
