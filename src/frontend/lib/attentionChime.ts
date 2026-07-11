import type { SessionListEntry } from '@/shared/types'

type WaitingLike = Pick<SessionListEntry, 'sessionId' | 'status' | 'waitingSinceMs'>

/** Keys a session's current waiting spell — id + the spell's start. Keying by
 *  the spell means a re-waiting session yields a new key, so the chime fires
 *  once per spell, not once per snapshot frame that repeats it. */
export function waitingKey(s: WaitingLike): string {
  return `${s.sessionId}:${s.waitingSinceMs ?? 0}`
}

/** The set of waiting-spell keys in a snapshot — one per session now waiting. */
export function waitingSpellKeys(sessions: WaitingLike[]): Set<string> {
  const keys = new Set<string>()
  for (const s of sessions) if (s.status === 'waiting') keys.add(waitingKey(s))
  return keys
}

/** The sessions that just entered a waiting spell — waiting now, with a key not
 *  present in the previous snapshot. */
export function newlyWaitingSessions(prev: Set<string>, sessions: WaitingLike[]): WaitingLike[] {
  return sessions.filter((s) => s.status === 'waiting' && !prev.has(waitingKey(s)))
}

/**
 * Whether newly-waiting sessions warrant a chime — true if any of them is NOT
 * the one the user is actively watching. `watching` is the selected session id
 * when the window is focused (they can see it flip), else null (they're away,
 * so every newly-waiting one is worth a nudge).
 */
export function shouldChime(fresh: WaitingLike[], watching: string | null): boolean {
  return fresh.some((s) => s.sessionId !== watching)
}
