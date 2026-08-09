import type { WorktreeListEntry } from '@yaac/shared/types'

type WaitingLike = Pick<WorktreeListEntry, 'worktreeId' | 'status' | 'waitingSinceMs'>

/** Keys a worktree's current waiting spell — id + the spell's start. Keying by
 *  the spell means a re-waiting worktree yields a new key, so the chime fires
 *  once per spell, not once per snapshot frame that repeats it. */
export function waitingKey(s: WaitingLike): string {
  return `${s.worktreeId}:${s.waitingSinceMs ?? 0}`
}

/** The set of waiting-spell keys in a snapshot — one per worktree now waiting. */
export function waitingSpellKeys(worktrees: WaitingLike[]): Set<string> {
  const keys = new Set<string>()
  for (const s of worktrees) if (s.status === 'waiting') keys.add(waitingKey(s))
  return keys
}

/** The worktrees that just entered a waiting spell — waiting now, with a key not
 *  present in the previous snapshot. */
export function newlyWaitingWorktrees(prev: Set<string>, worktrees: WaitingLike[]): WaitingLike[] {
  return worktrees.filter((s) => s.status === 'waiting' && !prev.has(waitingKey(s)))
}

/**
 * Whether newly-waiting worktrees warrant a chime — true if any of them is NOT
 * the one the user is actively watching. `watching` is the selected worktree id
 * when the window is focused (they can see it flip), else null (they're away,
 * so every newly-waiting one is worth a nudge).
 */
export function shouldChime(fresh: WaitingLike[], watching: string | null): boolean {
  return fresh.some((s) => s.worktreeId !== watching)
}
