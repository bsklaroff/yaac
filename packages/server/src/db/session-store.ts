import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, isNull, max, sql } from 'drizzle-orm'
import { getDb } from './client'
import { sessions, workspaceConversations } from './schema'
import { appendUser, lacksUser } from './workspace-store'
import { notifyWorkspaceListChanged } from '#lib/notify'
import { nullsToUndefined, type NullsToUndefined } from '#lib/nulls'
import { normalizeTitle } from '@yaac/shared/titles'
import { MAX_MODEL_LENGTH, MAX_PROMPT_LENGTH } from '@yaac/shared/types'
import type { AgentMode, AgentTool, PermissionMode } from '@yaac/shared/types'

/**
 * Session rows (docs/sessions.md): what each agent of a workspace runs with,
 * and whether it is open. The user opens and closes them; what the agents
 * report (their conversation, model, posture, effort) arrives as a
 * `session-reported` event.
 */

export type SessionRow = NullsToUndefined<typeof sessions.$inferSelect>

/** What a session is opened with. */
export interface SessionLaunchSettings {
  tool: AgentTool
  mode: AgentMode
  permissionMode: PermissionMode
  model?: string
  effort?: string
  /** The message it opens with. */
  prompt?: string
  /** An earlier conversation of the project to resume, rather than a new
   *  one. */
  conversationId?: string
  /** The user's name for it. */
  title?: string
}

/**
 * The tmux window a session runs in: its tool, so a `tmux attach` shows
 * which agent each window holds, and enough of its id to be unique in the
 * workspace.
 */
export function sessionWindowName(tool: AgentTool, sessionId: string): string {
  return `${tool}-${sessionId.slice(0, 8)}`
}

/**
 * Record a new open session in a workspace, after its others. Its `acp`
 * prompt is held for its conversation (`takeSessionPrompt`); a `tui` one is
 * typed in by whoever launches it. A session opened on a conversation the
 * workspace already holds takes over its link.
 */
export async function insertSession(
  projectId: string,
  workspaceId: string,
  settings: SessionLaunchSettings,
): Promise<SessionRow> {
  const db = await getDb()
  const id = randomUUID()
  const prompt = settings.prompt?.slice(0, MAX_PROMPT_LENGTH)
  const title = settings.title === undefined ? '' : normalizeTitle(settings.title)
  const [row] = await db.insert(sessions).values({
    id,
    projectId,
    workspaceId,
    tool: settings.tool,
    mode: settings.mode,
    permissionMode: settings.permissionMode,
    ...(settings.model !== undefined ? { model: settings.model.slice(0, MAX_MODEL_LENGTH) } : {}),
    ...(settings.effort !== undefined ? { effort: settings.effort } : {}),
    ...(settings.conversationId !== undefined ? { conversationId: settings.conversationId } : {}),
    ...(title !== '' ? { title } : {}),
    ...(prompt !== undefined ? { firstPrompt: prompt } : {}),
    ...(prompt !== undefined && settings.mode === 'acp' ? { pendingPrompt: prompt } : {}),
    ordinal: sql`(${db.select({ n: sql`coalesce(${max(sessions.ordinal)} + 1, 0)` }).from(sessions)
      .where(eq(sessions.workspaceId, workspaceId))})`,
    window: sessionWindowName(settings.tool, id),
  }).returning()
  if (settings.conversationId !== undefined) {
    await db.update(workspaceConversations).set({ sessionId: id }).where(and(
      eq(workspaceConversations.workspaceId, workspaceId),
      eq(workspaceConversations.tool, settings.tool),
      eq(workspaceConversations.conversationId, settings.conversationId),
    ))
  }
  notifyWorkspaceListChanged()
  return nullsToUndefined(row)
}

/** A workspace's sessions in order; only the open ones unless `all`. */
export async function listWorkspaceSessions(
  workspaceId: string,
  { all = false }: { all?: boolean } = {},
): Promise<SessionRow[]> {
  const db = await getDb()
  const rows = await db.select().from(sessions)
    .where(all ? eq(sessions.workspaceId, workspaceId) : and(eq(sessions.workspaceId, workspaceId), isNull(sessions.closedAt)))
    .orderBy(asc(sessions.ordinal))
  return rows.map(nullsToUndefined)
}

