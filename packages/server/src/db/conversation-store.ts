import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { getDb } from './client'
import { conversations, workspaceConversations, workspaces } from './schema'
import type { CapturedConversation } from './events'
import { MAX_MODEL_LENGTH, MAX_PROMPT_LENGTH, SELF_NAMING_TOOLS } from '@yaac/shared/types'
import type { AgentMode, AgentTool } from '@yaac/shared/types'
import { nullsToUndefined } from '#lib/nulls'

/**
 * Conversation rows: `conversations` (one row per tool-native conversation,
 * project-scoped like the tool homes) and `workspace_conversations` (which
 * conversations belong to which workspace, and which were live).
 *
 * Everything here is discovered by the registry reconciler, so writes are
 * upserts and failures are non-fatal: the next tick retries. The exception
 * in importance is `setActiveConversations`, whose last set survives
 * teardown and is what a restart brings back.
 */

export interface ConversationRow {
  projectId: string
  tool: AgentTool
  conversationId: string
  /** Which protocol drives it (see the `mode` column). */
  mode: AgentMode
  createdAt: Date
  /** Project-relative, as stored. `#domain/workspaces` resolves it to a
   *  file against the recording tool's home. */
  transcriptPath?: string
  firstPrompt?: string
  /** The title the agent gave it (see the `title` column). */
  title?: string
  lastActiveAt?: Date
  /** The model it is running (see the `model` column). Absent until the
   *  launch or the agent names one. */
  model?: string
}

/** A conversation's membership of one workspace. */
export interface ConversationLinkRow extends ConversationRow {
  workspaceId: string
  active: boolean
  ordinal: number
  paneId?: string
  firstSeenAt: Date
  lastSeenAt: Date
}

/** What the reconciler knows about one conversation on one tick. */
export interface ObservedConversation {
  tool: AgentTool
  conversationId: string
  /** Defaults to 'tui'. Set only on insert: a conversation can't change
   *  protocol, and a later wrong guess must not overwrite what the create
   *  recorded. */
  mode?: AgentMode
  /** Project-relative, so it survives the data dir moving (see
   *  `toProjectRelative`). */
  transcriptPath?: string
  firstPrompt?: string
  /** The title the agent gave it. Absent leaves a recorded one alone. */
  title?: string
  lastActiveMs?: number
  /** The model the agent last reported. Absent means "not reported" and
   *  leaves a recorded value alone. */
  model?: string
  /** First observation time, used as the conversation's creation time when
   *  it is new to the DB. */
  firstSeenMs?: number
  /** The pane it is live on right now, if any. */
  paneId?: string
}

/**
 * Upsert the conversations discovered in a workspace and link them to it.
 *
 * Ordinals follow first appearance, so ordinal 0 is the original agent (its
 * window keeps the `yaac:<tool>` name and a restart brings it up first).
 * Existing links keep their ordinal, so resuming an old conversation doesn't
 * reshuffle a restart's window order.
 *
 * Exception: the pin, the conversation a create records under the workspace
 * id before any agent names one. For `SELF_NAMING_TOOLS` (codex, opencode)
 * that id is a placeholder, so the first named conversation of that tool
 * takes over the pin's link, ordinal and recorded data (prompt, launch
 * model, creation time), and the pin is deleted. claude and pi run under the
 * pin id itself.
 *
 * Does not touch `active`; only `setActiveConversations` writes it.
 */
