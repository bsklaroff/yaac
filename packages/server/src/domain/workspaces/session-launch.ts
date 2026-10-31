import { workspaceDriver } from '#drivers/driver'
import { loadToolAuthEntry, modelEfforts } from '#domain/auth'
import {
  getProjectRow,
  listWorkspaceConversations,
  markSessionsLaunched,
  type SessionRow,
} from '#db'
import {
  agentDriver,
  buildRespawnExec,
  buildWindowsExec,
  hasConversationHistory,
  verifyAgentWindowAlive,
  type SessionWindowSpec,
} from '#runtime/agents'
import { serverLog } from '#lib/log'
import { ServerError } from '@yaac/shared/errors'
import { projectDir } from '@yaac/shared/project-paths'
import {
  effortFor,
  launchableModel,
  launchablePermissionMode,
  SELF_NAMING_TOOLS,
  TOOL_LABELS,
  type AgentTool,
} from '@yaac/shared/types'
import type { WorkspacePaths } from '#drivers/contract'
import type { PiProvider } from '@yaac/shared/tool-providers'

/**
 * How a session's window is launched (docs/sessions.md): one builder shared
 * by a create, a restart, a claim and a session opened in a running
 * workspace, so each brings an agent up the same way from its row.
 */

/** A session's window, ready to open. */
export interface SessionLaunch extends SessionWindowSpec {
  session: SessionRow
  /** It resumes a conversation rather than starting one. */
  resume: boolean
}

/**
 * Each session's launch command, in its own mode, on its own model, posture
 * and effort. A session whose agent has named a conversation resumes it if
 * its history is where its tool keeps it; one the rows say wrote history
 * that is gone was lost to a crash or an incomplete restore, so the launch
 * fails naming it rather than resume an id the tool cannot find (which kills
 * the agent) or quietly start the work over. Only a missing file counts as
 * gone; any other read error fails the launch as itself.
 *
 * A fresh session's conversation id is its own id, which claude and pi take
 * at launch (`--session-id`); one that ran but never reported it is found
 * by that id and resumed. An `acp` agent mints its own id, so its record is
 * named for the session until it does.
 */
