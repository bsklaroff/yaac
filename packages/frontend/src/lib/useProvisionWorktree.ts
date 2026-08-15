import { useCallback } from 'react'
import { useUiStore } from '#store'
import { ServerError } from '@yaac/shared/errors'
import { formatUtcTimestamp } from '@yaac/shared/time'
import type { AgentTool, ProvisioningWorktreeEntry } from '@yaac/shared/types'

/**
 * A streaming provision op (create or restart) for a known id.
 *
 * `retryOpts` is what a retry adds to the original call — the op closes over
 * everything else (project, branch, mode, posture), which is why re-running
 * one is only possible through the closure that started it.
 */
type ProvisionOp = (
  worktreeId: string,
  onProgress: (message: string) => void,
  retryOpts?: { installMissingTool?: boolean },
) => Promise<{ worktreeId: string }>

/**
 * Run a worktree provision (create, or restart-from-deleted) with the shared
 * optimistic flow: drop an immediate provisioning row (sidebar + selectable),
 * auto-open it so the creator watches progress in the main pane, and stream
 * progress/error into it until the server snapshot takes over (App prunes the
 * optimistic copy once its `provisioning[]` or `worktrees[]` includes the id).
 *
 * `groupId` is the sidebar group the row belongs in — a restart passes the
 * stopped worktree's, so the row renders in that section from the first frame
 * rather than at the top of the list until the server's own entry lands.
 */
export function useProvisionWorktree(): (
  projectSlug: string,
  tool: AgentTool,
  kind: ProvisioningWorktreeEntry['kind'],
  worktreeId: string,
  op: ProvisionOp,
  groupId?: string,
) => void {
  const addOptimisticProvisioning = useUiStore((s) => s.addOptimisticProvisioning)
  const updateOptimisticProvisioning = useUiStore((s) => s.updateOptimisticProvisioning)
  const removeOptimisticProvisioning = useUiStore((s) => s.removeOptimisticProvisioning)
  const setProvisionRetry = useUiStore((s) => s.setProvisionRetry)
  const openWorktree = useUiStore((s) => s.openWorktree)

  return useCallback(function provision(projectSlug, tool, kind, worktreeId, op, groupId) {
    const filed = groupId !== undefined ? { groupId } : {}
    addOptimisticProvisioning({ worktreeId, projectSlug, tool, kind, ...filed, message: 'Starting…', createdAt: formatUtcTimestamp(Date.now()) })
    openWorktree(projectSlug, worktreeId) // auto-open the locally-initiated provision
    // How to run this exact provision again, for a failure that has a
    // recovery (a tool this host can install). Same id, so the row the user
    // is watching flips back to streaming rather than a second one
    // appearing — the server registry treats a re-register on one id as the
    // retry it is.
    setProvisionRetry(worktreeId, () => {
      provision(projectSlug, tool, kind, worktreeId,
        (id, onProgress) => op(id, onProgress, { installMissingTool: true }), groupId)
    })
    void op(worktreeId, (message) => updateOptimisticProvisioning(worktreeId, { message }))
      .then((res) => {
        // A create that claimed a prewarmed spare returns the spare's own id,
        // not the one we generated (a running pod's id can't be re-keyed).
        // Re-key the optimistic row to that id and follow it — DON'T just drop
        // the row: the spare isn't in the snapshot yet, so for the gap until it
        // lands an unprotected selection would be stolen back to an existing
        // worktree by App's auto-select. Carrying an optimistic row keeps the
        // pane on the new worktree until the snapshot takes over.
        if (res.worktreeId !== worktreeId) {
          addOptimisticProvisioning({
            worktreeId: res.worktreeId, projectSlug, tool, kind, ...filed, message: 'Claiming warm spare…', createdAt: formatUtcTimestamp(Date.now()),
          })
          removeOptimisticProvisioning(worktreeId)
          openWorktree(projectSlug, res.worktreeId)
        }
        setProvisionRetry(worktreeId, null)
      })
      .catch((e: unknown) => {
        updateOptimisticProvisioning(worktreeId, {
          error: e instanceof Error ? e.message : 'failed',
          ...(e instanceof ServerError ? { errorCode: e.code } : {}),
        })
      })
  }, [addOptimisticProvisioning, updateOptimisticProvisioning, removeOptimisticProvisioning, setProvisionRetry, openWorktree])
}
