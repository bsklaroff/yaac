import { tearingDown, teardownForRestart } from './cleanup'
import { createWorkspace, type WorkspaceCreateResult } from './create'
import { resolveWorkspaceId } from './resolve'
import { provision, type ProvisionRun } from './provisioning'
import { readGroupRoom, refuseFullGroup } from './group-limits'
import {
  clearWorkspaceStopped,
  findWorkspaceRow,
  firstAgentSession,
  listActiveAgentSessions,
  type AgentSessionLinkRow,
} from '#db'
import { authorizeProject, type Actor } from '#domain/access'
import { workspaceDriver } from '#drivers/driver'
import { modelEfforts } from '#domain/auth'
import { serverLog } from '#lib/log'
import { ServerError } from '@yaac/shared/errors'
import { hasConversationHistory } from '#runtime/agents'
import { projectDir } from '@yaac/shared/project-paths'
import {
  effortFor,
  launchableModel,
  SELF_NAMING_TOOLS,
  TOOL_LABELS,
  type AgentMode,
  type AgentTool,
} from '@yaac/shared/types'

/**
 * Check a restart of a workspace id or prefix, running or stopped, and
 * register its provisioning row, filed under the workspace's group so it
 * keeps its place in the sidebar. Refuses a caller who does not own it, a
 * group at its workspace limit, and with `stoppedOnly` a workspace that is
 * running.
 *
 * The run tears down any running unit (keeping the checkout) and launches a
 * new one that resumes the conversations active when the workspace stopped,
 * each in its own window, refusing if one has lost its history. Teardown
 * leaves the active set as last observed, so a workspace comes back with the
 * agents it had. Config comes fresh from the project.
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
  // The unit's tool, else the first conversation's; claude if none was
  // recorded (an `acp` launch whose handshake failed).
  const tool = unit?.tool ?? (await firstAgentSession(projectId, workspaceId))?.tool ?? 'claude'
  // With nothing running or shutting down, nothing can still write history,
  // so a lost one is refused before the provisioning row exists: a plain
  // error rather than a failed row.
  const settled = !unit && !tearingDown(workspaceId)
    && await workspaceDriver().findForTeardown(workspaceId) === undefined
  const planned = settled ? await resumePlan(projectId, workspaceId, tool, row.mode) : undefined
  // A stopped workspace takes a slot in its group again; a running one
  // already holds its own.
  refuseFullGroup(await readGroupRoom(projectId, row.groupId), workspaceId)

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

    // Otherwise planned after the teardown, which checkpoints opencode's
    // database.
    const { active, resumes } = planned ?? await resumePlan(projectId, workspaceId, tool, row.mode)
    if (active.length > 1) onProgress(`Restoring ${active.length} agent sessions...`)

    // Relaunch in the recorded permission mode (e.g. `plan` must not come
    // back as `bypass`), and in the first conversation's agent mode (one per
    // workspace).
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
        ...(resumes[i] ? { resume: true } : {}),
      }
    })
    // What the row records: the launch tool's, so another tool's model never
    // lands there for a later fallback to hand a conversation on this one.
    const launch = resume.find((a) => a.tool === tool) ?? {
      model: row.model,
      effort: launchEffort(tool, row.model, row.effort, true),
    }

    const result = await createWorkspace(projectId, {
      workspaceId,
      tool,
      mode: active[0].mode,
      resume,
      ...(row.baseBranch !== undefined ? { branch: row.baseBranch } : {}),
      permissionMode: row.permissionMode,
      ...(launch.model !== undefined ? { model: launch.model } : {}),
      ...(launch.effort !== undefined ? { effort: launch.effort } : {}),
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
 * The conversations a restart brings back, and whether each resumes.
 *
 * Each resumes under its own tool if its history is on disk. One the rows
 * say wrote history but whose history is gone was lost to a crash or an
 * incomplete restore, so the restart fails rather than kill the agent with a
 * resume it cannot load or quietly start the work over. One with neither
 * starts as a create's would. With none active (an agent exited while an
 * init window kept tmux alive, or an acp handshake never finished), the one
 * brought back is the workspace's first, under its id, which may have
 * history of its own.
 */
async function resumePlan(
  projectId: string,
  workspaceId: string,
  tool: AgentTool,
  mode: AgentMode,
): Promise<{ active: Conversation[]; resumes: boolean[] }> {
  const recorded = await listActiveAgentSessions(projectId, workspaceId)
  const active: Conversation[] = recorded.length > 0 ? recorded : [{ tool, agentSessionId: workspaceId, mode }]
  const resumes = await Promise.all(active.map((a) => hasConversationHistory(projectId, workspaceId, a)))
  const lost = active.filter((a, i) => !resumes[i] && wroteHistory(a, workspaceId))
  if (lost.length > 0) {
    throw new ServerError('CONFLICT', `cannot restart: the history of ${lost.map((a) =>
      `${TOOL_LABELS[a.tool]} conversation ${a.agentSessionId}`).join(', ')} is gone from `
      + `${projectDir(projectId)}. Restore it from a backup to resume the workspace.`)
  }
  return { active, resumes }
}

/** What a restart reads of a conversation it brings back. */
type Conversation = Pick<AgentSessionLinkRow, 'tool' | 'agentSessionId' | 'mode' | 'model' | 'transcriptPath' | 'firstPrompt'>

/**
 * Whether the rows show a conversation's agent wrote it history: a
 * transcript the registry found (claude, codex, pi), an id a self-naming
 * tool chose rather than the workspace-id pin (opencode records no path), or
 * under acp a first message. Only asked once its history is not on disk, to
 * tell a lost conversation from one never written to, such as one in a
 * workspace stopped before its first prompt.
 */
function wroteHistory(a: Conversation, workspaceId: string): boolean {
  if (a.mode === 'acp') return a.firstPrompt !== undefined
  return a.transcriptPath !== undefined || (SELF_NAMING_TOOLS.includes(a.tool) && a.agentSessionId !== workspaceId)
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
