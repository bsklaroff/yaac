import { deleteSession } from '#lib/createSession'
import { useUiStore } from '#store'
import type { SessionListEntry } from '@yaac/shared/types'

/**
 * Optimistic session delete, shared by the sidebar row's × and the Alt+D
 * shortcut (both post-confirm): mark the session terminating (SessionRow
 * greys it) and clear a matching selection immediately, then fire the delete.
 * The server's cleanup is detached (a stop can take ~10s), so we can't wait
 * for the snapshot to drop the session. On failure, restore it.
 */
export function deleteSessionOptimistic(session: SessionListEntry): void {
  const id = session.sessionId
  const state = useUiStore.getState()
  state.beginDelete(id)
  if (state.selectedSessionId === id) state.selectSession(null)
  // A session with history (a prompt → a transcript) will appear in the
  // Deleted group once cleanup lands; show it there immediately.
  if (session.prompt) {
    state.addOptimisticDeleted({
      sessionId: id,
      projectSlug: session.projectSlug,
      tool: session.tool,
      createdAt: session.createdAt,
      prompt: session.prompt,
      title: session.title,
      // A user delete, never an abnormal death, so `seen` is moot — but the
      // type requires it and isUnseenDeath keys off deathReason anyway.
      seen: false,
      // Carry the pin so a deleted background session keeps its sidebar row
      // without waiting for the deleted list to refetch.
      background: session.background,
    })
  }
  void deleteSession(id).catch((e: unknown) => {
    console.error('delete failed', e)
    const s = useUiStore.getState()
    s.endDelete(id)
    s.removeOptimisticDeleted(id)
  })
}
