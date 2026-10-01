import type { JSX } from 'react'
import { LoadingIcon } from '#lib/icons'
import { agentLabel } from '#lib/agentLabel'
import { dismissProvisioning } from '#lib/createWorkspace'
import { useUiStore } from '#lib/store'
import type { ProvisioningWorkspaceEntry } from '@yaac/shared/types'

/** Main-pane placeholder while the selected workspace provisions. Shows
 *  progress, or the error with a Dismiss button. */
export function CreatingPlaceholder({ creating }: { creating: ProvisioningWorkspaceEntry }): JSX.Element {
  const removeOptimisticProvisioning = useUiStore((s) => s.removeOptimisticProvisioning)
  const selectWorkspace = useUiStore((s) => s.selectWorkspace)

  const dismiss = (): void => {
    void dismissProvisioning(creating.workspaceId).catch(() => { /* best-effort */ })
    removeOptimisticProvisioning(creating.workspaceId)
    selectWorkspace(null)
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      {creating.error ? (
        <>
          <p className="text-sm font-medium text-danger">Couldn&apos;t create workspace</p>
          <p className="max-w-md text-xs text-text-faint">{creating.error}</p>
          <div className="mt-1 flex items-center gap-2">
            <button
              onClick={dismiss}
              className="rounded-md bg-surface-2 px-3 py-1.5 text-xs text-text-dim transition
                hover:bg-surface-3 hover:text-text"
            >
              Dismiss
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2 text-sm text-text">
            <LoadingIcon size={15} className="animate-spin text-text-dim" />
            {creating.kind === 'restart' ? 'Restarting' : 'Creating'} {agentLabel(creating.tool, creating)} workspace
            in {creating.projectSlug}
          </div>
          <p className="text-xs text-text-faint">{creating.message}</p>
        </>
      )}
    </div>
  )
}
