import { getWorkspaceRow, listWorkspaceSessions, type SessionRow } from '#db'
import { actorLabel, authorizeProject, requireWithinCeiling, type Actor } from '#domain/access'
import { agentDriver, resolveAgentPermissionMode } from '#runtime/agents'
import { liveAgents } from '#runtime/status'
import { stripControlChars } from '@yaac/shared/ansi'
import { ServerError } from '@yaac/shared/errors'
import type { AgentTool } from '@yaac/shared/types'
import { resolveWorkspaceContainer, resolveWorkspaceRecord } from './resolve'

/** Deliveries under way, by sender and by target session. */
const sending = new Set<string>()

/**
 * Send a message to a running workspace's agent, as if its user typed it:
 * its first open session, or the one `session` or `conversation` names (by
 * id or unique prefix). A busy acp agent takes it mid-turn or queues it. A
 * tui agent gets it submitted on its own, around any draft its user left
 * in the input box, and its own UI queues it if a turn is running
 * (`buildMessageCmd`). The message is headed with who sent it, so the agent
 * can tell a peer's words from its user's and knows where to answer; only
 * that first line is the server's.
 *
 * A delegate may message only a session no more permissive than its
 * ceiling, by its row and by its agent's latest report, or it would act
 * through a grant it was never given, and never its own calling session,
 * where the paste would land in its own running turn. One delivery at a
 * time per sender and per target, so pastes never interleave.
 */
export async function sendMessage(
  actor: Actor,
  idOrPrefix: string,
  request: { message: string; session?: string; conversation?: string },
): Promise<{ workspaceId: string; sessionId: string; tool: AgentTool }> {
  // Bound for a terminal whatever the agent's mode, so stripped here once.
  const body = stripControlChars(request.message)
  if (body.trim() === '') throw new ServerError('VALIDATION', 'send needs a message')
  const { projectId, workspaceId } = await resolveWorkspaceRecord(idOrPrefix)
  await authorizeProject(actor, projectId, 'delegate')
  const short = workspaceId.slice(0, 8)
  const running = await resolveWorkspaceContainer(workspaceId, { requireRunning: true, exact: true })
    .catch((err: unknown) => {
      if (err instanceof ServerError && (err.code === 'NOT_FOUND' || err.code === 'CONFLICT')) return undefined
      throw err
    })
  if (!running) {
    throw new ServerError('CONFLICT', (await getWorkspaceRow(projectId, workspaceId))?.stoppedAt !== undefined
      ? `workspace ${short} is stopped; restart it, then send once it is running`
      : `workspace ${short} is not running`)
  }

  const own = actor.kind === 'delegate' ? actor.via.sessionId : undefined
  const sessions = (await listWorkspaceSessions(workspaceId)).filter((s) => s.id !== own)
  const bySession = request.session?.trim() ?? ''
  const byConversation = request.conversation?.trim() ?? ''
  const pick = (wanted: string, key: (s: SessionRow) => string | undefined): SessionRow[] => {
    const exact = sessions.find((s) => key(s) === wanted)
    return exact !== undefined ? [exact] : sessions.filter((s) => key(s)?.startsWith(wanted) === true)
  }
  const matches = bySession !== '' ? pick(bySession, (s) => s.id)
    : byConversation !== '' ? pick(byConversation, (s) => s.conversationId)
    : sessions.slice(0, 1)
  if (matches.length !== 1) {
    const named = bySession !== '' ? `agent '${bySession}'` : `conversation '${byConversation}'`
    throw new ServerError(matches.length === 0 ? 'NOT_FOUND' : 'VALIDATION',
      bySession === '' && byConversation === '' ? `${short} has no other agent to send to`
        : matches.length === 0 ? `no ${bySession !== '' ? 'running' : 'open'} ${named} in ${short}`
        : `${named} matches more than one agent in ${short} — use a longer prefix`)
  }
  const [session] = matches
  const { conversationId } = session
  const label = `${short}'s ${session.tool} agent ${session.id.slice(0, 8)}`
  if (conversationId === undefined) throw new ServerError('CONFLICT', `${label} has no conversation yet; try again once its agent is up`)

  // The row follows what the agent reports; its latest report is checked
  // too, in case it moved since the last pass recorded it.
  const reported = liveAgents(projectId, workspaceId)?.find((a) => a.handle === session.window)?.reportedMode
  for (const posture of [
    session.permissionMode,
    reported === undefined ? session.permissionMode : resolveAgentPermissionMode(session.mode, session.tool, reported, session.permissionMode),
  ]) {
    if (posture === undefined) throw new ServerError('CONFLICT', `cannot tell which permission mode ${label} runs in, so it cannot be sent a message`)
    requireWithinCeiling(actor, posture, label)
  }

  const sender = actor.kind === 'delegate' ? actor.via.sessionId ?? actor.via.id : actorLabel(actor)
  const from = `from:${sender}`
  const to = `to:${session.id}`
  if (sending.has(from)) throw new ServerError('CONFLICT', 'your previous send is still being delivered; send again once it returns')
  if (sending.has(to)) throw new ServerError('CONFLICT', `another message to ${label} is still being delivered; try again shortly`)
  sending.add(from).add(to)
  const heading = actor.kind === 'delegate' && actor.via.kind === 'workspace'
    ? `Sent from ${actor.via.id} via yaac-mama:`
    : `Sent by ${actorLabel(actor)} via yaac workspace send:`
  try {
    await agentDriver(session.mode).deliverPrompt(
      { projectId, workspaceId, jobName: running.jobName },
      session.window,
      `${heading}\n\n${body}`,
      { tool: session.tool, conversationId },
    )
  } catch (err) {
    throw new ServerError('CONFLICT', `not delivered to ${label}: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    sending.delete(from)
    sending.delete(to)
  }
  return { workspaceId, sessionId: session.id, tool: session.tool }
}
