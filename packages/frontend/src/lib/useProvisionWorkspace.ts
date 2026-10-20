import { useCallback } from 'react'
import { useUiStore } from '#lib/store'
import { formatUtcTimestamp } from '@yaac/shared/time'
import type { ProvisioningWorkspaceEntry } from '@yaac/shared/types'

/**
 * Run a workspace create or restart optimistically: add its provisioning
 * `row` right away, open it so progress shows in the main pane, and stream
 * `op`'s progress or error into it until the snapshot lists the workspace
 * (the store then drops the optimistic row). A create that claims a
 * prewarmed spare is listed under the spare's id: its row stays until the
 * spare is listed, so the pane is never left empty, and the selection then
 * follows it (`claims` in the store).
 *
 * The row carries what it shows from the start: its sidebar group (a
 * restart's is the stopped workspace's), and a create's title, prompt and
 * model.
 */
export function useProvisionWorkspace(): (
  row: Omit<ProvisioningWorkspaceEntry, 'message' | 'createdAt'>,
  op: (onProgress: (message: string) => void) => Promise<{ workspaceId: string }>,
) => void {
  const addOptimisticProvisioning = useUiStore((s) => s.addOptimisticProvisioning)
  const updateOptimisticProvisioning = useUiStore((s) => s.updateOptimisticProvisioning)
  const recordClaim = useUiStore((s) => s.recordClaim)
  const setProvisionInFlight = useUiStore((s) => s.setProvisionInFlight)
  const openWorkspace = useUiStore((s) => s.openWorkspace)

  return useCallback((row, op) => {
    const { workspaceId } = row
    addOptimisticProvisioning({ ...row, message: 'Starting…', createdAt: formatUtcTimestamp(Date.now()) })
    openWorkspace(row.projectId, workspaceId)
    setProvisionInFlight(workspaceId, true)
    void op((message) => updateOptimisticProvisioning(workspaceId, { message }))
      .then((res) => {
        // A create that claimed a prewarmed spare returns the spare's id.
        // The snapshot usually reports the claim first; this covers a create
        // that finished before any snapshot did.
        if (res.workspaceId !== workspaceId) recordClaim(workspaceId, res.workspaceId)
      })
      .catch((e: unknown) => {
        updateOptimisticProvisioning(workspaceId, { error: e instanceof Error ? e.message : 'failed' })
      })
      // After recording the claim, so a waiting selection knows where to go.
      .finally(() => setProvisionInFlight(workspaceId, false))
  }, [
    addOptimisticProvisioning, updateOptimisticProvisioning, recordClaim, setProvisionInFlight, openWorkspace,
  ])
}
