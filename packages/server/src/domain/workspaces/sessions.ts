/**
 * A workspace's sessions (docs/sessions.md): opening one in a running
 * workspace, closing, resuming and renaming one, and the reconcile pass that
 * gives every open session of a running workspace a window.
 */
import { workspaceDriver } from '#drivers/driver'
import { authorizeProject, type Actor } from '#domain/access'
import {
  closeSessionRow,
  findWorkspaceRow,
  getSessionRow,
  insertSession,
  listWorkspaceConversations,
  listWorkspaceSessions,
  recordProjectCreate,
  setSessionTitle,
  type SessionRow,
} from '#db'
import { KEEPER_STARTING, type RuntimeSnapshot } from '#drivers/contract'
import { isWorkspaceTerminating, readWorkspaceWindows } from '#runtime/status'
import { tmuxCmd } from '#runtime/agents'
import { serverLog } from '#lib/log'
import { ServerError } from '@yaac/shared/errors'
import { resolveCreate } from './create'
import { launchSessions, launching, respawnSession } from './session-launch'
import { inFlightWorkspaceIds } from './provisioning'
import { claiming } from './prewarm'
import { resolveWorkspaceContainer } from './resolve'
import type { AgentMode, AgentTool, PermissionMode } from '@yaac/shared/types'

/** What a session is opened with; unnamed settings resolve as a create's. */
export interface OpenSessionRequest {
  tool?: AgentTool
  model?: string
  mode?: AgentMode
  permissionMode?: PermissionMode
  effort?: string
  prompt?: string
  /** One of the workspace's earlier conversations to resume. */
  resume?: string
  title?: string
  /** Remember the named settings as the project's defaults, as a create
   *  from a person does. */
  rememberDefaults?: boolean
}

/**
 * Open a session in a running workspace and launch its window. Its settings
 * resolve as a create's (`resolveCreate`). Answers with the row once its
 * window is launched; its agent coming up is the session's own business,
 * and one that dies is left exited.
 */
export async function openSession(
  principal: Actor,
  workspaceIdOrPrefix: string,
  request: OpenSessionRequest,
): Promise<SessionRow> {
  const workspace = await resolveWorkspaceContainer(workspaceIdOrPrefix, { requireRunning: true, owner: principal })
  const { projectId, workspaceId, jobName } = workspace
  const resumed = request.resume === undefined
    ? undefined
    : (await listWorkspaceConversations(projectId, workspaceId)).find((l) => l.conversationId === request.resume)
  if (request.resume !== undefined && resumed === undefined) {
    throw new ServerError('VALIDATION', `workspace ${workspaceId.slice(0, 8)} has no conversation ${request.resume}`)
  }
  // A resumed conversation keeps its own tool and protocol.
  const setup = await resolveCreate(projectId, {
    ...(request.tool !== undefined ? { tool: request.tool } : {}),
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.permissionMode !== undefined ? { permissionMode: request.permissionMode } : {}),
    ...(request.effort !== undefined ? { effort: request.effort } : {}),
    ...(request.mode !== undefined ? { mode: request.mode } : {}),
    ...(resumed !== undefined ? { tool: resumed.tool, mode: resumed.mode } : {}),
    ...(resumed?.model !== undefined && request.model === undefined ? { model: resumed.model } : {}),
  })
  if (request.rememberDefaults === true) {
    await recordProjectCreate(projectId, setup.tool, {
      ...(request.model !== undefined ? { model: request.model } : {}),
      ...(request.permissionMode !== undefined ? { permissionMode: request.permissionMode } : {}),
      ...(request.effort !== undefined ? { effort: request.effort } : {}),
      ...(request.mode !== undefined ? { mode: request.mode } : {}),
    })
  }
  const session = await insertSession(projectId, workspaceId, {
    ...setup,
    ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
    ...(request.resume !== undefined ? { conversationId: request.resume } : {}),
    ...(request.title !== undefined ? { title: request.title } : {}),
  })
  try {
    await launchSessions({ projectId, workspaceId, jobName }, [session])
  } catch (err) {
    // A session that could not launch is not left behind to be retried.
    await closeSessionRow(session.id)
    throw err
  }
  return session
}

/** An open session the caller owns, with its workspace. */
async function ownedSession(principal: Actor, sessionId: string): Promise<SessionRow> {
  const session = await getSessionRow(sessionId)
  if (session === undefined || session.closedAt !== undefined) {
    throw new ServerError('NOT_FOUND', `no open session ${sessionId}`)
  }
  await authorizeProject(principal, session.projectId)
  return session
}