export async function recordConversations(
  projectId: string,
  workspaceId: string,
  discovered: ObservedConversation[],
): Promise<void> {
  if (discovered.length === 0) return
  try {
    // One transaction, so a pin is never deleted without its replacement.
    await (await getDb()).transaction(async (db) => {
      const now = new Date()
      const existing = await db.select({
        tool: workspaceConversations.tool,
        conversationId: workspaceConversations.conversationId,
        ordinal: workspaceConversations.ordinal,
      }).from(workspaceConversations).where(linkKey(projectId, workspaceId))
      const ordinalOf = new Map(existing.map((e) => [`${e.tool}/${e.conversationId}`, e.ordinal]))
      let nextOrdinal = existing.reduce((max, e) => Math.max(max, e.ordinal + 1), 0)

      for (const reported of discovered) {
        const linkId = `${reported.tool}/${reported.conversationId}`
        const pinId = `${reported.tool}/${workspaceId}`
        const pinOrdinal = SELF_NAMING_TOOLS.includes(reported.tool) && !ordinalOf.has(linkId)
          ? ordinalOf.get(pinId)
          : undefined
        let d = reported
        if (pinOrdinal !== undefined) {
          // Carry over the pin's creation time and launch model (unless the
          // agent reported its own), and always its prompt: a `--prompt` is
          // the real opening message, which opencode's own transcript does
          // not give.
          const [pin] = await db.delete(conversations).where(and(
            eq(conversations.projectId, projectId),
            eq(conversations.tool, reported.tool),
            eq(conversations.conversationId, workspaceId),
          )).returning()
          await db.delete(workspaceConversations).where(and(
            linkKey(projectId, workspaceId),
            eq(workspaceConversations.tool, reported.tool),
            eq(workspaceConversations.conversationId, workspaceId),
          ))
          d = {
            ...(pin !== undefined ? { firstSeenMs: pin.createdAt.getTime() } : {}),
            ...(pin?.model != null ? { model: pin.model } : {}),
            ...reported,
            ...(pin?.firstPrompt != null ? { firstPrompt: pin.firstPrompt } : {}),
          }
          ordinalOf.delete(pinId)
          ordinalOf.set(linkId, pinOrdinal)
        }
        const seenAt = d.firstSeenMs !== undefined ? new Date(d.firstSeenMs) : now
        // Already project-relative. Absent means unknown, so the fill below
        // omits the column rather than clearing a good stored value.
        const stored = d.transcriptPath ?? null
        // Only fill in, so a conversation rediscovered from a second workspace
        // keeps what the first learned. Built first because drizzle rejects
        // an empty `set`; an id-only sighting takes the DO NOTHING branch.
        const fill = {
          ...(stored !== null ? { transcriptPath: stored } : {}),
          ...(d.lastActiveMs !== undefined ? { lastActiveAt: new Date(d.lastActiveMs) } : {}),
          // Overwritten, not coalesced, to follow `/model`. An absent value
          // leaves the stored one alone.
          ...(d.model !== undefined ? { model: d.model.slice(0, MAX_MODEL_LENGTH) } : {}),
          ...(d.title !== undefined ? { title: d.title } : {}),
          ...(d.firstPrompt !== undefined
            ? {
              // Keep the first value: a compacted transcript would otherwise
              // replace the opening message.
              firstPrompt: sql`coalesce(${conversations.firstPrompt}, ${d.firstPrompt.slice(0, MAX_PROMPT_LENGTH)})`,
            }
            : {}),
        }
        const values = {
          projectId,
          tool: d.tool,
          conversationId: d.conversationId,
          createdAt: seenAt,
          mode: d.mode ?? 'tui',
          transcriptPath: stored,
          firstPrompt: d.firstPrompt?.slice(0, MAX_PROMPT_LENGTH) ?? null,
          title: d.title ?? null,
          lastActiveAt: d.lastActiveMs !== undefined ? new Date(d.lastActiveMs) : null,
          model: d.model?.slice(0, MAX_MODEL_LENGTH) ?? null,
        }
        const target = [
          conversations.projectId,
          conversations.tool,
          conversations.conversationId,
        ]
        await (Object.keys(fill).length > 0
          ? db.insert(conversations).values(values).onConflictDoUpdate({ target, set: fill })
          : db.insert(conversations).values(values).onConflictDoNothing({ target }))

        const ordinal = ordinalOf.get(linkId) ?? nextOrdinal++
        await db.insert(workspaceConversations).values({
          projectId,
          workspaceId,
          tool: d.tool,
          conversationId: d.conversationId,
          ordinal,
          paneId: d.paneId ?? null,
          firstSeenAt: seenAt,
          lastSeenAt: now,
        }).onConflictDoUpdate({
          target: [
            workspaceConversations.projectId,
            workspaceConversations.workspaceId,
            workspaceConversations.tool,
            workspaceConversations.conversationId,
          ],
          set: { lastSeenAt: now, paneId: d.paneId ?? null },
        })
      }
    })
  } catch {
    // Non-fatal: discovery is idempotent, so the next tick re-records.
  }
}

