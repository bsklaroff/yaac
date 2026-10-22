import { workspaceDriver } from '#drivers/driver'
import { deleteWorkspaceState, tearingDown } from './cleanup'
import { claimDeletion, removeProvisioning } from './provisioning'
import { resolveWorkspaceId } from './resolve'
import { authorizeProject, systemPrincipal, type Actor } from '#domain/access'
import { resolveProjectConfig } from '#domain/projects'
import {
  deleteWorkspaceRecords,
  findWorkspaceRow,
  getProjectAgentSessions,
  listProjectWorkspaceIds,
  listQueuedWorkspaceRows,
  listWorkspaceAgentSessions,
  listWorkspaceRows,
} from '#db'
import { serverLog } from '#lib/log'
import { env } from '@yaac/shared/env'
import { ServerError } from '@yaac/shared/errors'

const DAY_MS = 24 * 60 * 60_000

/**
 * Delete a stopped workspace by id or prefix: its checkout (with its local
 * branches, unpushed commits and uncommitted changes), its conversations'
 * history, and its rows. Returns the full id.
 *
 * The id is held (`claimDeletion`) before its state is read and until its
 * rows are gone, so no restart or queued child can start on it meanwhile.
 * Only a stopped workspace is deleted, so a delete never races its own
 * runtime writing the checkout. Refused too: one with entries queued after
 * it, which would wait on a parent that can no longer stop, and one where a
 * conversation it started has been resumed by a sibling, since the
 * transcript lives in this workspace's history.
 *
 * The files go before the rows. If removing them fails, the row stays and
 * the workspace is still listed as stopped; no sweep collects a checkout
 * without a row (docs/workspace-storage.md).
 */
export async function deleteWorkspace(principal: Actor, idOrPrefix: string): Promise<string> {
  const id = await resolveWorkspaceId(idOrPrefix)
  const found = await findWorkspaceRow(id)
  if (!found) throw new ServerError('NOT_FOUND', `workspace ${idOrPrefix} not found`)
  const { projectId, workspaceId } = found
  await authorizeProject(principal, projectId)
  const short = workspaceId.slice(0, 8)

  const release = claimDeletion(workspaceId)
  try {
    // Read again under the hold: a restart may have finished meanwhile.
    const row = await findWorkspaceRow(workspaceId)
    if (row?.stoppedAt === undefined || tearingDown(workspaceId)
      || await workspaceDriver().findForTeardown(workspaceId) !== undefined) {
      throw new ServerError('CONFLICT', `workspace ${short} is running or still stopping; stop it first`)
    }
    const queued = (await listQueuedWorkspaceRows(projectId)).filter((q) => q.parentWorkspaceId === workspaceId)
    if (queued.length > 0) {
      throw new ServerError('CONFLICT', `workspace ${short} has ${queued.length} queued workspace(s) waiting on it; `
        + 'discard or run them first')
    }
    // Only a conversation that started here, which this workspace linked
    // before any sibling did; one it merely resumed lives elsewhere.
    const own = new Map((await listWorkspaceAgentSessions(projectId, workspaceId))
      .map((l) => [l.agentSessionId, l.firstSeenAt.getTime()]))
    const siblings = (await listProjectWorkspaceIds(projectId)).filter((w) => w !== workspaceId)
    const sharer = [...(await getProjectAgentSessions(projectId, siblings)).values()].flat()
      .find((l) => (own.get(l.agentSessionId) ?? Infinity) <= l.firstSeenAt.getTime())
    if (sharer) {
      throw new ServerError('CONFLICT', `workspace ${short}'s conversation ${sharer.agentSessionId} is resumed in `
        + `workspace ${sharer.workspaceId.slice(0, 8)}, and its transcript would go with this one`)
    }

    if (!await deleteWorkspaceState(projectId, workspaceId)) {
      throw new ServerError('INTERNAL', `could not remove all of workspace ${short}'s files (see the server log); `
        + 'its record is kept so the delete can be retried once they are removable, and a restart '
        + 'reuses its .git (run `git restore .` there to bring back its tracked files)')
    }
    await deleteWorkspaceRecords(projectId, workspaceId)
    // Under the hold no live entry can exist, so this drops only a failed
    // restart's, which would otherwise stay listed for a workspace that is
    // gone.
    removeProvisioning(workspaceId)
    return workspaceId
  } finally {
    release()
  }
}

/**
 * Delete every workspace stopped longer than its project's retention:
 * `stoppedWorkspaceRetentionDays` in its yaac-config.json, else the server's
 * `YAAC_WORKSPACE_RETENTION_DAYS`. Off unless one of them is set.
 *
 * A project whose config cannot be read keeps everything. A workspace the
 * delete refuses (one with queued entries waiting on it, say) is logged and
 * tried again next pass. `signal` stops the pass between deletes, which is
 * safe since each delete removes the files before the row.
 */
export async function reconcileWorkspaceRetention(signal: AbortSignal): Promise<void> {
  const stopped = new Map<string, Array<{ workspaceId: string; stoppedMs: number }>>()
  for (const { projectId, workspaceId, stoppedAt } of await listWorkspaceRows()) {
    if (stoppedAt !== undefined) {
      stopped.set(projectId, [...stopped.get(projectId) ?? [], { workspaceId, stoppedMs: stoppedAt.getTime() }])
    }
  }
  for (const [projectId, rows] of stopped) {
    const days = await resolveProjectConfig(projectId).then(
      (config) => config?.stoppedWorkspaceRetentionDays ?? env.workspaceRetentionDays,
      (err: unknown) => {
        serverLog(`[retention] keeping project ${projectId}'s workspaces: unreadable config: ${String(err)}`)
        return 0
      },
    )
    if (days === 0) continue
    const cutoffMs = Date.now() - days * DAY_MS
    for (const { workspaceId } of rows.filter((r) => r.stoppedMs <= cutoffMs)) {
      if (signal.aborted) return
      await deleteWorkspace(systemPrincipal, workspaceId).then(
        () => serverLog(`[retention] deleted workspace ${projectId}/${workspaceId}, stopped more than ${days} days`),
        (err: unknown) => serverLog(`[retention] keeping workspace ${projectId}/${workspaceId}: ${String(err)}`),
      )
    }
  }
}
