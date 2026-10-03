import { useCallback } from 'react'
import { useUiStore } from '#lib/store'
import { formatUtcTimestamp } from '@yaac/shared/time'
import type { AgentTool, ProvisioningWorkspaceEntry } from '@yaac/shared/types'

/** A streaming provision op (create or restart) for a known id. */
type ProvisionOp = (
  workspaceId: string,
  onProgress: (message: string) => void,
) => Promise<{ workspaceId: string }>

/**
 * Run a workspace create or restart optimistically: add a provisioning row
 * right away, open it so progress shows in the main pane, and stream
 * progress or errors into it until the snapshot lists the workspace (App then
 * drops the optimistic row). A create that claims a prewarmed spare is
 * listed under the spare's id, and the selection follows it (`claims` in the
 * store).
 *
 * `groupId` places the row in its sidebar group from the start (a restart
 * passes the stopped workspace's group). `named` is the title and model a
 * create launches with, so the row can show them from the start.
 */
export function useProvisionWorkspace(): (
  projectSlug: string,
  tool: AgentTool,
  kind: ProvisioningWorkspaceEntry['kind'],
  workspaceId: string,
  op: ProvisionOp,
  groupId?: string,
  named?: Pick<ProvisioningWorkspaceEntry, 'title' | 'model' | 'modelName'>,
) => void {
  const addOptimisticProvisioning = useUiStore((s) => s.addOptimisticProvisioning)
  const updateOptimisticProvisioning = useUiStore((s) => s.updateOptimisticProvisioning)
  const removeOptimisticProvisioning = useUiStore((s) => s.removeOptimisticProvisioning)
  const recordClaim = useUiStore((s) => s.recordClaim)
  const setProvisionInFlight = useUiStore((s) => s.setProvisionInFlight)
  const openWorkspace = useUiStore((s) => s.openWorkspace)

  return useCallback((projectSlug, tool, kind, workspaceId, op, groupId, named) => {
    const filed = { ...(groupId !== undefined ? { groupId } : {}), ...named }
    addOptimisticProvisioning({ workspaceId, projectSlug, tool, kind, ...filed, message: 'Starting…', createdAt: formatUtcTimestamp(Date.now()) })
    openWorkspace(projectSlug, workspaceId)
    setProvisionInFlight(workspaceId, true)
    void op(workspaceId, (message) => updateOptimisticProvisioning(workspaceId, { message }))
      .then((res) => {
        // A create that claimed a prewarmed spare returns the spare's id.
        // The snapshot usually reports the claim first; this covers a create
        // that finished before any snapshot did.
        if (res.workspaceId !== workspaceId) {
          recordClaim(workspaceId, res.workspaceId)
          removeOptimisticProvisioning(workspaceId)
        }
      })
      .catch((e: unknown) => {
        updateOptimisticProvisioning(workspaceId, { error: e instanceof Error ? e.message : 'failed' })
      })
      // After recording the claim, so a waiting selection knows where to go.
      .finally(() => setProvisionInFlight(workspaceId, false))
  }, [
    addOptimisticProvisioning, updateOptimisticProvisioning, removeOptimisticProvisioning,
    recordClaim, setProvisionInFlight, openWorkspace,
  ])
}
