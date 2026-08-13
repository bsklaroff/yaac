import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from './client'
import { agentSessions, worktreeAgentSessions } from './schema'
import { MAX_PROMPT_LENGTH } from '@yaac/shared/types'
import type { AgentMode, AgentTool } from '@yaac/shared/types'

/**
 * The conversation side of the model: `agent_sessions` (one row per
 * tool-native conversation, project-scoped because the tool homes yaac
 * mounts are) and `worktree_agent_sessions` (which conversations belong to
 * which worktree, and which of them were live).
 *
 * Everything here is discovered rather than authored — the registry
 * reconciler feeds it from what the discovery sweep found — so every write is an
 * upsert and none of them are fatal: a missed tick is re-reconciled on the
 * next one. The one write that carries real weight is `setActiveAgentSessions`,
 * because the set it leaves behind is frozen at teardown and read back by
 * restart.
 */

/** One conversation, as the display paths consume it. */
export interface AgentSessionRow {
  projectSlug: string
  tool: AgentTool
  agentSessionId: string
  /** Which protocol drives it — see the `mode` column. */
  mode: AgentMode
  createdAt: Date
  /** Project-relative, exactly as the column holds it. A reader that wants
   *  bytes on disk resolves it against the project directory, which takes
   *  the store's layout knowledge and so happens a layer up
   *  (`absoluteTranscriptPath` in `#domain/worktrees`). */
  transcriptPath?: string
  firstPrompt?: string
  lastActiveAt?: Date
}

/** A conversation's membership of one worktree. */
export interface AgentSessionLinkRow extends AgentSessionRow {
  worktreeId: string
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
  /** Defaults to 'tui'. Only ever set on INSERT: a conversation cannot change
   *  protocol mid-life, and a later sighting that guessed wrong must not
   *  rewrite what the create path recorded. */
  mode?: AgentMode
  /** Project-relative, as discovery reports it and the column stores it —
   *  the one form that survives the data dir moving and means the same thing
   *  on both sides of the link (see `toProjectRelative`). */
  transcriptPath?: string
  firstPrompt?: string
  lastActiveMs?: number
  /** First observation time, used as the conversation's birth when it is
   *  new to the DB (the link record's birthtime). */
  firstSeenMs?: number
  /** The pane it is live on right now, when it is live on one. */
  paneId?: string
}

/**
 * Upsert the conversations discovered in a worktree and link them to it.
 *
 * Ordering is by first appearance, so ordinal 0 is the worktree's original
 * agent — the one whose window keeps the `yaac:<tool>` name and which a
 * restart brings up first. Existing links keep the ordinal they were given:
 * renumbering them on every tick would reshuffle a restart's window order
 * whenever an old conversation was resumed.
 *
 * Does NOT touch `active` — that is `setActiveAgentSessions`, which is the
 * only writer allowed to, precisely because its result must survive teardown
 * untouched.
 */
