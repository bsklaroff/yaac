import { tearingDown, teardownForRestart } from './cleanup'
import { createWorkspace, type WorkspaceCreateResult } from './create'
import { resolveWorkspaceId } from './resolve'
import { provision, type ProvisionRun } from './provisioning'
import { readGroupRoom, refuseFullGroup } from './group-limits'
import { planSessionResumes } from './session-launch'
import {
  clearWorkspaceStopped,
  findWorkspaceRow,
  insertSession,
  listActiveConversations,
  listWorkspaceSessions,
  type SessionLaunchSettings,
} from '#db'
import { authorizeProject, type Actor } from '#domain/access'
import { workspaceDriver } from '#drivers/driver'
import { serverLog } from '#lib/log'
import { ServerError } from '@yaac/shared/errors'
import { defaultPermissionMode } from '@yaac/shared/types'

/**
 * Check a restart of a workspace id or prefix, running or stopped, and
 * register its provisioning row, filed under the workspace's group so it
 * keeps its place in the sidebar. Refuses a caller who does not own it, a
 * group at its workspace limit, and with `stoppedOnly` a workspace that is
 * running.
 *
 * The run tears down any running unit (keeping the checkout) and launches a
 * new one that brings back each of its open sessions in its own window,
 * resuming its conversation, and refuses if one has lost its history
 * (`planSessionResumes`). A conversation an agent started by hand in a
 * terminal, live when the workspace stopped, comes back as a session of its
 * own. Config comes fresh from the project.
 */
export async function prepareRestart(
  principal: Actor,
  idOrPrefix: string,
  /** `deadline`: when the server stops it, which a restart otherwise
   *  clears. */
  opts: { stoppedOnly?: boolean; deadline?: Date } = {},
): Promise<ProvisionRun<WorkspaceCreateResult>> {
  // The runtime is asked directly, never skipped when unreachable: a unit
  // this missed would keep running beside the relaunch.
  const id = await resolveWorkspaceId(idOrPrefix)
  const unit = await workspaceDriver().find(id)
  // The row is what a restart relaunches from.
  const row = await findWorkspaceRow(id)
  if (!row) {
    throw new ServerError('NOT_FOUND', unit
      ? `workspace ${idOrPrefix} has no record to restart from`
      : `No workspace found matching "${idOrPrefix}". Run "yaac workspace list -s" to see stopped workspaces.`)
  }
  const { projectId, workspaceId } = row
  await authorizeProject(principal, projectId)
  if (unit && opts.stoppedOnly === true) {
    throw new ServerError('CONFLICT', `workspace ${workspaceId.slice(0, 8)} is running; only a stopped one can be restarted`)
  }
  const jobName = unit?.jobName
  // With nothing running or shutting down, nothing can still write history,
  // so a lost one is refused before the provisioning row exists: a plain
  // error rather than a failed row.
  const settled = !unit && !tearingDown(workspaceId)
    && await workspaceDriver().findForTeardown(workspaceId) === undefined
  if (settled) await planSessionResumes(projectId, workspaceId, await listWorkspaceSessions(workspaceId))
  // A stopped workspace takes a slot in its group again; a running one
  // already holds its own.
  refuseFullGroup(await readGroupRoom(projectId, row.groupId), workspaceId)

  // The row also keeps `inFlightWorkspaceIds` reporting the workspace, which
  // stops the stale reaper deleting the dirs the new launch is about to
  // mount.
  const first = (await listWorkspaceSessions(workspaceId))[0]
  return provision({
    workspaceId,
    projectId,
    ...(first !== undefined ? { tool: first.tool } : {}),
    kind: 'restart',
    ...(row.groupId !== undefined ? { groupId: row.groupId } : {}),
  }, async (onProgress) => {
    if (jobName) onProgress(`Stopping session job ${jobName}...`)
    // Always: it also clears a leftover terminating mark.
    await teardownForRestart({ jobName: jobName ?? null, projectId, workspaceId })

    for (const settings of await terminalConversationSessions(projectId, workspaceId)) {
      await insertSession(projectId, workspaceId, settings)
    }
    const sessions = await listWorkspaceSessions(workspaceId)
    if (sessions.length > 1) onProgress(`Restoring ${sessions.length} sessions...`)

    const result = await createWorkspace(projectId, {
      workspaceId,
      resume: true,
      ...(row.baseBranch !== undefined ? { branch: row.baseBranch } : {}),
      ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}),
      onProgress,
    })

    // Only after success, so a failed restart keeps its stop record. The
    // workspace is running either way, so a lost clear is only logged.
    await clearWorkspaceStopped(projectId, workspaceId).catch((err: unknown) => {
      serverLog(`[server] restart ${projectId}/${workspaceId}: clear stop: ${String(err)}`)
    })
    return result
  })
}

/**
 * The session a restart gives each conversation an agent ran in a terminal,
 * live when the workspace stopped: its agent was started by hand, so
 * nothing else would bring it back. It takes the posture of the workspace's
 * first session, else the driver's default for its tool.
 */
export async function terminalConversationSessions(
  projectId: string,
  workspaceId: string,
): Promise<SessionLaunchSettings[]> {
  const loose = (await listActiveConversations(projectId, workspaceId)).filter((l) => l.sessionId === undefined)
  if (loose.length === 0) return []
  const first = (await listWorkspaceSessions(workspaceId))[0]
  return loose.map((l) => ({
    tool: l.tool,
    mode: l.mode,
    permissionMode: first?.permissionMode ?? defaultPermissionMode(workspaceDriver().kind, l.tool),
    conversationId: l.conversationId,
    ...(l.model !== undefined ? { model: l.model } : {}),
  }))
}
