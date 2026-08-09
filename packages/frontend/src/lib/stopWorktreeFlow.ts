import { stopWorktree } from '#lib/createWorktree'
import { useUiStore } from '#store'
import type { WorktreeListEntry } from '@yaac/shared/types'

/**
 * Optimistic worktree stop, shared by the sidebar row's × and the Alt+D
 * shortcut (both post-confirm): mark the worktree stopping (WorktreeRow
 * greys it) and clear a matching selection immediately, then fire the stop.
 * The server's cleanup is detached (a stop can take ~10s), so we can't wait
 * for the snapshot to drop the row. On failure, restore it.
 */
export function stopWorktreeOptimistic(worktree: WorktreeListEntry): void {
  const id = worktree.worktreeId
  const state = useUiStore.getState()
  state.beginDelete(id)
  if (state.selectedWorktreeId === id) state.selectWorktree(null)
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
      // Carry the pin so a stopped background worktree keeps its sidebar row
      // without waiting for the stopped list to refetch.
      background: worktree.background,
    })
  }
  void stopWorktree(id).catch((e: unknown) => {
    console.error('delete failed', e)
    const s = useUiStore.getState()
    s.endDelete(id)
    s.removeOptimisticStopped(id)
  })
}