export async function sessionLaunches(
  projectId: string,
  workspaceId: string,
  sessions: SessionRow[],
  paths: WorkspacePaths,
  opts: { beforeCheckout?: boolean } = {},
): Promise<SessionLaunch[]> {
  const plans = await planSessionResumes(projectId, workspaceId, sessions)
  const piProvider = sessions.some((s) => s.tool === 'pi') ? await piProviderFor(projectId) : undefined
  return plans.map(({ session: s, conversationId, resume }) => {
    const model = s.model !== undefined ? launchableModel(s.tool, s.model) : undefined
    const effort = launchEffort(s.tool, model, s.effort)
    return {
      session: s,
      tool: s.tool,
      window: s.window,
      resume,
      ...(resume ? { resumes: conversationId } : {}),
      // `YAAC_SESSION_ID` tells the agent's own commands which session they
      // run in, which `yaac-mama` reports (`mamaCaller`).
      cmd: `export YAAC_SESSION_ID=${s.id}; ` + agentDriver(s.mode).launchCmd({
        tool: s.tool,
        conversationId,
        resume,
        windowName: s.window,
        paths,
        permissionMode: launchablePermissionMode(s.tool, s.permissionMode),
        ...(s.tool === 'pi' && piProvider !== undefined ? { piProvider } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(effort !== undefined ? { effort } : {}),
        ...(opts.beforeCheckout === true && s.mode === 'acp' ? { beforeCheckout: true } : {}),
      }),
    }
  })
}

/**
 * Which conversation each session launches on, and whether it resumes it;
 * refuses (`CONFLICT`) when one the rows say wrote history has lost it (see
 * `sessionLaunches`).
 */
export async function planSessionResumes(
  projectId: string,
  workspaceId: string,
  sessions: SessionRow[],
): Promise<Array<{ session: SessionRow; conversationId: string; resume: boolean }>> {
  if (sessions.length === 0) return []
  const links = await listWorkspaceConversations(projectId, workspaceId)
  const plans = await Promise.all(sessions.map(async (s) => {
    const named = s.conversationId
    const candidate = named ?? (s.mode === 'tui' && !SELF_NAMING_TOOLS.includes(s.tool) ? s.id : undefined)
    const resume = candidate !== undefined
      && await hasConversationHistory(projectId, workspaceId, { tool: s.tool, conversationId: candidate })
    if (named !== undefined && !resume) {
      const link = links.find((l) => l.tool === s.tool && l.conversationId === named)
      const wrote = s.mode === 'acp' ? link?.firstPrompt !== undefined
        : link?.transcriptPath !== undefined || SELF_NAMING_TOOLS.includes(s.tool)
      if (wrote) return { session: s, lost: named }
    }
    return { session: s, conversationId: resume && candidate !== undefined ? candidate : s.id, resume }
  }))
  const lost = plans.flatMap((p) => ('lost' in p ? [`${TOOL_LABELS[p.session.tool]} conversation ${p.lost}`] : []))
  if (lost.length > 0) {
    throw new ServerError('CONFLICT', `cannot launch: the history of ${lost.join(', ')} is gone from `
      + `${projectDir(projectId)}. Restore it from a backup to resume it.`)
  }
  return plans.flatMap((p) => (p.conversationId !== undefined ? [{ session: p.session, conversationId: p.conversationId, resume: p.resume }] : []))
}

/**
 * Sessions whose windows a call is launching right now, which the reconcile
 * pass leaves alone (`reconcileSessions`): their windows are not listed
 * yet, and a second launch would open a second window under the same name.
 */
export const launching = new Set<string>()

/**
 * Open sessions' windows in a running workspace that has finished its
 * setup, then type each new `tui` session's opening message into it. An
 * `acp` one's waits on its row for the registry to send once its
 * conversation is up. Checks the agents came up without waiting on it: one
 * that dies leaves its session exited, for the user to resume or close.
 */
export async function launchSessions(
  workspace: { projectId: string; workspaceId: string; jobName: string },
  sessions: SessionRow[],
): Promise<void> {
  const { projectId, workspaceId, jobName } = workspace
  const runtime = workspaceDriver()
  const paths = runtime.workspacePaths(jobName)
  const ids = sessions.map((s) => s.id).filter((id) => !launching.has(id))
  if (ids.length === 0) return
  for (const id of ids) launching.add(id)
  let launches: SessionLaunch[]
  try {
    const mine = sessions.filter((s) => ids.includes(s.id))
    for (const s of new Set(mine.map((x) => `${x.tool}|${x.mode}`))) {
      const [tool, mode] = s.split('|') as [AgentTool, SessionRow['mode']]
      await runtime.assertCanLaunch({ tool, mode })
    }
    launches = await sessionLaunches(projectId, workspaceId, mine, paths)
    if (launches.length === 0) return
    await runtime.exec(jobName, buildWindowsExec([], launches, paths))
    await markSessionsLaunched(launches.map((l) => l.session.id))
  } finally {
    for (const id of ids) launching.delete(id)
  }
  void verifyAgentWindowAlive(jobName, launches.map((l) => l.window)).catch((err: unknown) => {
    serverLog(`[server] sessions ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`)
  })
  await Promise.all(launches.map((l) => deliverTuiPrompt(workspace, l)))
}

/**
 * Relaunch a session whose agent exited, in its kept window, on its
 * conversation. The window stays listed throughout, so the reconcile pass
 * never takes it for one killed from tmux.
 */
export async function respawnSession(
  workspace: { projectId: string; workspaceId: string; jobName: string },
  session: SessionRow,
): Promise<void> {
  const runtime = workspaceDriver()
  const paths = runtime.workspacePaths(workspace.jobName)
  const [launch] = await sessionLaunches(workspace.projectId, workspace.workspaceId, [session], paths)
  if (launch === undefined) return
  await runtime.exec(workspace.jobName, buildRespawnExec(launch, paths))
  await markSessionsLaunched([session.id])
}

/** Whether this launch types its session's opening message in: a `tui`
 *  session's first launch, never a resume. */
export function typesOpeningMessage(launch: SessionLaunch): boolean {
  const { session } = launch
  return session.mode === 'tui' && session.firstPrompt !== undefined && !launch.resume && session.launchedAt === undefined
}

/** Type a session's opening message into its agent when this launch does
 *  (`typesOpeningMessage`). */
export async function deliverTuiPrompt(
  workspace: { projectId: string; workspaceId: string; jobName: string },
  launch: SessionLaunch,
): Promise<void> {
  const { session } = launch
  if (!typesOpeningMessage(launch) || session.firstPrompt === undefined) return
  await agentDriver('tui').deliverPrompt(workspace, session.window, session.firstPrompt).catch((err: unknown) => {
    serverLog(`[server] session ${session.id}: opening message failed: ${String(err)}`)
  })
}

/** The project owner's stored pi provider. */
async function piProviderFor(projectId: string): Promise<PiProvider | undefined> {
  const owner = (await getProjectRow(projectId))?.owner
  return owner === undefined ? undefined : (await loadToolAuthEntry(owner, 'pi'))?.piProvider
}

/**
 * The effort a session launches at: its recorded one where its model has
 * that level, else the model's default (docs/effort-levels.md).
 */
function launchEffort(tool: AgentTool, model: string | undefined, recorded: string | undefined): string | undefined {
  const efforts = model !== undefined ? modelEfforts(tool, model) : undefined
  return efforts !== undefined ? effortFor(efforts, recorded) : recorded
}