/**
 * Close a session: stop its agent and keep its conversations as history.
 * The workspace keeps running, with no agent if this was its last session.
 */
export async function closeSession(principal: Actor, sessionId: string): Promise<SessionRow> {
  const session = await ownedSession(principal, sessionId)
  await closeSessionRow(session.id)
  const unit = await workspaceDriver().find(session.workspaceId).catch(() => undefined)
  if (unit?.running === true) {
    const runtime = workspaceDriver()
    await runtime.exec(
      unit.jobName,
      `${tmuxCmd(runtime.workspacePaths(unit.jobName))} kill-window -t yaac:${session.window} 2>/dev/null || true`,
      { maxAttempts: 1 },
    ).catch((err: unknown) => serverLog(`[server] closing session ${session.id}'s window failed: ${String(err)}`))
  }
  return session
}

/**
 * Relaunch a session whose agent exited, on its conversation, in the window
 * it kept; one whose window is gone gets a new one.
 */
export async function resumeSession(principal: Actor, sessionId: string): Promise<SessionRow> {
  const session = await ownedSession(principal, sessionId)
  const { jobName } = await resolveWorkspaceContainer(session.workspaceId, { requireRunning: true, exact: true })
  const workspace = { projectId: session.projectId, workspaceId: session.workspaceId, jobName }
  const kept = readWorkspaceWindows(session.projectId, session.workspaceId)?.some((w) => w.name === session.window)
  await (kept === true ? respawnSession(workspace, session) : launchSessions(workspace, [session]))
  return session
}

/** Name a session; blank clears the name. */
export async function renameSession(principal: Actor, sessionId: string, title: string): Promise<void> {
  const session = await ownedSession(principal, sessionId)
  await setSessionTitle(session.id, title)
}

/** How long a launched window may go unlisted before it counts as lost. */
const LAUNCH_GRACE_MS = 60_000

/**
 * The windows each workspace's watcher has listed in its current life, by
 * workspace id, so a session window that goes away (killed from tmux) can be
 * told from one not listed yet.
 */
const seen = new Map<string, { life: number; windows: Set<string> }>()

/**
 * Give every open session of a running workspace a window. A session with
 * none in this life is launched: one opened while the workspace was
 * stopped, or one whose launch a server restart cut off. A window seen and
 * then gone was killed from inside tmux, which closes its session as the
 * user's close does. An exited agent keeps its window, so it is never
 * relaunched here; only a resume or a restart does that.
 *
 * Skips workspaces still provisioning or being claimed, whose create
 * launches their sessions itself, and any whose setup has not finished.
 */
export async function reconcileSessions(view: RuntimeSnapshot): Promise<void> {
  const busy = new Set(inFlightWorkspaceIds(Date.now()))
  const running = (await view.workspaces()).filter((p) => p.running && !p.prewarmed && !p.terminating
    && !claiming.has(p.jobName) && !busy.has(p.workspaceId) && !isWorkspaceTerminating(p.workspaceId))
  const live = new Set(running.map((p) => p.workspaceId))
  for (const id of seen.keys()) if (!live.has(id)) seen.delete(id)
  await Promise.all(running.map(async (p) => {
    try {
      await reconcileWorkspaceSessions(p)
    } catch (err) {
      serverLog(`[server] sessions ${p.workspaceId}: ${String(err)}`)
    }
  }))
}

async function reconcileWorkspaceSessions(p: { projectId: string; workspaceId: string; jobName: string }): Promise<void> {
  const windows = readWorkspaceWindows(p.projectId, p.workspaceId)
  if (windows === undefined || windows.some((w) => w.name === KEEPER_STARTING)) return
  const row = await findWorkspaceRow(p.workspaceId)
  if (row?.lifeStartedAt === undefined || row.stoppedAt !== undefined) return
  const life = row.lifeStartedAt.getTime()
  let mark = seen.get(p.workspaceId)
  if (mark?.life !== life) {
    mark = { life, windows: new Set() }
    seen.set(p.workspaceId, mark)
  }
  const listed = new Set(windows.map((w) => w.name))
  const missing: SessionRow[] = []
  for (const s of await listWorkspaceSessions(p.workspaceId)) {
    if (launching.has(s.id)) continue
    if (listed.has(s.window)) {
      mark.windows.add(s.window)
      continue
    }
    if (mark.windows.has(s.window)) {
      await closeSessionRow(s.id)
      continue
    }
    const launched = s.launchedAt?.getTime()
    if (launched === undefined || launched < life || Date.now() - launched > LAUNCH_GRACE_MS) missing.push(s)
  }
  if (missing.length > 0) await launchSessions(p, missing)
}
