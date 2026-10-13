import { teardownForRestart } from './cleanup'
import { createWorkspace, type WorkspaceCreateResult } from './create'
import { resolveWorkspaceId } from './resolve'
import { provision, type ProvisionRun } from './provisioning'
import {
  clearWorkspaceStopped,
  findWorkspaceRow,
  firstAgentSession,
  listActiveAgentSessions,
} from '#db'
import { authorizeProject, type Actor } from '#domain/access'
import { workspaceDriver } from '#drivers/driver'
import { modelEfforts } from '#domain/auth'
import { serverLog } from '#lib/log'
import { ServerError } from '@yaac/shared/errors'
import { effortFor } from '@yaac/shared/types'

/**
 * Check a restart of a workspace id or prefix, running or stopped, and
 * register its provisioning row, filed under the workspace's group so it
 * keeps its place in the sidebar. Refuses a caller who does not own it.
 *
 * The run tears down any running unit (keeping the checkout) and launches a
 * new one that resumes the conversations active when the workspace stopped,
 * each in its own window. Teardown leaves the active set as last observed,
 * so a workspace comes back with the agents it had. Config comes fresh from
 * the project.
 */
export async function prepareRestart(
  principal: Actor,
  idOrPrefix: string,
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
  const jobName = unit?.jobName
  // The unit's tool, else the first conversation's; claude if none was
  // recorded (an `acp` launch whose handshake failed).
  const tool = unit?.tool ?? (await firstAgentSession(projectId, workspaceId))?.tool ?? 'claude'

  // The row also keeps `inFlightWorkspaceIds` reporting the workspace, which
  // stops the stale reaper deleting the dirs the new launch is about to
  // mount.
  return provision({
    workspaceId,
    projectId,
    tool,
    kind: 'restart',
    ...(row.groupId !== undefined ? { groupId: row.groupId } : {}),
  }, async (onProgress) => {
    if (jobName) onProgress(`Stopping session job ${jobName}...`)
    // Always: it also clears a leftover terminating mark.
    await teardownForRestart({ jobName: jobName ?? null, projectId, workspaceId })

    // Each conversation resumes under its own tool.
    const active = await listActiveAgentSessions(projectId, workspaceId)
    if (active.length > 1) onProgress(`Restoring ${active.length} agent sessions...`)

    // Relaunch in the recorded permission mode (e.g. `plan` must not come
    // back as `bypass`) and effort, and in the first conversation's agent
    // mode (one per workspace), else the mode the workspace launched in. An
    // `acp` launch whose handshake failed records no conversation.
    // The recorded effort is checked against the model the first
    // conversation last reported: one it lacks, or none recorded, relaunches
    // at that model's default, since a launch naming none would take
    // whatever the shared tool home holds.
    const model = active[0]?.model ?? row.model
    const effort = model !== undefined
      ? effortFor(modelEfforts(tool, model), row.effort)
      : row.effort

    const result = await createWorkspace(projectId, {
      workspaceId,
      tool,
      mode: active[0]?.mode ?? row.mode,
      resume: active,
      permissionMode: row.permissionMode,
      ...(effort !== undefined ? { effort } : {}),
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
