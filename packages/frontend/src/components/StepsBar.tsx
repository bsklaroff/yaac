import { useState, type JSX } from 'react'
import clsx from 'clsx'
import { foldSteps } from '#lib/steps'
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
 * The workspace bar's steps (docs/workspace-steps.md): each step still
 * pending or running, and each that failed or was cancelled, on its own;
 * the ones that succeeded or were skipped folded into "N done", which
 * expands on a click. A step's pane opens only when it is picked.
 */
export function StepsBar({ workspace }: { workspace: WorkspaceListEntry }): JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const openStep = useUiStore((s) => s.openStep)
  const steps = workspace.steps ?? []
  if (steps.length === 0) return null
  const { shown, done } = foldSteps(steps)
  const chip = (s: typeof steps[number]): JSX.Element => (
    <button
      key={s.name}
      type="button"
      onClick={() => openStep(workspace.workspaceId, s.name)}
      title={`${s.name}: ${stepStateText(s)}`}
      className={CHIP}
    >
      <span aria-hidden="true" className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', DOT[s.state])} />
      <span className={clsx('max-w-32 truncate font-mono', s.state === 'skipped' && 'line-through')}>{s.name}</span>
      {s.state === 'failed' && s.exitCode !== undefined && <span className="text-danger">{s.exitCode}</span>}
    </button>
  )
  return (
    <div className="flex min-w-0 shrink items-center gap-0.5 overflow-x-auto" aria-label="Steps">
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
