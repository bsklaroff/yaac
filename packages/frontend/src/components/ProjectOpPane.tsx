import type { JSX } from 'react'
import { LoadingIcon } from '#lib/icons'
import { dismissProjectAdd } from '#lib/projectOps'
import { useUiStore, type ProjectOp } from '#lib/store'
import type { GitProgress } from '@yaac/shared/types'
import { YButton } from '#ui'

/** The clone's current phase as git names it, with a bar for a phase that
 *  reports a percentage. */
function CloneProgress({ progress }: { progress: GitProgress }): JSX.Element {
  return (
    <div className="flex w-72 max-w-full flex-col gap-1.5">
      <div className="flex justify-between gap-2 text-md text-muted">
        <span>{progress.phase}</span>
        {progress.percent !== null && <span className="tabular-nums">{progress.percent}%</span>}
      </div>
      {progress.percent !== null && (
        <div
          role="progressbar"
          aria-label={progress.phase}
          aria-valuenow={progress.percent}
          aria-valuemin={0}
          aria-valuemax={100}
          className="h-1 overflow-hidden rounded-full bg-selected"
        >
          <div className="h-full bg-accent transition-[width]" style={{ width: `${progress.percent}%` }} />
        </div>
      )}
      {progress.detail !== undefined && <p className="text-left font-mono text-sm text-subtle">{progress.detail}</p>}
    </div>
  )
}

/** Shown in place of the sidebar and pane while the selected project is
 *  being added or removed: progress, or the error with ways out. */
export function ProjectOpPane({ op }: { op: ProjectOp }): JSX.Element {
  const dropProjectOp = useUiStore((s) => s.dropProjectOp)
  const setAddProjectForm = useUiStore((s) => s.setAddProjectForm)
  const adding = op.kind === 'add'
  const dismiss = (): void => (adding ? dismissProjectAdd(op.id) : dropProjectOp(op.id))

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      {op.error === undefined ? (
        <>
          <div className="flex items-center gap-2 text-base text-text">
            <LoadingIcon size={15} className="animate-spin text-muted" />
            {adding ? (op.hosted === true ? 'Creating' : 'Adding') : 'Removing'} {op.name}
          </div>
          {op.remoteUrl !== '' && <p className="max-w-md break-all font-mono text-md text-subtle">{op.remoteUrl}</p>}
          {op.progress !== undefined ? <CloneProgress progress={op.progress} /> : (
            <p className="max-w-md text-md text-subtle">
              {adding
                ? op.hosted === true
                  ? 'Creating its git repository.'
                  : 'Cloning the repository. A large repo can take a few minutes.'
                : 'Stopping its workspaces and deleting its files.'}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="text-base font-medium text-danger">
            Couldn&apos;t {adding ? (op.hosted === true ? 'create' : 'add') : 'remove'} {op.name}
          </p>
          <p className="max-w-md text-md text-subtle">{op.error}</p>
          <div className="mt-1 flex items-center gap-2">
            {adding && (
              <YButton
                variant="primary"
                onClick={() => {
                  dismiss()
                  setAddProjectForm(op.hosted === true ? { name: op.name } : { remoteUrl: op.remoteUrl })
                }}
              >
                Try again
              </YButton>
            )}
            <YButton onClick={dismiss}>Dismiss</YButton>
          </div>
        </>
      )}
    </div>
  )
}
