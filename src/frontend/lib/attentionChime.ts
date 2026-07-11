import type { SessionListEntry } from '@/shared/types'

type WaitingLike = Pick<SessionListEntry, 'sessionId' | 'status' | 'waitingSinceMs'>

/**
 * The set of "waiting spell" keys in a snapshot — one per session currently
 * waiting, keyed by id + the spell's start (waitingSinceMs). Keying by the
 * spell means a re-waiting session yields a new key, so the chime fires once
 * per spell, not once per snapshot frame that repeats it.
 */
export function waitingSpellKeys(sessions: WaitingLike[]): Set<string> {
  const keys = new Set<string>()
  for (const s of sessions) {
    if (s.status === 'waiting') keys.add(`${s.sessionId}:${s.waitingSinceMs ?? 0}`)
  }
  return keys
}

/** Spell keys present now but not in the previous snapshot — sessions that
 *  just entered a waiting spell (the ones worth chiming for). */
export function newlyWaiting(prev: Set<string>, current: Set<string>): string[] {
  const fresh: string[] = []
  for (const key of current) if (!prev.has(key)) fresh.push(key)
  return fresh
}
