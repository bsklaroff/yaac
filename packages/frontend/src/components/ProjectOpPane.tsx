import type { JSX } from 'react'
import { LoadingIcon } from '#lib/icons'
import { useUiStore, type ProjectOp } from '#lib/store'

const BUTTON = 'rounded-md bg-surface-2 px-3 py-1.5 text-xs text-text-dim transition hover:bg-surface-3 hover:text-text'

/** Shown in place of the sidebar and pane while the selected project is
 *  being added or removed: progress, or the error with ways out. */
export function ProjectOpPane({ op }: { op: ProjectOp }): JSX.Element {
  const dropProjectOp = useUiStore((s) => s.dropProjectOp)
  const setAddProjectForm = useUiStore((s) => s.setAddProjectForm)
  const adding = op.kind === 'add'

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      {op.error === undefined ? (
        <>
          <div className="flex items-center gap-2 text-sm text-text">
            <LoadingIcon size={15} className="animate-spin text-text-dim" />
            {adding ? 'Adding' : 'Removing'} {op.name}
          </div>
          <p className="max-w-md break-all font-mono text-xs text-text-faint">{op.remoteUrl}</p>
          <p className="max-w-md text-xs text-text-faint">
            {adding
              ? 'Cloning the repository. A large repo can take a few minutes.'
              : 'Stopping its workspaces and deleting its files.'}
          </p>
        </>
      ) : (
        <>
          <p className="text-sm font-medium text-danger">
            Couldn&apos;t {adding ? 'add' : 'remove'} {op.name}
          </p>
          <p className="max-w-md text-xs text-text-faint">{op.error}</p>
          <div className="mt-1 flex items-center gap-2">
            {adding && (
              <button
                onClick={() => { dropProjectOp(op.id); setAddProjectForm({ remoteUrl: op.remoteUrl }) }}
                className={BUTTON}
              >
                Try again
              </button>
            )}
            <button onClick={() => dropProjectOp(op.id)} className={BUTTON}>Dismiss</button>
          </div>
        </>
      )}
    </div>
  )
}
