import type { JSX } from 'react'
import { LoadingIcon, TOOL_LABEL } from '#lib/icons'
import { dismissProvisioning } from '#lib/createSession'
import { useUiStore } from '#store'
import type { ProvisioningWorktreeEntry } from '@yaac/shared/types'

/** Shown in the main pane while a selected session provisions, in place of the
 *  terminal that will arrive. Streams progress; on failure offers dismiss. */
export function CreatingPlaceholder({ creating }: { creating: ProvisioningWorktreeEntry }): JSX.Element {
  const removeOptimisticProvisioning = useUiStore((s) => s.removeOptimisticProvisioning)
  const selectSession = useUiStore((s) => s.selectSession)

  const dismiss = (): void => {
    void dismissProvisioning(creating.worktreeId).catch(() => { /* best-effort */ })
    removeOptimisticProvisioning(creating.worktreeId)
    selectSession(null)
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      {creating.error ? (
        <>
          <p className="text-sm font-medium text-[#d65858]">Couldn&apos;t create session</p>
          <p className="max-w-md text-xs text-text-faint">{creating.error}</p>
          <button
            onClick={dismiss}
            className="mt-1 rounded-md bg-surface-2 px-3 py-1.5 text-xs text-text-dim transition
              hover:bg-surface-3 hover:text-text"
          >
            Dismiss
          </button>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2 text-sm text-text">
            <LoadingIcon size={15} className="animate-spin text-text-dim" />
            {creating.kind === 'restart' ? 'Restarting' : 'Creating'} {TOOL_LABEL[creating.tool]} session
            in {creating.projectSlug}
          </div>
          <p className="text-xs text-text-faint">{creating.message}</p>
        </>
      )}
    </div>
  )
}