const linkKey = (projectId: string, workspaceId: string) => and(
  eq(workspaceConversations.projectId, projectId),
  eq(workspaceConversations.workspaceId, workspaceId),
)

/**
 * Set which of a workspace's conversations are live, from the panes observed
 * this tick; every other linked conversation goes inactive.
 *
 * Call only while the runtime is observed running. Teardown must leave the
 * last set alone, since it is what a restart brings back.
 */
export async function setActiveConversations(
  projectId: string,
  workspaceId: string,
  live: Array<{ tool: AgentTool; conversationId: string; paneId?: string }>,
): Promise<void> {
  try {
    const db = await getDb()
    const now = new Date()
    const liveIds = live.map((l) => `${l.tool}/${l.conversationId}`)
    const rows = await db.select({
      tool: workspaceConversations.tool,
      conversationId: workspaceConversations.conversationId,
      active: workspaceConversations.active,
      paneId: workspaceConversations.paneId,
    }).from(workspaceConversations).where(linkKey(projectId, workspaceId))

    for (const row of rows) {
      const isLive = liveIds.includes(`${row.tool}/${row.conversationId}`)
      const paneId = live.find(
        (l) => l.tool === row.tool && l.conversationId === row.conversationId,
      )?.paneId
      // Skip unchanged rows; this runs every tick for every conversation.
      if (row.active === isLive && (!isLive || row.paneId === (paneId ?? null))) continue
      await db.update(workspaceConversations).set({
        active: isLive,
        lastSeenAt: now,
        ...(isLive ? { paneId: paneId ?? null } : {}),
      }).where(and(
        linkKey(projectId, workspaceId),
        eq(workspaceConversations.tool, row.tool),
        eq(workspaceConversations.conversationId, row.conversationId),
      ))
    }
  } catch {
    // Non-fatal: the next tick re-observes the same panes.
  }
}

/** Join shape shared by the link readers. */
function selectLinked() {
  return {
    projectId: workspaceConversations.projectId,
    workspaceId: workspaceConversations.workspaceId,
    tool: workspaceConversations.tool,
    conversationId: workspaceConversations.conversationId,
    mode: conversations.mode,
    active: workspaceConversations.active,
    ordinal: workspaceConversations.ordinal,
    paneId: workspaceConversations.paneId,
    firstSeenAt: workspaceConversations.firstSeenAt,
    lastSeenAt: workspaceConversations.lastSeenAt,
    createdAt: conversations.createdAt,
    transcriptPath: conversations.transcriptPath,
    firstPrompt: conversations.firstPrompt,
    title: conversations.title,
    lastActiveAt: conversations.lastActiveAt,
    model: conversations.model,
  }
}

/**
 * The link-to-conversation join. A function rather than a module-scope const
 * so the table references are read at call time, avoiding any dependence on
 * module load order.
 */
const linkJoin = () => and(
  eq(workspaceConversations.projectId, conversations.projectId),
  eq(workspaceConversations.tool, conversations.tool),
  eq(workspaceConversations.conversationId, conversations.conversationId),
)

/** One workspace's conversations, in restore order. */
export async function listWorkspaceConversations(
  projectId: string,
  workspaceId: string,
): Promise<ConversationLinkRow[]> {
  const db = await getDb()
  const rows = await db.select(selectLinked())
    .from(workspaceConversations)
    .innerJoin(conversations, linkJoin())
    .where(linkKey(projectId, workspaceId))
    .orderBy(asc(workspaceConversations.ordinal))
  return rows.map(nullsToUndefined)
}

/**
 * The conversations a restart should bring back: those that were live when
 * the workspace was last observed running, in window order.
 */