export async function recordAgentSessions(
  projectSlug: string,
  worktreeId: string,
  discovered: DiscoveredAgentSession[],
): Promise<void> {
  if (discovered.length === 0) return
  try {
    const db = await getDb()
    const now = new Date()
    const existing = await db.select({
      tool: worktreeAgentSessions.tool,
      agentSessionId: worktreeAgentSessions.agentSessionId,
      ordinal: worktreeAgentSessions.ordinal,
    }).from(worktreeAgentSessions).where(linkKey(projectSlug, worktreeId))
    const ordinalOf = new Map(existing.map((e) => [`${e.tool}/${e.agentSessionId}`, e.ordinal]))
    let nextOrdinal = existing.reduce((max, e) => Math.max(max, e.ordinal + 1), 0)

    for (const d of discovered) {
      const seenAt = d.firstSeenMs !== undefined ? new Date(d.firstSeenMs) : now
      // Stored exactly as reported — the sweep already speaks the column's
      // form (project-relative, see `toProjectRelative`). Absent is not the
      // same as empty: a conversation whose path the sweep could not express
      // must not overwrite a good stored value, so the fill branch below
      // omits the column entirely rather than clearing it.
      const stored = d.transcriptPath ?? null
      // Only ever fill in — a resumed conversation is rediscovered from a
      // second worktree and must not lose what the first one learned. Built
      // first because an empty `set` is an error, not a no-op: a conversation
      // discovered with nothing but its id (the common first sighting) has to
      // take the DO NOTHING branch.
      const fill = {
        ...(stored !== null ? { transcriptPath: stored } : {}),
        ...(d.lastActiveMs !== undefined ? { lastActiveAt: new Date(d.lastActiveMs) } : {}),
        ...(d.firstPrompt !== undefined
          ? {
            // A conversation's opening message never changes, and re-reading a
            // transcript that has since been compacted would replace it with
            // whatever the log now starts with.
            firstPrompt: sql`coalesce(${agentSessions.firstPrompt}, ${d.firstPrompt.slice(0, MAX_PROMPT_LENGTH)})`,
          }
          : {}),
      }
      const values = {
        projectSlug,
        tool: d.tool,
        agentSessionId: d.agentSessionId,
        createdAt: seenAt,
        mode: d.mode ?? 'tui',
        transcriptPath: stored,
        firstPrompt: d.firstPrompt?.slice(0, MAX_PROMPT_LENGTH) ?? null,
        lastActiveAt: d.lastActiveMs !== undefined ? new Date(d.lastActiveMs) : null,
      }
      const target = [
        agentSessions.projectSlug,
        agentSessions.tool,
        agentSessions.agentSessionId,
      ]
      await (Object.keys(fill).length > 0
        ? db.insert(agentSessions).values(values).onConflictDoUpdate({ target, set: fill })
        : db.insert(agentSessions).values(values).onConflictDoNothing({ target }))

      const linkId = `${d.tool}/${d.agentSessionId}`
      const ordinal = ordinalOf.get(linkId) ?? nextOrdinal++
      await db.insert(worktreeAgentSessions).values({
        projectSlug,
        worktreeId,
        tool: d.tool,
        agentSessionId: d.agentSessionId,
        ordinal,
        paneId: d.paneId ?? null,
        firstSeenAt: seenAt,
        lastSeenAt: now,
      }).onConflictDoUpdate({
        target: [
          worktreeAgentSessions.projectSlug,
          worktreeAgentSessions.worktreeId,
          worktreeAgentSessions.tool,
          worktreeAgentSessions.agentSessionId,
        ],
        set: { lastSeenAt: now, paneId: d.paneId ?? null },
      })
    }
  } catch {
    // Non-fatal: discovery is idempotent, so the next tick re-records.
  }
}

const linkKey = (projectSlug: string, worktreeId: string) => and(
  eq(worktreeAgentSessions.projectSlug, projectSlug),
  eq(worktreeAgentSessions.worktreeId, worktreeId),
)

/**
 * Set which of a worktree's conversations are live, from the pane set
 * observed on this tick. Everything linked but not named goes inactive.
 *
 * Call this ONLY while the pod is observed running. Teardown must leave the
 * last-written set alone: "what was active when the worktree stopped" is
 * exactly what a restart brings back, and zeroing it on the way out would
 * restart every worktree empty.
 */
export async function setActiveAgentSessions(
  projectSlug: string,
  worktreeId: string,
  live: Array<{ tool: AgentTool; agentSessionId: string; paneId?: string }>,
): Promise<void> {
  try {
    const db = await getDb()
    const now = new Date()
    const liveIds = live.map((l) => `${l.tool}/${l.agentSessionId}`)
    const rows = await db.select({
      tool: worktreeAgentSessions.tool,
      agentSessionId: worktreeAgentSessions.agentSessionId,
      active: worktreeAgentSessions.active,
      paneId: worktreeAgentSessions.paneId,
    }).from(worktreeAgentSessions).where(linkKey(projectSlug, worktreeId))

    for (const row of rows) {
      const isLive = liveIds.includes(`${row.tool}/${row.agentSessionId}`)
      const paneId = live.find(
        (l) => l.tool === row.tool && l.agentSessionId === row.agentSessionId,
      )?.paneId
      // Nothing observable changed — skip the write. This runs on every
      // reconciler tick for every conversation of every running worktree, and
      // a steady state is the overwhelmingly common case.
      if (row.active === isLive && (!isLive || row.paneId === (paneId ?? null))) continue
      await db.update(worktreeAgentSessions).set({
        active: isLive,
        lastSeenAt: now,
        ...(isLive ? { paneId: paneId ?? null } : {}),
      }).where(and(
        linkKey(projectSlug, worktreeId),
        eq(worktreeAgentSessions.tool, row.tool),
        eq(worktreeAgentSessions.agentSessionId, row.agentSessionId),
      ))
    }
  } catch {
    // Non-fatal: the next tick re-observes the same panes.
  }
}

