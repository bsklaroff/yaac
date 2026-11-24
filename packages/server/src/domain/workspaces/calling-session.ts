import { getWorkspaceRow, listWorkspaceSessions, type SessionRow } from '#db'
import type { Actor } from '#domain/access'
import {
  isRankedPermissionMode,
  launchableModel,
  morePermissive,
  type AgentMode,
  type AgentTool,
  type PermissionMode,
} from '@yaac/shared/types'

/** What a workspace's calling session runs, which is its delegate's
 *  ceiling and what it starts takes after where it names nothing. */
export interface CallingSession {
  /** The session, when the claimed one is open in the workspace. */
  sessionId?: string
  tool: AgentTool
  /** Its current model, as its agent last reported it, when launchable. */
  model?: string
  permissionMode: PermissionMode
  mode: AgentMode
}

/**
 * The session a workspace's call speaks for, from the session its agent
 * says it runs in (`YAAC_SESSION_ID`, which every session's launch sets).
 * The claim counts only as one of the workspace's open sessions. A call
 * from outside any session, such as a user's shell, gets the strictest
 * posture among the open sessions; with none open, among those closed
 * during its current life, since an agent's detached child can outlive its
 * session; and with neither, none. Anything in the workspace could claim
 * any of its sessions, so this is a guardrail, not a boundary
 * (docs/permission-modes.md).
 */
export async function callingSession(
  workspace: { workspaceId: string; projectId: string },
  claimedSessionId: string | undefined,
): Promise<CallingSession | undefined> {
  const { workspaceId, projectId } = workspace
  const sessions = await listWorkspaceSessions(workspaceId, { all: true })
  const open = sessions.filter((s) => s.closedAt === undefined)
  const own = open.find((s) => s.id === claimedSessionId)
  const lifeStarted = (await getWorkspaceRow(projectId, workspaceId))?.lifeStartedAt
  const closedThisLife = sessions.filter((s) =>
    s.closedAt !== undefined && lifeStarted !== undefined && s.closedAt >= lifeStarted)
  const lead = own ?? strictest(open) ?? strictest(closedThisLife)
  if (lead === undefined) return undefined
  // Anything in the workspace can set a reported model, so only a
  // launchable one is passed on.
  const model = lead.model !== undefined ? launchableModel(lead.tool, lead.model) : undefined
  return {
    ...(own !== undefined ? { sessionId: own.id } : {}),
    tool: lead.tool,
    ...(model !== undefined ? { model } : {}),
    permissionMode: lead.permissionMode,
    mode: lead.mode,
  }
}

/** The calling session of a workspace's delegate, whose tool, model and
 *  agent mode what it starts takes where it names none; none for anyone
 *  else. */
export async function delegateSession(actor: Actor | undefined): Promise<CallingSession | undefined> {
  if (actor?.kind !== 'delegate' || actor.via.kind !== 'workspace' || actor.projectId === undefined) return undefined
  return await callingSession({ workspaceId: actor.via.id, projectId: actor.projectId }, actor.via.sessionId)
}

/** The session in the strictest posture; a posture this build does not
 *  rank counts as stricter than any it does. */
function strictest(sessions: SessionRow[]): SessionRow | undefined {
  const stricter = (a: PermissionMode, b: PermissionMode): boolean =>
    !isRankedPermissionMode(a) || (isRankedPermissionMode(b) && morePermissive(b, a))
  return sessions.reduce<SessionRow | undefined>(
    (best, s) => (best === undefined || stricter(s.permissionMode, best.permissionMode) ? s : best), undefined)
}
