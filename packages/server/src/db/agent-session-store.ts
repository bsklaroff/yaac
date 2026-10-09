import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { getDb } from './client'
import { agentSessions, workspaceAgentSessions, workspaces } from './schema'
import type { CapturedSession } from './events'
import { MAX_MODEL_LENGTH, MAX_PROMPT_LENGTH, SELF_NAMING_TOOLS } from '@yaac/shared/types'
import type { AgentMode, AgentTool } from '@yaac/shared/types'
import { nullsToUndefined } from '#lib/nulls'

/**
 * Conversation rows: `agent_sessions` (one row per tool-native conversation,
 * project-scoped like the tool homes) and `workspace_agent_sessions` (which
 * conversations belong to which workspace, and which were live).
 *
 * Everything here is discovered by the registry reconciler, so writes are
 * upserts and failures are non-fatal: the next tick retries. The exception
 * in importance is `setActiveAgentSessions`, whose last set survives
 * teardown and is what a restart brings back.
 */

export interface AgentSessionRow {
  projectId: string
  tool: AgentTool
  agentSessionId: string
  /** Which protocol drives it (see the `mode` column). */
  mode: AgentMode
  createdAt: Date
  /** Project-relative, as stored. `#domain/workspaces` resolves it to a
   *  file against the recording tool's home. */
  transcriptPath?: string
  firstPrompt?: string
  lastActiveAt?: Date
  /** The model it is running (see the `model` column). Absent until the
   *  launch or the agent names one. */
  model?: string
}

/** A conversation's membership of one workspace. */
export interface AgentSessionLinkRow extends AgentSessionRow {
  workspaceId: string
  active: boolean
  ordinal: number
  paneId?: string
  firstSeenAt: Date
  lastSeenAt: Date
}

