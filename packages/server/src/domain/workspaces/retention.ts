import { deleteWorkspace } from './delete'
import { authorizeProject, systemPrincipal, type Actor } from '#domain/access'
import { listProjectRows, listWorkspaceRows, setProjectWorkspaceRetention } from '#db'
import { serverLog } from '#lib/log'

/*
 * Stopped-workspace retention: a project's owner may have its workspaces
 * deleted, checkout and history included, once they have been stopped a set
 * number of days (`projects.stoppedWorkspaceRetentionDays`). It is off
 * unless the owner turns it on, and covers only that one project, whose
 * workspaces are all its owner's (docs/workspace-storage.md "Retention").
 */

const DAY_MS = 24 * 60 * 60_000

/** What a delete pass did: how many went, and each one it kept with the
 *  delete's reason (still running, entries queued after it, ...). */
interface RetentionOutcome {
  deleted: number
  kept: Array<{ workspaceId: string; reason: string }>
}

/** The newest stop a retention of `days` expires right now. */
const cutoffFor = (days: number): Date => new Date(Date.now() - days * DAY_MS)

/**
 * Delete the project's workspaces stopped at or before `cutoff`. One the
 * delete refuses is logged and kept, and a later pass tries it again.
 * `signal` stops it between deletes, which is safe since each delete
 * removes the files before the row.
 */
async function deleteExpired(projectId: string, cutoff: Date, signal?: AbortSignal): Promise<RetentionOutcome> {
  const outcome: RetentionOutcome = { deleted: 0, kept: [] }
  const expired = (await listWorkspaceRows(projectId))
    .filter((r) => r.stoppedAt !== undefined && r.stoppedAt <= cutoff)
  for (const { workspaceId } of expired) {
    if (signal?.aborted) break
    try {
      await deleteWorkspace(systemPrincipal, workspaceId)
      outcome.deleted++
      serverLog(`[retention] deleted workspace ${projectId}/${workspaceId}, stopped by ${cutoff.toISOString()}`)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      outcome.kept.push({ workspaceId, reason })
      serverLog(`[retention] keeping workspace ${projectId}/${workspaceId}: ${reason}`)
    }
  }
  return outcome
}

/**
 * How many of the project's workspaces a retention of `days` would delete
 * right away, for the confirmation shown before it is set, and the cutoff
 * that count used. Handing that cutoff back to `setWorkspaceRetention` makes
 * the count an upper bound on what it deletes: a later stop is stamped later.
 */
export async function previewWorkspaceRetention(projectId: string, days: number): Promise<{ expired: number; before: Date }> {
  const before = cutoffFor(days)
  const expired = (await listWorkspaceRows(projectId))
    .filter((r) => r.stoppedAt !== undefined && r.stoppedAt <= before).length
  return { expired, before }
}

/**
 * Set the project's retention (null keeps stopped workspaces forever) and
 * delete the ones already past it, reporting what it deleted and kept.
 * `before` caps that backlog at the cutoff the user confirmed; the hourly
 * pass takes whatever ages past the retention after it.
 */
export async function setWorkspaceRetention(
  principal: Actor,
  projectId: string,
  days: number | null,
  before?: Date,
): Promise<RetentionOutcome> {
  await authorizeProject(principal, projectId)
  await setProjectWorkspaceRetention(projectId, days)
  if (days === null) return { deleted: 0, kept: [] }
  const cutoff = cutoffFor(days)
  return await deleteExpired(projectId, before !== undefined && before < cutoff ? before : cutoff)
}

/**
 * Apply every project's retention: the hourly sweep that deletes workspaces
 * as they age past it. A share whose source's owner removed it is skipped,
 * since every delete there is refused.
 */
export async function reconcileWorkspaceRetention(signal: AbortSignal): Promise<void> {
  for (const { id, stoppedWorkspaceRetentionDays: days, shareRevoked } of await listProjectRows()) {
    if (signal.aborted) return
    if (days !== undefined && !shareRevoked) await deleteExpired(id, cutoffFor(days), signal)
  }
}
