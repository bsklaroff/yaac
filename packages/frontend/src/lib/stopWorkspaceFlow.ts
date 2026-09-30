import { stopWorkspace } from '#lib/createWorkspace'
import { useUiStore } from '#lib/store'
import { formatUtcTimestamp } from '@yaac/shared/time'
import type { WorkspaceListEntry } from '@yaac/shared/types'

/**
 * Where the selection goes when the open workspace is deleted: the row below it
 * in the sidebar, else the row above (it was the bottom row), else nothing.
 * Deleting down a list therefore walks the selection down it, rather than
 * bouncing to whatever the auto-select would otherwise pick. `rowIds` is the
 * sidebar's selectable rows in display order, taken *before* the delete, so
 * the deleted workspace is still in it.
 */
export function successorRow(rowIds: string[], deletedId: string): string | null {
  const i = rowIds.indexOf(deletedId)
  if (i === -1) return null
  return rowIds[i + 1] ?? rowIds[i - 1] ?? null
}

/**
 * Optimistic workspace stop, shared by the sidebar row's menu and the Alt+D
 * shortcut (both confirmed through the stop dialog): mark the workspace stopping (WorkspaceRow
 * greys it) and move a matching selection to the neighbouring row
 * immediately, then fire the stop. The server's cleanup is detached (a stop
 * can take ~10s), so we can't wait for the snapshot to drop the row. On
 * failure, restore it.
 */
export function stopWorkspaceOptimistic(workspace: WorkspaceListEntry, rowIds: string[]): void {
  const id = workspace.workspaceId
  const state = useUiStore.getState()
  state.beginDelete(id)
  if (state.selectedWorkspaceId === id) {
    // The app is choosing, not the user, so on mobile this fills the pane
    // behind the workspace list rather than navigating onto the neighbour.
    const next = successorRow(rowIds, id)
    if (next) state.autoSelectWorkspace(next)
    else state.selectWorkspace(null)
  }
  // A workspace with history (a prompt → a transcript) will appear in the
  // Stopped group once cleanup lands; show it there immediately.
  if (workspace.prompt) {
    state.addOptimisticStopped({
      workspaceId: id,
      projectSlug: workspace.projectSlug,
      tool: workspace.tool,
      createdAt: workspace.createdAt,
      stoppedAt: formatUtcTimestamp(Date.now()),
      prompt: workspace.prompt,
      title: workspace.title,
      // A user stop, never an abnormal death, so `seen` is moot — but the
      // type requires it and isUnseenDeath keys off deathReason anyway.
      seen: false,
      // Carried so the row names its model before the stopped listing's
      // next refetch; the live-only status fields are never read there.
      agentSessions: workspace.agentSessions,
      // Carry the group so a stopped member ghosts into its sidebar group
      // without waiting for the stopped list to refetch.
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
