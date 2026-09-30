import type { WorkspaceListEntry } from '@yaac/shared/types'

type WaitingLike = Pick<WorkspaceListEntry, 'workspaceId' | 'status' | 'waitingSinceMs'>

/** Identifies one waiting period of a workspace (its id plus when it started
 *  waiting), so the chime fires once per period rather than once per
 *  snapshot. */
export function waitingKey(s: WaitingLike): string {
  return `${s.workspaceId}:${s.waitingSinceMs ?? 0}`
}

/** The waiting keys of every workspace currently waiting. */
export function waitingSpellKeys(workspaces: WaitingLike[]): Set<string> {
  const keys = new Set<string>()
  for (const s of workspaces) if (s.status === 'waiting') keys.add(waitingKey(s))
  return keys
}

/** The workspaces waiting now whose key wasn't in the previous snapshot. */
export function newlyWaitingWorkspaces(prev: Set<string>, workspaces: WaitingLike[]): WaitingLike[] {
  return workspaces.filter((s) => s.status === 'waiting' && !prev.has(waitingKey(s)))
}

/**
 * Whether to chime: true if any newly waiting workspace is not the one the
 * user is watching. `watching` is the selected workspace id when the window
 * has focus, else null.
 */
export function shouldChime(fresh: WaitingLike[], watching: string | null): boolean {
  return fresh.some((s) => s.workspaceId !== watching)
}
