import type { WorkspaceListEntry } from '@yaac/shared/types'

type WaitingLike = Pick<WorkspaceListEntry, 'workspaceId' | 'status' | 'waitingSinceMs'>

/** Keys a workspace's current waiting spell — id + the spell's start. Keying by
 *  the spell means a re-waiting workspace yields a new key, so the chime fires
 *  once per spell, not once per snapshot frame that repeats it. */
export function waitingKey(s: WaitingLike): string {
  return `${s.workspaceId}:${s.waitingSinceMs ?? 0}`
}

/** The set of waiting-spell keys in a snapshot — one per workspace now waiting. */
export function waitingSpellKeys(workspaces: WaitingLike[]): Set<string> {
  const keys = new Set<string>()
  for (const s of workspaces) if (s.status === 'waiting') keys.add(waitingKey(s))
  return keys
}

/** The workspaces that just entered a waiting spell — waiting now, with a key not
 *  present in the previous snapshot. */
export function newlyWaitingWorkspaces(prev: Set<string>, workspaces: WaitingLike[]): WaitingLike[] {
  return workspaces.filter((s) => s.status === 'waiting' && !prev.has(waitingKey(s)))
}

/**
 * Whether newly-waiting workspaces warrant a chime — true if any of them is NOT
 * the one the user is actively watching. `watching` is the selected workspace id
 * when the window is focused (they can see it flip), else null (they're away,
 * so every newly-waiting one is worth a nudge).
 */
export function shouldChime(fresh: WaitingLike[], watching: string | null): boolean {
  return fresh.some((s) => s.workspaceId !== watching)
}