/** Join shape shared by the link readers. */
function selectLinked() {
  return {
    projectSlug: worktreeAgentSessions.projectSlug,
    worktreeId: worktreeAgentSessions.worktreeId,
    tool: worktreeAgentSessions.tool,
    agentSessionId: worktreeAgentSessions.agentSessionId,
    mode: agentSessions.mode,
    active: worktreeAgentSessions.active,
    ordinal: worktreeAgentSessions.ordinal,
    paneId: worktreeAgentSessions.paneId,
    firstSeenAt: worktreeAgentSessions.firstSeenAt,
    lastSeenAt: worktreeAgentSessions.lastSeenAt,
    createdAt: agentSessions.createdAt,
    transcriptPath: agentSessions.transcriptPath,
    firstPrompt: agentSessions.firstPrompt,
    lastActiveAt: agentSessions.lastActiveAt,
  }
}

type LinkedSelect = {
  projectSlug: string
  worktreeId: string
  tool: string
  agentSessionId: string
  mode: string
  active: boolean
  ordinal: number
  paneId: string | null
  firstSeenAt: Date
  lastSeenAt: Date
  createdAt: Date
  transcriptPath: string | null
  firstPrompt: string | null
  lastActiveAt: Date | null
}

function toLinkRow(r: LinkedSelect): AgentSessionLinkRow {
  return {
    projectSlug: r.projectSlug,
    worktreeId: r.worktreeId,
    tool: r.tool as AgentTool,
    agentSessionId: r.agentSessionId,
    mode: r.mode === 'acp' ? 'acp' : 'tui',
    active: r.active,
    ordinal: r.ordinal,
    createdAt: r.createdAt,
    firstSeenAt: r.firstSeenAt,
    lastSeenAt: r.lastSeenAt,
    ...(r.paneId !== null ? { paneId: r.paneId } : {}),
    ...(r.transcriptPath !== null ? { transcriptPath: r.transcriptPath } : {}),
    ...(r.firstPrompt !== null ? { firstPrompt: r.firstPrompt } : {}),
    ...(r.lastActiveAt !== null ? { lastActiveAt: r.lastActiveAt } : {}),
  }
}

/**
 * The link → conversation join. A function, not a module-scope const:
 * evaluating a table reference while this module is first loading can find
 * the db barrel's table exports still uninitialized, and deferring it to call
 * time removes the load-order dependency outright.
 */
const linkJoin = () => and(
  eq(worktreeAgentSessions.projectSlug, agentSessions.projectSlug),
  eq(worktreeAgentSessions.tool, agentSessions.tool),
  eq(worktreeAgentSessions.agentSessionId, agentSessions.agentSessionId),
)

/** One worktree's conversations, in restore order. */
export async function listWorktreeAgentSessions(
  projectSlug: string,
  worktreeId: string,
): Promise<AgentSessionLinkRow[]> {
  const db = await getDb()
  const rows = await db.select(selectLinked())
    .from(worktreeAgentSessions)
    .innerJoin(agentSessions, linkJoin())
    .where(linkKey(projectSlug, worktreeId))
    .orderBy(asc(worktreeAgentSessions.ordinal))
  return rows.map(toLinkRow)
}

/**
 * The conversations a restart should bring back: those that were live when
 * the worktree was last observed running, in window order.
 */
export async function listActiveAgentSessions(
  projectSlug: string,
  worktreeId: string,
): Promise<AgentSessionLinkRow[]> {
  const db = await getDb()
  const rows = await db.select(selectLinked())
    .from(worktreeAgentSessions)
    .innerJoin(agentSessions, linkJoin())
    .where(and(linkKey(projectSlug, worktreeId), eq(worktreeAgentSessions.active, true)))
    .orderBy(asc(worktreeAgentSessions.ordinal))
  return rows.map(toLinkRow)
}

