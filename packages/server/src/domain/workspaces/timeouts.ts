/**
 * Workspace timeouts (docs/routines.md "Timeouts"): the server stops a
 * workspace once `workspaces.deadline` passes. The stop is the ordinary
 * natural stop, so it releases the workspace's queued children and keeps its
 * checkout, as a user stop does.
 */
import { listProvisioning } from './provisioning'
import { resolveWorkspaceId } from './resolve'
import { stopWorkspace } from './stop'
import { authorizeProject, systemPrincipal, type Actor } from '#domain/access'
import { findWorkspaceRow, listOverdueWorkspaceRows, setWorkspaceDeadline } from '#db'
import { serverLog } from '#lib/log'
import { ServerError } from '@yaac/shared/errors'
import type { RuntimeSnapshot } from '#drivers/contract'

/**
 * Stop every running workspace past its deadline. Run on the reconciler's
 * resync, so a stop lands up to about a minute late.
 *
 * A create still provisioning is left to finish: stopping it would roll it
 * back into a draft or back onto the queue, where a scheduled entry would
 * launch again. It is stopped on the first resync after it comes up. A
 * workspace already being torn down, or not running at all (its stop not yet
 * recorded), is left alone too.
 */
export async function reconcileWorkspaceTimeouts(snapshot: RuntimeSnapshot): Promise<void> {
  const overdue = await listOverdueWorkspaceRows(new Date())
  if (overdue.length === 0) return
  const provisioning = new Set(listProvisioning().map((p) => p.workspaceId))
  const running = new Set((await snapshot.workspaces())
    .filter((h) => !h.terminating && !h.prewarmed)
    .map((h) => h.workspaceId))
  for (const row of overdue) {
    if (provisioning.has(row.workspaceId) || !running.has(row.workspaceId)) continue
    await stopWorkspace(systemPrincipal, row.workspaceId)
      .catch((err: unknown) => serverLog(`[timeouts] stopping ${row.workspaceId.slice(0, 8)} at its deadline failed: ${String(err)}`))
  }
}

/**
 * Give a running workspace a timeout counted from now, or clear it with
 * null. User-only: no `yaac-mama` verb reaches this, so an agent cannot
 * extend its own life. Returns the new deadline.
 */
export async function setWorkspaceTimeout(
  principal: Actor,
  idOrPrefix: string,
  timeoutMinutes: number | null,
): Promise<{ workspaceId: string; deadline: string | null }> {
  const workspaceId = await resolveWorkspaceId(idOrPrefix)
  const row = await findWorkspaceRow(workspaceId)
  if (!row) throw new ServerError('NOT_FOUND', `workspace ${workspaceId.slice(0, 8)} has no record`)
  await authorizeProject(principal, row.projectId)
  const deadline = timeoutMinutes === null ? null : new Date(Date.now() + timeoutMinutes * 60_000)
  if (!await setWorkspaceDeadline(row.projectId, workspaceId, deadline)) {
    throw new ServerError('CONFLICT', `workspace ${workspaceId.slice(0, 8)} is stopped; restart it with a timeout instead`)
  }
  return { workspaceId, deadline: deadline?.toISOString() ?? null }
}