/** What the reconciler knows about one conversation on one tick. */
export interface DiscoveredAgentSession {
  tool: AgentTool
  agentSessionId: string
  /** Defaults to 'tui'. Set only on insert: a conversation can't change
   *  protocol, and a later wrong guess must not overwrite what the create
   *  recorded. */
  mode?: AgentMode
  /** Project-relative, so it survives the data dir moving (see
   *  `toProjectRelative`). */
  transcriptPath?: string
  firstPrompt?: string
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
 * Does not touch `active`; only `setActiveAgentSessions` writes it.
 */
export async function recordAgentSessions(
  projectId: string,
  workspaceId: string,
  discovered: DiscoveredAgentSession[],
): Promise<void> {
  if (discovered.length === 0) return
  try {
    // One transaction, so a pin is never deleted without its replacement.
    await (await getDb()).transaction(async (db) => {
      const now = new Date()
      const existing = await db.select({
        tool: workspaceAgentSessions.tool,
        agentSessionId: workspaceAgentSessions.agentSessionId,
        ordinal: workspaceAgentSessions.ordinal,
      }).from(workspaceAgentSessions).where(linkKey(projectId, workspaceId))
      const ordinalOf = new Map(existing.map((e) => [`${e.tool}/${e.agentSessionId}`, e.ordinal]))
      let nextOrdinal = existing.reduce((max, e) => Math.max(max, e.ordinal + 1), 0)

      for (const reported of discovered) {
        const linkId = `${reported.tool}/${reported.agentSessionId}`
        const pinId = `${reported.tool}/${workspaceId}`
        const pinOrdinal = SELF_NAMING_TOOLS.includes(reported.tool) && !ordinalOf.has(linkId)
          ? ordinalOf.get(pinId)
          : undefined
        let d = reported
        if (pinOrdinal !== undefined) {
          // Carry over the pin's creation time and launch model (unless the
          // agent reported its own), and always its prompt: a `--prompt` is
          // the real opening message, while opencode's is only a title.
          const [pin] = await db.delete(agentSessions).where(and(
            eq(agentSessions.projectId, projectId),
            eq(agentSessions.tool, reported.tool),
            eq(agentSessions.agentSessionId, workspaceId),
          )).returning()
          await db.delete(workspaceAgentSessions).where(and(
            linkKey(projectId, workspaceId),
            eq(workspaceAgentSessions.tool, reported.tool),
            eq(workspaceAgentSessions.agentSessionId, workspaceId),
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
          ...(d.firstPrompt !== undefined
            ? {
              // Keep the first value: a compacted transcript would otherwise
              // replace the opening message.
              firstPrompt: sql`coalesce(${agentSessions.firstPrompt}, ${d.firstPrompt.slice(0, MAX_PROMPT_LENGTH)})`,
            }
            : {}),
        }
        const values = {
          projectId,
          tool: d.tool,
          agentSessionId: d.agentSessionId,
          createdAt: seenAt,
          mode: d.mode ?? 'tui',
          transcriptPath: stored,
          firstPrompt: d.firstPrompt?.slice(0, MAX_PROMPT_LENGTH) ?? null,
          lastActiveAt: d.lastActiveMs !== undefined ? new Date(d.lastActiveMs) : null,
          model: d.model?.slice(0, MAX_MODEL_LENGTH) ?? null,
        }
        const target = [
          agentSessions.projectId,
          agentSessions.tool,
          agentSessions.agentSessionId,
        ]
        await (Object.keys(fill).length > 0
          ? db.insert(agentSessions).values(values).onConflictDoUpdate({ target, set: fill })
          : db.insert(agentSessions).values(values).onConflictDoNothing({ target }))

        const ordinal = ordinalOf.get(linkId) ?? nextOrdinal++
        await db.insert(workspaceAgentSessions).values({
          projectId,
          workspaceId,
          tool: d.tool,
          agentSessionId: d.agentSessionId,
          ordinal,
          paneId: d.paneId ?? null,
          firstSeenAt: seenAt,
          lastSeenAt: now,
        }).onConflictDoUpdate({
          target: [
            workspaceAgentSessions.projectId,
            workspaceAgentSessions.workspaceId,
            workspaceAgentSessions.tool,
            workspaceAgentSessions.agentSessionId,
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
  eq(workspaceAgentSessions.projectId, projectId),
  eq(workspaceAgentSessions.workspaceId, workspaceId),
)

/**
 * Set which of a workspace's conversations are live, from the panes observed
 * this tick; every other linked conversation goes inactive.
 *
 * Call only while the runtime is observed running. Teardown must leave the
 * last set alone, since it is what a restart brings back.
 */
export async function setActiveAgentSessions(
  projectId: string,
  workspaceId: string,
  live: Array<{ tool: AgentTool; agentSessionId: string; paneId?: string }>,
): Promise<void> {
  try {
    const db = await getDb()
    const now = new Date()
    const liveIds = live.map((l) => `${l.tool}/${l.agentSessionId}`)
    const rows = await db.select({
      tool: workspaceAgentSessions.tool,
      agentSessionId: workspaceAgentSessions.agentSessionId,
      active: workspaceAgentSessions.active,
      paneId: workspaceAgentSessions.paneId,
    }).from(workspaceAgentSessions).where(linkKey(projectId, workspaceId))

    for (const row of rows) {
      const isLive = liveIds.includes(`${row.tool}/${row.agentSessionId}`)
      const paneId = live.find(
        (l) => l.tool === row.tool && l.agentSessionId === row.agentSessionId,
      )?.paneId
      // Skip unchanged rows; this runs every tick for every conversation.
      if (row.active === isLive && (!isLive || row.paneId === (paneId ?? null))) continue
      await db.update(workspaceAgentSessions).set({
        active: isLive,
        lastSeenAt: now,
        ...(isLive ? { paneId: paneId ?? null } : {}),
      }).where(and(
        linkKey(projectId, workspaceId),
        eq(workspaceAgentSessions.tool, row.tool),
        eq(workspaceAgentSessions.agentSessionId, row.agentSessionId),
      ))
    }
  } catch {
    // Non-fatal: the next tick re-observes the same panes.
  }
}

/** Join shape shared by the link readers. */
function selectLinked() {
  return {
    projectId: workspaceAgentSessions.projectId,
    workspaceId: workspaceAgentSessions.workspaceId,
    tool: workspaceAgentSessions.tool,
    agentSessionId: workspaceAgentSessions.agentSessionId,
    mode: agentSessions.mode,
    active: workspaceAgentSessions.active,
    ordinal: workspaceAgentSessions.ordinal,
    paneId: workspaceAgentSessions.paneId,
    firstSeenAt: workspaceAgentSessions.firstSeenAt,
    lastSeenAt: workspaceAgentSessions.lastSeenAt,
    createdAt: agentSessions.createdAt,
    transcriptPath: agentSessions.transcriptPath,
    firstPrompt: agentSessions.firstPrompt,
    lastActiveAt: agentSessions.lastActiveAt,
    model: agentSessions.model,
  }
}

/**
 * The link-to-conversation join. A function rather than a module-scope const
 * so the table references are read at call time, avoiding any dependence on
 * module load order.
 */
const linkJoin = () => and(
  eq(workspaceAgentSessions.projectId, agentSessions.projectId),
  eq(workspaceAgentSessions.tool, agentSessions.tool),
  eq(workspaceAgentSessions.agentSessionId, agentSessions.agentSessionId),
)

/** One workspace's conversations, in restore order. */
export async function listWorkspaceAgentSessions(
  projectId: string,
  workspaceId: string,
): Promise<AgentSessionLinkRow[]> {
  const db = await getDb()
  const rows = await db.select(selectLinked())
    .from(workspaceAgentSessions)
    .innerJoin(agentSessions, linkJoin())
    .where(linkKey(projectId, workspaceId))
    .orderBy(asc(workspaceAgentSessions.ordinal))
  return rows.map(nullsToUndefined)
}

/**
 * The conversations a restart should bring back: those that were live when
 * the workspace was last observed running, in window order.
 */
export async function listActiveAgentSessions(
  projectId: string,
  workspaceId: string,
): Promise<AgentSessionLinkRow[]> {
  const db = await getDb()
  const rows = await db.select(selectLinked())
    .from(workspaceAgentSessions)
    .innerJoin(agentSessions, linkJoin())
    .where(and(linkKey(projectId, workspaceId), eq(workspaceAgentSessions.active, true)))
    .orderBy(asc(workspaceAgentSessions.ordinal))
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
): Promise<Array<{ handle: string; agentSessionId: string }>> {
  const links = await listActiveAgentSessions(projectId, workspaceId).catch(() => [])
  return links.flatMap((l) => (l.paneId === undefined
    ? []
    : [{ handle: l.paneId, agentSessionId: l.agentSessionId }]))
}

/**
 * The conversations of the named workspaces, grouped by workspace id, in one
 * query. Scoped to those workspaces because conversations are never pruned,
 * and reading a whole project's history on every list build would be costly.
 */
export async function getProjectAgentSessions(
  projectId: string,
  workspaceIds: string[],
): Promise<Map<string, AgentSessionLinkRow[]>> {
  if (workspaceIds.length === 0) return new Map()
  const db = await getDb()
  const rows = await db.select(selectLinked())
    .from(workspaceAgentSessions)
    .innerJoin(agentSessions, linkJoin())
    .where(and(
      eq(workspaceAgentSessions.projectId, projectId),
      inArray(workspaceAgentSessions.workspaceId, workspaceIds),
    ))
    .orderBy(asc(workspaceAgentSessions.ordinal))
  const byWorkspace = new Map<string, AgentSessionLinkRow[]>()
  for (const r of rows) {
    const row: AgentSessionLinkRow = nullsToUndefined(r)
    byWorkspace.set(row.workspaceId, [...(byWorkspace.get(row.workspaceId) ?? []), row])
  }
  return byWorkspace
}

/** The same, for a set of workspaces across projects (the stopped listing,
 *  which is capped before it reads anything). */
export async function getAgentSessionsFor(
  workspaceIds: Array<{ projectId: string; workspaceId: string }>,
): Promise<Map<string, AgentSessionLinkRow[]>> {
  if (workspaceIds.length === 0) return new Map()
  const db = await getDb()
  const rows = await db.select(selectLinked())
    .from(workspaceAgentSessions)
    .innerJoin(agentSessions, linkJoin())
    // Narrowed by both columns in SQL; `wanted` below is the exact pair filter.
    .where(and(
      inArray(workspaceAgentSessions.projectId, [...new Set(workspaceIds.map((w) => w.projectId))]),
      inArray(workspaceAgentSessions.workspaceId, [...new Set(workspaceIds.map((w) => w.workspaceId))]),
    ))
    .orderBy(asc(workspaceAgentSessions.ordinal))
  const wanted = new Set(workspaceIds.map((w) => `${w.projectId}/${w.workspaceId}`))
  const byWorkspace = new Map<string, AgentSessionLinkRow[]>()
  for (const r of rows) {
    const row: AgentSessionLinkRow = nullsToUndefined(r)
    const k = `${row.projectId}/${row.workspaceId}`
    if (!wanted.has(k)) continue
    byWorkspace.set(k, [...(byWorkspace.get(k) ?? []), row])
  }
  return byWorkspace
}


/**
 * Conversations of stopped workspaces with no recorded last activity, newest
 * stop first, at most `limit`: the ones `sessions-captured` has yet to fill.
 */
export async function listUncapturedStoppedSessions(limit: number): Promise<AgentSessionLinkRow[]> {
  const db = await getDb()
  const rows = await db.select(selectLinked())
    .from(workspaceAgentSessions)
    .innerJoin(agentSessions, linkJoin())
    .innerJoin(workspaces, and(
      eq(workspaces.projectId, workspaceAgentSessions.projectId),
      eq(workspaces.workspaceId, workspaceAgentSessions.workspaceId),
    ))
    .where(and(isNotNull(workspaces.stoppedAt), isNull(agentSessions.lastActiveAt)))
    .orderBy(desc(workspaces.stoppedAt), asc(workspaceAgentSessions.ordinal))
    .limit(limit)
  return rows.map(nullsToUndefined)
}

/** Fill what a stopped workspace's conversations left on disk, skipping any
 *  a discovery pass has since recorded. */
export async function recordAgentSessionCaptures(projectId: string, captures: CapturedSession[]): Promise<void> {
  const db = await getDb()
  for (const c of captures) {
    await db.update(agentSessions).set({
      lastActiveAt: new Date(c.lastActiveMs),
      ...(c.firstPrompt !== undefined
        ? { firstPrompt: sql`coalesce(${agentSessions.firstPrompt}, ${c.firstPrompt.slice(0, MAX_PROMPT_LENGTH)})` }
        : {}),
    }).where(and(
      eq(agentSessions.projectId, projectId),
      eq(agentSessions.tool, c.tool),
      eq(agentSessions.agentSessionId, c.agentSessionId),
      isNull(agentSessions.lastActiveAt),
    ))
  }
}

/** Delete a project's conversations, on project removal. */
export async function deleteProjectAgentSessions(projectId: string): Promise<void> {
  const db = await getDb()
  await db.delete(workspaceAgentSessions)
    .where(eq(workspaceAgentSessions.projectId, projectId))
  await db.delete(agentSessions).where(eq(agentSessions.projectId, projectId))
}

/**
 * Delete one workspace's links, plus any conversation no other workspace
 * links. Used by create rollback, since nothing else prunes these rows. A
 * conversation resumed into another workspace is kept.
 */
export async function deleteWorkspaceAgentSessions(
  projectId: string,
  workspaceId: string,
): Promise<void> {
  const db = await getDb()
  const key = (l: { tool: string; agentSessionId: string }): string =>
    `${l.tool}/${l.agentSessionId}`
  const linkedColumns = {
    tool: workspaceAgentSessions.tool,
    agentSessionId: workspaceAgentSessions.agentSessionId,
  }
  const dropped = await db.select(linkedColumns)
    .from(workspaceAgentSessions).where(linkKey(projectId, workspaceId))
  await db.delete(workspaceAgentSessions).where(linkKey(projectId, workspaceId))
  if (dropped.length === 0) return

  // Queried after the delete so this workspace's own links don't count.
  const survivors = new Set((await db.select(linkedColumns)
    .from(workspaceAgentSessions).where(and(
      eq(workspaceAgentSessions.projectId, projectId),
      inArray(workspaceAgentSessions.agentSessionId, dropped.map((l) => l.agentSessionId)),
    ))).map(key))
  for (const orphan of dropped.filter((l) => !survivors.has(key(l)))) {
    await db.delete(agentSessions).where(and(
      eq(agentSessions.projectId, projectId),
      eq(agentSessions.tool, orphan.tool),
      eq(agentSessions.agentSessionId, orphan.agentSessionId),
    ))
  }
}

/**
 * A workspace's first conversation, whose tool the workspace runs and whose
 * opening message labels it. Create records it just after the workspace row,
 * so it can be missing (briefly, or for good if the create died); callers
 * handle undefined.
 */
export async function firstAgentSession(
  projectId: string,
  workspaceId: string,
): Promise<AgentSessionLinkRow | undefined> {
  const [first] = await listWorkspaceAgentSessions(projectId, workspaceId)
  return first
}

/** The first conversation of each named workspace, keyed `<projectId>/<id>`, in
 *  one query for listings. */
export async function firstAgentSessionsFor(
  workspaces: Array<{ projectId: string; workspaceId: string }>,
): Promise<Map<string, AgentSessionLinkRow>> {
  const byWorkspace = await getAgentSessionsFor(workspaces)
  const firsts = new Map<string, AgentSessionLinkRow>()
  for (const [k, links] of byWorkspace) {
    const first = links[0]
    if (first !== undefined) firsts.set(k, first)
  }
  return firsts
}