/**
 * The recorded conversations of a worktree that sit on a live handle —
 * what an ACP driver attaching to a running pod needs to re-address agents
 * it did not start (and to `session/load` after a restart). A link with no
 * pane id names nothing it could attach to, so it is filtered here.
 *
 * Swallows a read failure: a watcher starting against an unreadable
 * database must attach with no history rather than fail the whole
 * worktree's status stream.
 */
export async function recordedConversationHandles(
  projectSlug: string,
  worktreeId: string,
): Promise<Array<{ handle: string; agentSessionId: string }>> {
  const links = await listActiveAgentSessions(projectSlug, worktreeId).catch(() => [])
  return links.flatMap((l) => (l.paneId === undefined
    ? []
    : [{ handle: l.paneId, agentSessionId: l.agentSessionId }]))
}

/**
 * The conversations of the named worktrees, grouped by worktree id — one
 * query per project per list build, so a snapshot never pays per row.
 *
 * Scoped to the worktrees the caller will actually render rather than the
 * whole project: conversations are never pruned, so a long-lived project
 * accumulates them without bound, and an unfiltered read would haul every
 * one (4000-char prompts included) into memory on every ~5s list poll only
 * to discard all but the running few.
 */
export async function getProjectAgentSessions(
  projectSlug: string,
  worktreeIds: string[],
): Promise<Map<string, AgentSessionLinkRow[]>> {
  if (worktreeIds.length === 0) return new Map()
  const db = await getDb()
  const rows = await db.select(selectLinked())
    .from(worktreeAgentSessions)
    .innerJoin(agentSessions, linkJoin())
    .where(and(
      eq(worktreeAgentSessions.projectSlug, projectSlug),
      inArray(worktreeAgentSessions.worktreeId, worktreeIds),
    ))
    .orderBy(asc(worktreeAgentSessions.ordinal))
  const byWorktree = new Map<string, AgentSessionLinkRow[]>()
  for (const r of rows) {
    const row = toLinkRow(r)
    byWorktree.set(row.worktreeId, [...(byWorktree.get(row.worktreeId) ?? []), row])
  }
  return byWorktree
}

/** The same, for a set of worktrees across projects (the stopped listing,
 *  which is capped before it reads anything). */
export async function getAgentSessionsFor(
  worktreeIds: Array<{ projectSlug: string; worktreeId: string }>,
): Promise<Map<string, AgentSessionLinkRow[]>> {
  if (worktreeIds.length === 0) return new Map()
  const db = await getDb()
  const rows = await db.select(selectLinked())
    .from(worktreeAgentSessions)
    .innerJoin(agentSessions, linkJoin())
    .where(inArray(worktreeAgentSessions.projectSlug, [...new Set(worktreeIds.map((w) => w.projectSlug))]))
    .orderBy(asc(worktreeAgentSessions.ordinal))
  const wanted = new Set(worktreeIds.map((w) => `${w.projectSlug}/${w.worktreeId}`))
  const byWorktree = new Map<string, AgentSessionLinkRow[]>()
  for (const r of rows) {
    const row = toLinkRow(r)
    const k = `${row.projectSlug}/${row.worktreeId}`
    if (!wanted.has(k)) continue
    byWorktree.set(k, [...(byWorktree.get(k) ?? []), row])
  }
  return byWorktree
}


/**
 * Persist a conversation's captured first message and transcript path.
 *
 * `transcriptPath` is project-relative, as in `recordAgentSessions` and as
 * the column holds it — a caller holding an absolute one converts before it
 * gets here, which is what keeps "absolute appears nowhere" true for rows
 * captured on demand. A stray absolute would surface only as a listing with
 * no prompt and no last-activity, so the read side logs one rather than
 * resolving it.
 *
 * As in `recordAgentSessions`: an unexpressible path is simply absent, and
 * leaves the column alone rather than clearing what an earlier pass recorded.
 */
