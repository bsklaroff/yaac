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
import { effortFor, launchableModel, type AgentTool } from '@yaac/shared/types'

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
    // back as `bypass`), and in the first conversation's agent mode (one per
    // workspace), else the mode the workspace launched in. An `acp` launch
    // whose handshake failed records no conversation.
    //
    // Each conversation relaunches on the model it last reported, since a
    // launch naming none would take whatever the shared tool home holds. The
    // row's model is the first agent's at launch, so only a first
    // conversation on the launch tool falls back to it.
    const resume = active.map((a, i) => {
      const reported = a.model !== undefined ? launchableModel(a.tool, a.model) : undefined
      const model = reported ?? (i === 0 && a.tool === tool ? row.model : undefined)
      const effort = launchEffort(a.tool, model, row.effort, a.tool === tool)
      return {
        agentSessionId: a.agentSessionId,
        tool: a.tool,
        ...(model !== undefined ? { model } : {}),
        ...(effort !== undefined ? { effort } : {}),
      }
    })
    // What the row records: the launch tool's, so another tool's model never
    // lands there for a later fallback to hand a conversation on this one.
    // Also what a workspace with no conversation launches on.
    const launch = resume.find((a) => a.tool === tool) ?? {
      model: row.model,
      effort: launchEffort(tool, row.model, row.effort, true),
    }

    const result = await createWorkspace(projectId, {
      workspaceId,
      tool,
      mode: active[0]?.mode ?? row.mode,
      resume,
      permissionMode: row.permissionMode,
      ...(launch.model !== undefined ? { model: launch.model } : {}),
      ...(launch.effort !== undefined ? { effort: launch.effort } : {}),
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
 * The effort a conversation relaunches at: the recorded one where its model
 * has that level, else the model's default (docs/effort-levels.md). The
 * row's effort is in the launch tool's words, so a conversation on another
 * tool takes it only once its model's levels confirm it.
 */
function launchEffort(
  tool: AgentTool,
  model: string | undefined,
  recorded: string | undefined,
  launchTool: boolean,
): string | undefined {
  const efforts = model !== undefined ? modelEfforts(tool, model) : undefined
  if (efforts !== undefined) return effortFor(efforts, recorded)
  return launchTool ? recorded : undefined
}
