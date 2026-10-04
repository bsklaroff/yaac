import { stopWorkspace } from '#lib/createWorkspace'
import { useUiStore } from '#lib/store'
import { formatUtcTimestamp } from '@yaac/shared/time'
import type { WorkspaceListEntry } from '@yaac/shared/types'

/**
 * Where the selection goes when the open workspace is stopped: the sidebar
 * row below it, else the row above, else nothing. `rowIds` is the sidebar's
 * selectable rows in display order, taken before the stop.
 */
export function successorRow(rowIds: string[], deletedId: string): string | null {
  const i = rowIds.indexOf(deletedId)
  if (i === -1) return null
  return rowIds[i + 1] ?? rowIds[i - 1] ?? null
}

/**
 * Optimistic workspace stop, used by the sidebar row's menu and the stop
 * shortcut after the stop dialog confirms. Marks the workspace stopping and
 * moves the selection to a neighboring row right away, since the server's
 * cleanup can take ~10s. On failure, restores it.
 */
export function stopWorkspaceOptimistic(workspace: WorkspaceListEntry, rowIds: string[]): void {
  const id = workspace.workspaceId
  const state = useUiStore.getState()
  state.beginDelete(id)
  if (state.selectedWorkspaceId === id) {
    // An auto-select, so on mobile it doesn't navigate to the pane.
    const next = successorRow(rowIds, id)
    if (next) state.autoSelectWorkspace(next)
    else state.selectWorkspace(null)
  }
  // A workspace with a prompt will be listed as stopped once cleanup
  // finishes; show it there now.
  if (workspace.prompt) {
    state.addOptimisticStopped({
      workspaceId: id,
      projectSlug: workspace.projectSlug,
      tool: workspace.tool,
      createdAt: workspace.createdAt,
      stoppedAt: formatUtcTimestamp(Date.now()),
      prompt: workspace.prompt,
      title: workspace.title,
      // Unused for a user stop (no deathReason), but required by the type.
      seen: false,
      agentSessions: workspace.agentSessions,
      groupId: workspace.groupId,
    })
  }
  void stopWorkspace(id).catch((e: unknown) => {
    console.error('delete failed', e)
    const s = useUiStore.getState()
    s.endDelete(id)
    s.removeOptimisticStopped(id)
  })
}

/**
 * Stop a workspace still being created or restarted. Nothing is lost (a
 * create's prompt is kept as a draft, a restart stays stopped), so there is
 * no confirm; the row reads "Stopping…" until the server has rolled it back.
 */
export function stopProvisioning(workspaceId: string): void {
  const state = useUiStore.getState()
  if (state.selectedWorkspaceId === workspaceId) state.selectWorkspace(null)
  void stopWorkspace(workspaceId).catch((e: unknown) => console.error('stop failed', e))
}
