import { useCallback } from 'react'
import { useUiStore } from '#lib/store'
import { formatUtcTimestamp } from '@yaac/shared/time'
import type { AgentTool, ProvisioningWorktreeEntry } from '@yaac/shared/types'

/** A streaming provision op (create or restart) for a known id. */
type ProvisionOp = (
  worktreeId: string,
  onProgress: (message: string) => void,
) => Promise<{ worktreeId: string }>

/**
 * Run a worktree provision (create, or restart-from-deleted) with the shared
 * optimistic flow: drop an immediate provisioning row (sidebar + selectable),
 * auto-open it so the creator watches progress in the main pane, and stream
 * progress/error into it until the server snapshot takes over (App prunes the
 * optimistic copy once its `provisioning[]` or `worktrees[]` includes the id).
 * A create that claims a prewarmed spare lists under the spare's id instead;
 * the selection follows it there (`claims` in the store).
 *
 * `groupId` is the sidebar group the row belongs in — a restart passes the
 * stopped worktree's, so the row renders in that section from the first frame
 * rather than at the top of the list until the server's own entry lands.
 * `named` is the model a create launches with, so the row names it from the
 * first frame too.
 */
export function useProvisionWorktree(): (
  projectSlug: string,
  tool: AgentTool,
  kind: ProvisioningWorktreeEntry['kind'],
  worktreeId: string,
  op: ProvisionOp,
  groupId?: string,
  named?: { model: string; modelName?: string },
) => void {
  const addOptimisticProvisioning = useUiStore((s) => s.addOptimisticProvisioning)
  const updateOptimisticProvisioning = useUiStore((s) => s.updateOptimisticProvisioning)
  const removeOptimisticProvisioning = useUiStore((s) => s.removeOptimisticProvisioning)
  const recordClaim = useUiStore((s) => s.recordClaim)
  const setProvisionInFlight = useUiStore((s) => s.setProvisionInFlight)
  const openWorktree = useUiStore((s) => s.openWorktree)

  return useCallback((projectSlug, tool, kind, worktreeId, op, groupId, named) => {
    const filed = { ...(groupId !== undefined ? { groupId } : {}), ...named }
    addOptimisticProvisioning({ worktreeId, projectSlug, tool, kind, ...filed, message: 'Starting…', createdAt: formatUtcTimestamp(Date.now()) })
    openWorktree(projectSlug, worktreeId) // auto-open the locally-initiated provision
    setProvisionInFlight(worktreeId, true)
    void op(worktreeId, (message) => updateOptimisticProvisioning(worktreeId, { message }))
      .then((res) => {
        // A create that claimed a prewarmed spare returns the spare's own id
        // (a running pod's id can't be re-keyed). The server's row usually
        // said so already; recording it here too covers a row that resolved
        // before any snapshot carried the claim. The selection follows it
        // once the spare lists (resolveVacantSelection).
        if (res.worktreeId !== worktreeId) {
          recordClaim(worktreeId, res.worktreeId)
          removeOptimisticProvisioning(worktreeId)
        }
      })
      .catch((e: unknown) => {
        updateOptimisticProvisioning(worktreeId, { error: e instanceof Error ? e.message : 'failed' })
      })
      // After the claim is recorded, so a selection waiting on this
      // provision is never let go before it knows where to follow.
      .finally(() => setProvisionInFlight(worktreeId, false))
  }, [
    addOptimisticProvisioning, updateOptimisticProvisioning, removeOptimisticProvisioning,
    recordClaim, setProvisionInFlight, openWorktree,
  ])
}