export async function listActiveConversations(
  projectId: string,
  workspaceId: string,
): Promise<ConversationLinkRow[]> {
  const db = await getDb()
  const rows = await db.select(selectLinked())
    .from(workspaceConversations)
    .innerJoin(conversations, linkJoin())
    .where(and(linkKey(projectId, workspaceId), eq(workspaceConversations.active, true)))
    .orderBy(asc(workspaceConversations.ordinal))
  return rows.map(nullsToUndefined)
}

/**
 * A workspace's active conversations that have a handle (pane id). An ACP
 * driver attaching to a running workspace uses these to re-address agents it
 * did not start, and to `session/load` after a restart.
 *
 * A read failure returns an empty list, so the watcher attaches without
 * history rather than failing the workspace's status stream.
 */
export async function recordedConversationHandles(
  projectId: string,
  workspaceId: string,
): Promise<Array<{ handle: string; conversationId: string }>> {
  const links = await listActiveConversations(projectId, workspaceId).catch(() => [])
  return links.flatMap((l) => (l.paneId === undefined
    ? []
    : [{ handle: l.paneId, conversationId: l.conversationId }]))
}

/**
 * The conversations of the named workspaces, grouped by workspace id, in one
 * query. Scoped to those workspaces because conversations are never pruned,
 * and reading a whole project's history on every list build would be costly.
 */
export async function getProjectConversations(
  projectId: string,
  workspaceIds: string[],
): Promise<Map<string, ConversationLinkRow[]>> {
  if (workspaceIds.length === 0) return new Map()
  const db = await getDb()
  const rows = await db.select(selectLinked())
    .from(workspaceConversations)
    .innerJoin(conversations, linkJoin())
    .where(and(
      eq(workspaceConversations.projectId, projectId),
      inArray(workspaceConversations.workspaceId, workspaceIds),
    ))
    .orderBy(asc(workspaceConversations.ordinal))
  const byWorkspace = new Map<string, ConversationLinkRow[]>()
  for (const r of rows) {
    const row: ConversationLinkRow = nullsToUndefined(r)
    byWorkspace.set(row.workspaceId, [...(byWorkspace.get(row.workspaceId) ?? []), row])
  }
  return byWorkspace
}

/** The same, for a set of workspaces across projects (the stopped listing,
 *  which is capped before it reads anything). */
export async function getConversationsFor(
  workspaceIds: Array<{ projectId: string; workspaceId: string }>,
): Promise<Map<string, ConversationLinkRow[]>> {
  if (workspaceIds.length === 0) return new Map()
  const db = await getDb()
  const rows = await db.select(selectLinked())
    .from(workspaceConversations)
    .innerJoin(conversations, linkJoin())
    // Narrowed by both columns in SQL; `wanted` below is the exact pair filter.
    .where(and(
      inArray(workspaceConversations.projectId, [...new Set(workspaceIds.map((w) => w.projectId))]),
      inArray(workspaceConversations.workspaceId, [...new Set(workspaceIds.map((w) => w.workspaceId))]),
    ))
    .orderBy(asc(workspaceConversations.ordinal))
  const wanted = new Set(workspaceIds.map((w) => `${w.projectId}/${w.workspaceId}`))
  const byWorkspace = new Map<string, ConversationLinkRow[]>()
  for (const r of rows) {
    const row: ConversationLinkRow = nullsToUndefined(r)
    const k = `${row.projectId}/${row.workspaceId}`
    if (!wanted.has(k)) continue
    byWorkspace.set(k, [...(byWorkspace.get(k) ?? []), row])
  }
  return byWorkspace
}


/**
 * Conversations of stopped workspaces with no recorded last activity, newest
 * stop first, at most `limit`: the ones `conversations-captured` has yet to fill.
 */
export async function listUncapturedStoppedConversations(limit: number): Promise<ConversationLinkRow[]> {
  const db = await getDb()
  const rows = await db.select(selectLinked())
    .from(workspaceConversations)
    .innerJoin(conversations, linkJoin())
    .innerJoin(workspaces, and(
      eq(workspaces.projectId, workspaceConversations.projectId),
      eq(workspaces.workspaceId, workspaceConversations.workspaceId),
    ))
    .where(and(isNotNull(workspaces.stoppedAt), isNull(conversations.lastActiveAt)))
    .orderBy(desc(workspaces.stoppedAt), asc(workspaceConversations.ordinal))
    .limit(limit)
  return rows.map(nullsToUndefined)
}

