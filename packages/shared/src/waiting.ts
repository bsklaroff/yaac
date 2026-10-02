import type { WorkspaceListEntry } from '#types'

/**
 * Which workspaces just started waiting for input, for the SPA's chime and
 * the desktop app's notifications. A workspace waits in spells: each spell
 * has its own key (the id plus when it began waiting), so a new spell
 * alerts again while an ongoing one alerts once.
 */

type WaitingLike = Pick<WorkspaceListEntry, 'workspaceId' | 'status' | 'waitingSinceMs'>

export function waitingKey(s: WaitingLike): string {
  return `${s.workspaceId}:${s.waitingSinceMs ?? 0}`
}

/** The spell keys of every workspace waiting now. */
export function waitingKeys(workspaces: readonly WaitingLike[]): Set<string> {
  return new Set(workspaces.filter((s) => s.status === 'waiting').map(waitingKey))
}

/** The workspaces waiting now whose spell is not in `prev`. */
export function newlyWaiting<T extends WaitingLike>(prev: ReadonlySet<string>, workspaces: readonly T[]): T[] {
  return workspaces.filter((s) => s.status === 'waiting' && !prev.has(waitingKey(s)))
}