export async function setAgentSessionCapture(
  projectSlug: string,
  tool: AgentTool,
  agentSessionId: string,
  capture: { firstPrompt?: string; transcriptPath?: string },
): Promise<void> {
  const values = {
    ...(capture.firstPrompt !== undefined
      ? { firstPrompt: capture.firstPrompt.slice(0, MAX_PROMPT_LENGTH) }
      : {}),
    ...(capture.transcriptPath !== undefined
      ? { transcriptPath: capture.transcriptPath }
      : {}),
  }
  if (Object.keys(values).length === 0) return
  try {
    const db = await getDb()
    await db.update(agentSessions).set(values).where(and(
      eq(agentSessions.projectSlug, projectSlug),
      eq(agentSessions.tool, tool),
      eq(agentSessions.agentSessionId, agentSessionId),
    ))
  } catch {
    // Non-fatal: the next capture pass retries.
  }
}

/** Forget a project's conversations (the project itself is going away). */
export async function deleteProjectAgentSessions(projectSlug: string): Promise<void> {
  const db = await getDb()
  await db.delete(worktreeAgentSessions)
    .where(eq(worktreeAgentSessions.projectSlug, projectSlug))
  await db.delete(agentSessions).where(eq(agentSessions.projectSlug, projectSlug))
}

/**
 * Drop one worktree's links, and with them every conversation it was the last
 * worktree holding. The create rollback's cleanup: a create that never came up
 * wrote both a link and the conversation behind it (with the ask the user
 * typed), and nothing else prunes either — unlinked rows are inert but
 * accumulate until the project is removed.
 *
 * Conversations are shared many-to-many, so one another worktree still links
 * survives: resuming a conversation into a second worktree must not make the
 * first worktree's rollback take it away from the second.
 */
export async function deleteWorktreeAgentSessions(
  projectSlug: string,
  worktreeId: string,
): Promise<void> {
  const db = await getDb()
  const key = (l: { tool: string; agentSessionId: string }): string =>
    `${l.tool}/${l.agentSessionId}`
  const linkedColumns = {
    tool: worktreeAgentSessions.tool,
    agentSessionId: worktreeAgentSessions.agentSessionId,
  }
  const dropped = await db.select(linkedColumns)
    .from(worktreeAgentSessions).where(linkKey(projectSlug, worktreeId))
  await db.delete(worktreeAgentSessions).where(linkKey(projectSlug, worktreeId))
  if (dropped.length === 0) return

  // Asked after the delete, so a conversation this worktree held twice (one
  // per pane) does not count itself as the other holder.
  const survivors = new Set((await db.select(linkedColumns)
    .from(worktreeAgentSessions).where(and(
      eq(worktreeAgentSessions.projectSlug, projectSlug),
      inArray(worktreeAgentSessions.agentSessionId, dropped.map((l) => l.agentSessionId)),
    ))).map(key))
  for (const orphan of dropped.filter((l) => !survivors.has(key(l)))) {
    await db.delete(agentSessions).where(and(
      eq(agentSessions.projectSlug, projectSlug),
      eq(agentSessions.tool, orphan.tool),
      eq(agentSessions.agentSessionId, orphan.agentSessionId),
    ))
  }
}

/**
 * A worktree's first conversation — the one whose tool the worktree runs and
 * whose opening message labels it. Create records it moments after the
 * worktree row itself, so a row can be read in between (and a create that
 * died in that gap leaves one for good); that reads as unknown here rather
 * than being guessed at, and each caller decides what to do without one.
 */
export async function firstAgentSession(
  projectSlug: string,
  worktreeId: string,
): Promise<AgentSessionLinkRow | undefined> {
  const [first] = await listWorktreeAgentSessions(projectSlug, worktreeId)
  return first
}

/**
 * The first conversation of each named worktree, keyed `<slug>/<id>` — the
 * batched form for listings, which would otherwise pay a query per row.
 */
export async function firstAgentSessionsFor(
  worktrees: Array<{ projectSlug: string; worktreeId: string }>,
): Promise<Map<string, AgentSessionLinkRow>> {
  const byWorktree = await getAgentSessionsFor(worktrees)
  const firsts = new Map<string, AgentSessionLinkRow>()
  for (const [k, links] of byWorktree) {
    const first = links[0]
    if (first !== undefined) firsts.set(k, first)
  }
  return firsts
}
