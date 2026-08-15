import type { JSX } from 'react'
import { LoadingIcon, TOOL_LABEL } from '#lib/icons'
import { dismissProvisioning } from '#lib/createWorktree'
import { useUiStore } from '#store'
import type { ProvisioningWorktreeEntry } from '@yaac/shared/types'

/** Shown in the main pane while a selected worktree provisions, in place of the
 *  terminal that will arrive. Streams progress; on failure offers dismiss. */
export function CreatingPlaceholder({ creating }: { creating: ProvisioningWorktreeEntry }): JSX.Element {
  const removeOptimisticProvisioning = useUiStore((s) => s.removeOptimisticProvisioning)
  const setProvisionRetry = useUiStore((s) => s.setProvisionRetry)
  const selectWorktree = useUiStore((s) => s.selectWorktree)
  // Present only for a provision this browser session started — the closure
  // holding its parameters cannot survive a reload. The failure message
  // always names the install command too, so a reloaded row still tells the
  // user how to fix it by hand.
  const retry = useUiStore((s) => s.provisionRetries[creating.worktreeId])
  const canInstall = creating.errorCode === 'MISSING_TOOL' && retry !== undefined

  const dismiss = (): void => {
    void dismissProvisioning(creating.worktreeId).catch(() => { /* best-effort */ })
    removeOptimisticProvisioning(creating.worktreeId)
    // The row is gone, so nothing can offer its retry any more — and the
    // success path that normally clears this is one a dismissed failure
    // never reaches, so without this each one strands its closure (and the
    // create parameters it captured) for the life of the tab.
    setProvisionRetry(creating.worktreeId, null)
    selectWorktree(null)
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      {creating.error ? (
        <>
          <p className="text-sm font-medium text-[#d65858]">Couldn&apos;t create worktree</p>
          <p className="max-w-md text-xs text-text-faint">{creating.error}</p>
          <div className="mt-1 flex items-center gap-2">
            {canInstall && (
              <button
                onClick={retry}
                className="rounded-md bg-surface-3 px-3 py-1.5 text-xs text-text transition
                  hover:bg-surface-2"
              >
                Install and retry
              </button>
            )}
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
            {creating.kind === 'restart' ? 'Restarting' : 'Creating'} {TOOL_LABEL[creating.tool]} worktree
            in {creating.projectSlug}
          </div>
          <p className="text-xs text-text-faint">{creating.message}</p>
        </>
      )}
    </div>
  )
}