/** Fill what a stopped workspace's conversations left on disk, skipping any
 *  a discovery pass has since recorded. */
export async function recordConversationCaptures(projectId: string, captures: CapturedConversation[]): Promise<void> {
  const db = await getDb()
  for (const c of captures) {
    await db.update(conversations).set({
      lastActiveAt: new Date(c.lastActiveMs),
      ...(c.firstPrompt !== undefined
        ? { firstPrompt: sql`coalesce(${conversations.firstPrompt}, ${c.firstPrompt.slice(0, MAX_PROMPT_LENGTH)})` }
        : {}),
    }).where(and(
      eq(conversations.projectId, projectId),
      eq(conversations.tool, c.tool),
      eq(conversations.conversationId, c.conversationId),
      isNull(conversations.lastActiveAt),
    ))
  }
}

/** Delete a project's conversations, on project removal. */
export async function deleteProjectConversations(projectId: string): Promise<void> {
  const db = await getDb()
  await db.delete(workspaceConversations)
    .where(eq(workspaceConversations.projectId, projectId))
  await db.delete(conversations).where(eq(conversations.projectId, projectId))
}

/**
 * Delete one workspace's links, plus any conversation no other workspace
 * links. Used by `removeWorkspaceRecords`, since nothing else prunes these
 * rows. A conversation resumed into another workspace is kept.
 */
export async function deleteWorkspaceConversations(
  projectId: string,
  workspaceId: string,
): Promise<void> {
  const db = await getDb()
  const key = (l: { tool: string; conversationId: string }): string =>
    `${l.tool}/${l.conversationId}`
  const linkedColumns = {
    tool: workspaceConversations.tool,
    conversationId: workspaceConversations.conversationId,
  }
  const dropped = await db.select(linkedColumns)
    .from(workspaceConversations).where(linkKey(projectId, workspaceId))
  await db.delete(workspaceConversations).where(linkKey(projectId, workspaceId))
  if (dropped.length === 0) return

  // Queried after the delete so this workspace's own links don't count.
  const survivors = new Set((await db.select(linkedColumns)
    .from(workspaceConversations).where(and(
      eq(workspaceConversations.projectId, projectId),
      inArray(workspaceConversations.conversationId, dropped.map((l) => l.conversationId)),
    ))).map(key))
  for (const orphan of dropped.filter((l) => !survivors.has(key(l)))) {
    await db.delete(conversations).where(and(
      eq(conversations.projectId, projectId),
      eq(conversations.tool, orphan.tool),
      eq(conversations.conversationId, orphan.conversationId),
    ))
  }
}

/**
 * A workspace's first conversation, whose tool the workspace runs. Create
 * records it just after the workspace row, so it can be missing (briefly, or
 * for good if the create died); callers handle undefined.
 */
export async function firstConversation(
  projectId: string,
  workspaceId: string,
): Promise<ConversationLinkRow | undefined> {
  const [first] = await listWorkspaceConversations(projectId, workspaceId)
  return first
}

/**
 * The message that labels a workspace: the opening message of its first
 * conversation, in ordinal order (`links`), that captured one. The first
 * conversation can have none, e.g. a chat tab left blank while the user
 * typed in another one.
 */
export function openingPrompt(links: ConversationLinkRow[]): string | undefined {
  return links.find((l) => l.firstPrompt !== undefined)?.firstPrompt
}

/**
 * The title a workspace shows when the user has given it none: the agent's
 * own title for the conversation `openingPrompt` reads, or failing that the
 * first conversation, in ordinal order, that has one.
 */
export function conversationTitle(links: ConversationLinkRow[]): string | undefined {
  return links.find((l) => l.firstPrompt !== undefined)?.title ?? links.find((l) => l.title !== undefined)?.title
}
