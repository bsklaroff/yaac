/**
 * In-memory registry of projects being added or created. The snapshot
 * carries it, so every client (a reloaded tab, another browser, a CLI add
 * watched from the webapp) shows the add with its clone progress until the
 * project is listed. A failed add the webapp is following stays until its
 * owner dismisses it or adds the same project again.
 */
import { notifyWorkspaceListChanged } from '#lib/notify'
import { getProjectRow } from '#db'
import type { Actor } from '#domain/access'
import { ServerError } from '@yaac/shared/errors'
import type { GitProgress, ProjectAddEntry } from '@yaac/shared/types'

const entries = new Map<string, ProjectAddEntry>()

/** Clone progress arrives many times a second; a snapshot rebuild per line
 *  would be wasted, so a phase's updates notify at most this often. */
const PROGRESS_NOTIFY_MS = 500

/** Every add in flight or failed, oldest first. */
export function listProjectAdds(): ProjectAddEntry[] {
  return [...entries.values()]
}

/**
 * List `entry`, refusing (`CONFLICT`) an id another add holds (in flight,
 * or failed under another owner) and a remote its owner is already adding,
 * since the second would only be a duplicate project. The owner's failed
 * add of the same remote (of the same name, for a hosted project) is
 * dropped: this add is its retry. Synchronous, so nothing can claim the id
 * between the check and the claim.
 */
function claim(entry: ProjectAddEntry): void {
  for (const e of entries.values()) {
    const same = e.owner === entry.owner && e.hosted === entry.hosted
      && (entry.hosted ? e.name === entry.name : e.remoteUrl === entry.remoteUrl)
    if (e.id === entry.id && (e.error === undefined || e.owner !== entry.owner)) {
      throw new ServerError('CONFLICT', `project ${entry.id} is already being added`)
    }
    if (e.error === undefined && same && !entry.hosted) {
      throw new ServerError('CONFLICT', `${entry.remoteUrl} is already being added as project "${e.name}"`)
    }
    if (e.error !== undefined && same) entries.delete(e.id)
  }
  entries.delete(entry.id)
  entries.set(entry.id, entry)
  notifyWorkspaceListChanged()
}

/** Drop an entry, notifying if there was one. */
function drop(id: string): void {
  if (entries.delete(id)) notifyWorkspaceListChanged()
}

/**
 * Run `add` as the add of `entry.id`, listed until it settles (`claim`
 * says what it refuses): success drops the entry, since the project
 * replaces it, and failure rethrows. A failure stays listed, for its owner
 * to dismiss, only when the caller chose the id (`keepFailure`): that
 * caller follows the add in the snapshot, while one that did not already
 * has the error from its own request. An id that is already a project is
 * refused too.
 */
export async function trackProjectAdd<T>(
  entry: Omit<ProjectAddEntry, 'progress' | 'error'>,
  keepFailure: boolean,
  add: (onProgress: (progress: GitProgress) => void) => Promise<T>,
): Promise<T> {
  const live: ProjectAddEntry = { ...entry }
  claim(live)
  if (await getProjectRow(entry.id)) {
    drop(entry.id)
    throw new ServerError('CONFLICT', `project ${entry.id} already exists`)
  }
  let notifiedAt = 0
  const onProgress = (progress: GitProgress): void => {
    const phaseChanged = live.progress?.phase !== progress.phase
    live.progress = progress
    if (!phaseChanged && Date.now() - notifiedAt < PROGRESS_NOTIFY_MS) return
    notifiedAt = Date.now()
    notifyWorkspaceListChanged()
  }
  try {
    const result = await add(onProgress)
    drop(entry.id)
    return result
  } catch (err) {
    if (!keepFailure) {
      drop(entry.id)
    } else {
      entries.set(entry.id, { ...entry, error: err instanceof Error ? err.message : String(err) })
      notifyWorkspaceListChanged()
    }
    throw err
  }
}

/** The owner's "dismiss" on a failed add. Idempotent for an id with no
 *  entry; an add still running is not dismissed. */
export function dismissProjectAdd(principal: Actor, id: string): void {
  const e = entries.get(id)
  if (e?.error === undefined) return
  if (principal.kind !== 'system' && principal.userId !== e.owner) {
    throw new ServerError('FORBIDDEN', 'only the owner of this project may do that')
  }
  entries.delete(id)
  notifyWorkspaceListChanged()
}