/** The open sessions of several workspaces, by workspace id, in one query. */
export async function listOpenSessionsFor(workspaceIds: string[]): Promise<Map<string, SessionRow[]>> {
  const byWorkspace = new Map<string, SessionRow[]>()
  if (workspaceIds.length === 0) return byWorkspace
  const db = await getDb()
  const rows = await db.select().from(sessions)
    .where(and(inArray(sessions.workspaceId, workspaceIds), isNull(sessions.closedAt)))
    .orderBy(asc(sessions.ordinal))
  for (const r of rows) {
    byWorkspace.set(r.workspaceId, [...byWorkspace.get(r.workspaceId) ?? [], nullsToUndefined(r)])
  }
  return byWorkspace
}

export async function getSessionRow(sessionId: string): Promise<SessionRow | undefined> {
  const db = await getDb()
  const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId))
  return row === undefined ? undefined : nullsToUndefined(row)
}

/** Close a session for good. Returns whether it was open. */
export async function closeSessionRow(sessionId: string): Promise<boolean> {
  const db = await getDb()
  const closed = await db.update(sessions).set({ closedAt: new Date(), pendingPrompt: null })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.closedAt)))
    .returning({ id: sessions.id })
  if (closed.length > 0) notifyWorkspaceListChanged()
  return closed.length > 0
}

/** Set a session's title; blank clears it. */
export async function setSessionTitle(sessionId: string, title: string): Promise<void> {
  const db = await getDb()
  const normalized = normalizeTitle(title)
  await db.update(sessions).set({ title: normalized === '' ? null : normalized }).where(eq(sessions.id, sessionId))
  notifyWorkspaceListChanged()
}

/** Note that the sessions' windows were launched just now, in the
 *  workspace's current life. */
export async function markSessionsLaunched(sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return
  const db = await getDb()
  await db.update(sessions).set({ launchedAt: new Date() }).where(inArray(sessions.id, sessionIds))
}

/** Hold a session's prompt again, for its next conversation. Never replaces
 *  one already held. */
export async function holdSessionPrompt(sessionId: string, prompt: string): Promise<void> {
  const db = await getDb()
  await db.update(sessions).set({ pendingPrompt: prompt })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.pendingPrompt), isNull(sessions.closedAt)))
}

/**
 * Clear and return a session's held prompt, if any. The clear is conditional
 * on the value read, so of two callers racing to deliver it only one gets it.
 */
export async function takeSessionPrompt(sessionId: string): Promise<string | undefined> {
  const db = await getDb()
  const [row] = await db.select({ prompt: sessions.pendingPrompt }).from(sessions).where(eq(sessions.id, sessionId))
  const prompt = row?.prompt
  if (prompt == null) return undefined
  const taken = await db.update(sessions).set({ pendingPrompt: null })
    .where(and(eq(sessions.id, sessionId), eq(sessions.pendingPrompt, prompt)))
    .returning({ id: sessions.id })
  return taken[0] ? prompt : undefined
}

/** What a session's agent reported, each field only when it changed. */
export interface SessionReport {
  conversationId?: string
  model?: string
  permissionMode?: PermissionMode
  effort?: string
}

/** Record what a session's agent reported (`session-reported`). */
export async function recordSessionReport(sessionId: string, report: SessionReport): Promise<void> {
  const set = {
    ...(report.conversationId !== undefined ? { conversationId: report.conversationId } : {}),
    ...(report.model !== undefined ? { model: report.model.slice(0, MAX_MODEL_LENGTH) } : {}),
    ...(report.permissionMode !== undefined ? { permissionMode: report.permissionMode } : {}),
    ...(report.effort !== undefined ? { effort: report.effort } : {}),
  }
  if (Object.keys(set).length === 0) return
  const db = await getDb()
  await db.update(sessions).set(set).where(eq(sessions.id, sessionId))
}

/** Mark a waiting session as viewed by `userId`, clearing that user's unread
 *  dot on every client. Notifies only when the user is new to the spell. */
export async function recordSessionWaitingSeen(sessionId: string, userId: string): Promise<void> {
  const db = await getDb()
  const added = await db.update(sessions).set({ waitingSeenBy: appendUser(sessions.waitingSeenBy, userId) })
    .where(and(eq(sessions.id, sessionId), lacksUser(sessions.waitingSeenBy, userId)))
    .returning({ id: sessions.id })
  if (added.length > 0) notifyWorkspaceListChanged()
}

/** Forget who saw a session's waiting spell once it stops needing the user.
 *  Only a non-empty list is written, since this runs on every turn. */
export async function recordSessionWaitingUnseen(workspaceId: string, window: string): Promise<void> {
  const db = await getDb()
  await db.update(sessions).set({ waitingSeenBy: [] }).where(and(
    eq(sessions.workspaceId, workspaceId),
    eq(sessions.window, window),
    isNull(sessions.closedAt),
    sql`cardinality(${sessions.waitingSeenBy}) > 0`,
  ))
}
