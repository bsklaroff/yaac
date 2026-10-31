import type { WorkspaceListEntry } from '#types'

/**
 * Which workspaces just started waiting for input, for the SPA's chime and
 * the desktop app's notifications. Each session waits in spells, keyed by
 * its id plus when the spell began, so a new spell alerts again while an
 * ongoing one alerts once, and one session finishing alerts even while a
 * sibling already waits. A waiting workspace none of whose sessions has a
 * status yet (its agent still booting) waits under its own id.
 */

type WaitingLike = Pick<WorkspaceListEntry, 'workspaceId' | 'status' | 'waitingSinceMs' | 'sessions'>

function spellKeys(w: WaitingLike): string[] {
  if (w.status !== 'waiting') return []
  const sessions = w.sessions.filter((s) => s.status === 'waiting')
  return sessions.length > 0
    ? sessions.map((s) => `${s.sessionId}:${s.waitingSinceMs ?? 0}`)
    : [`${w.workspaceId}:${w.waitingSinceMs ?? 0}`]
}

/** The spell keys of everything waiting now. */
export function waitingKeys(workspaces: readonly WaitingLike[]): Set<string> {
  return new Set(workspaces.flatMap(spellKeys))
}

/** The workspaces with a spell waiting now that is not in `prev`. */
export function newlyWaiting<T extends WaitingLike>(prev: ReadonlySet<string>, workspaces: readonly T[]): T[] {
  return workspaces.filter((w) => spellKeys(w).some((k) => !prev.has(k)))
}
