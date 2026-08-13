import { stopWorktree } from '#lib/createWorktree'
import { useUiStore } from '#store'
import type { WorktreeListEntry } from '@yaac/shared/types'

/**
 * Where the selection goes when the open worktree is deleted: the row below it
 * in the sidebar, else the row above (it was the bottom row), else nothing.
 * Deleting down a list therefore walks the selection down it, rather than
 * bouncing to whatever the auto-select would otherwise pick. `rowIds` is the
 * sidebar's selectable rows in display order, taken *before* the delete, so
 * the deleted worktree is still in it.
 */
export function successorRow(rowIds: string[], deletedId: string): string | null {
  const i = rowIds.indexOf(deletedId)
  if (i === -1) return null
  return rowIds[i + 1] ?? rowIds[i - 1] ?? null
}

/**
 * Optimistic worktree stop, shared by the sidebar row's × and the Alt+D
 * shortcut (both post-confirm): mark the worktree stopping (WorktreeRow
 * greys it) and move a matching selection to the neighbouring row
 * immediately, then fire the stop. The server's cleanup is detached (a stop
 * can take ~10s), so we can't wait for the snapshot to drop the row. On
 * failure, restore it.
 */
export function stopWorktreeOptimistic(worktree: WorktreeListEntry, rowIds: string[]): void {
  const id = worktree.worktreeId
  const state = useUiStore.getState()
  state.beginDelete(id)
  if (state.selectedWorktreeId === id) {
    // The app is choosing, not the user, so on mobile this fills the pane
    // behind the worktree list rather than navigating onto the neighbour.
    const next = successorRow(rowIds, id)
    if (next) state.autoSelectWorktree(next)
    else state.selectWorktree(null)
  }
  // A worktree with history (a prompt → a transcript) will appear in the
  // Stopped group once cleanup lands; show it there immediately.
  if (worktree.prompt) {
    state.addOptimisticStopped({
      worktreeId: id,
      projectSlug: worktree.projectSlug,
      tool: worktree.tool,
      createdAt: worktree.createdAt,
      prompt: worktree.prompt,
      title: worktree.title,
      // A user stop, never an abnormal death, so `seen` is moot — but the
      // type requires it and isUnseenDeath keys off deathReason anyway.
      seen: false,
      // The conversations come back with the stopped listing's next refetch;
      // the optimistic row only needs enough to render.
      agentSessions: [],
      // Carry the group so a stopped member ghosts into its sidebar group
      // without waiting for the stopped list to refetch.
      groupId: worktree.groupId,
    })
  }
  void stopWorktree(id).catch((e: unknown) => {
    console.error('delete failed', e)
    const s = useUiStore.getState()
    s.endDelete(id)
    s.removeOptimisticStopped(id)
  })
}
