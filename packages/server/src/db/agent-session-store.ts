import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from './client'
import { agentSessions, workspaceAgentSessions } from './schema'
import { MAX_MODEL_LENGTH, MAX_PROMPT_LENGTH, SELF_NAMING_TOOLS } from '@yaac/shared/types'
import type { AgentMode, AgentTool } from '@yaac/shared/types'

/**
 * The conversation side of the model: `agent_sessions` (one row per
 * tool-native conversation, project-scoped because the tool homes yaac
 * mounts are) and `workspace_agent_sessions` (which conversations belong to
 * which workspace, and which of them were live).
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
   *  bytes on disk resolves it against the recording tool's home, which takes
   *  the store's layout knowledge and so happens a layer up
   *  (`recordedTranscript` in `#domain/workspaces`). */
  transcriptPath?: string
  firstPrompt?: string
  lastActiveAt?: Date
  /** The model it is running — see the `model` column. Absent until the
   *  launch or the agent has named one. */
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
  /** The model the agent last reported. Absent means "not reported", never
   *  "none" — it leaves a recorded value alone. */
  model?: string
  /** First observation time, used as the conversation's birth when it is
   *  new to the DB (the link record's birthtime). */
  firstSeenMs?: number
  /** The pane it is live on right now, when it is live on one. */
  paneId?: string
}

/**
 * Upsert the conversations discovered in a workspace and link them to it.
 *
 * Ordering is by first appearance, so ordinal 0 is the workspace's original
 * agent — the one whose window keeps the `yaac:<tool>` name and which a
 * restart brings up first. Existing links keep the ordinal they were given:
 * renumbering them on every tick would reshuffle a restart's window order
 * whenever an old conversation was resumed.
 *
 * The one exception is the workspace-id pin: the conversation a create records
 * under the workspace id, before any agent has named one. For codex and
 * opencode that id is a stand-in (`SELF_NAMING_TOOLS`), so the first
 * conversation of the pin's tool to be named takes over its link — ordinal 0,
 * and what the create recorded on it (the `--prompt` ask, the launch's model,
 * its birth) — and the pin is gone. Otherwise the workspace's founding ask
 * would sit on a row no agent ever runs. claude and pi run under the pin
 * itself, so the first conversation they name IS the pin, and a later
 * `/clear` is one of its own.
 *
 * Does NOT touch `active` — that is `setActiveAgentSessions`, which is the
 * only writer allowed to, precisely because its result must survive teardown
 * untouched.
 */
export async function recordAgentSessions(
  projectSlug: string,
  workspaceId: string,
  discovered: DiscoveredAgentSession[],
): Promise<void> {
  if (discovered.length === 0) return
  try {
    // One transaction, so a pin is never gone without its successor in place.
    await (await getDb()).transaction(async (db) => {
      const now = new Date()
      const existing = await db.select({
        tool: workspaceAgentSessions.tool,
        agentSessionId: workspaceAgentSessions.agentSessionId,
        ordinal: workspaceAgentSessions.ordinal,
      }).from(workspaceAgentSessions).where(linkKey(projectSlug, workspaceId))
      const ordinalOf = new Map(existing.map((e) => [`${e.tool}/${e.agentSessionId}`, e.ordinal]))
      let nextOrdinal = existing.reduce((max, e) => Math.max(max, e.ordinal + 1), 0)

      for (const reported of discovered) {
        const linkId = `${reported.tool}/${reported.agentSessionId}`
        const pinId = `${reported.tool}/${workspaceId}`
        // Only the tool's first conversation: a pin beside a sibling of its
        // tool predates the takeover (docs/legacy-compat-shims.md), and a
        // later conversation must not take the first one's place.
        const pinOrdinal = SELF_NAMING_TOOLS.includes(reported.tool) && !ordinalOf.has(linkId)
          && !existing.some((e) => e.tool === reported.tool && e.agentSessionId !== workspaceId)
          ? ordinalOf.get(pinId)
          : undefined
        let d = reported
        if (pinOrdinal !== undefined) {
          // What the create recorded on the pin rides into its place: its birth
          // and launch model unless the agent reported its own, and its ask
          // regardless — a `--prompt` is the opening message by definition,
          // where opencode's is only a title summarizing it.
          const [pin] = await db.delete(agentSessions).where(and(
            eq(agentSessions.projectSlug, projectSlug),
            eq(agentSessions.tool, reported.tool),
            eq(agentSessions.agentSessionId, workspaceId),
          )).returning()
          await db.delete(workspaceAgentSessions).where(and(
            linkKey(projectSlug, workspaceId),
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
        // Stored exactly as reported — the sweep already speaks the column's
        // form (project-relative, see `toProjectRelative`). Absent is not the
        // same as empty: a conversation whose path the sweep could not express
        // must not overwrite a good stored value, so the fill branch below
        // omits the column entirely rather than clearing it.
        const stored = d.transcriptPath ?? null
        // Only ever fill in — a resumed conversation is rediscovered from a
        // second workspace and must not lose what the first one learned. Built
        // first because an empty `set` is an error, not a no-op: a conversation
        // discovered with nothing but its id (the common first sighting) has to
        // take the DO NOTHING branch.
        const fill = {
          ...(stored !== null ? { transcriptPath: stored } : {}),
          ...(d.lastActiveMs !== undefined ? { lastActiveAt: new Date(d.lastActiveMs) } : {}),
          // Overwritten, not coalesced: `/model` mid-conversation is exactly
          // what this column is here to follow. An absent value still leaves
          // the stored one alone — nothing reported must not read as "the
          // model went away".
          ...(d.model !== undefined ? { model: d.model.slice(0, MAX_MODEL_LENGTH) } : {}),
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
          model: d.model?.slice(0, MAX_MODEL_LENGTH) ?? null,
        }
        const target = [
          agentSessions.projectSlug,
          agentSessions.tool,
          agentSessions.agentSessionId,
        ]
        await (Object.keys(fill).length > 0
          ? db.insert(agentSessions).values(values).onConflictDoUpdate({ target, set: fill })
          : db.insert(agentSessions).values(values).onConflictDoNothing({ target }))

        const ordinal = ordinalOf.get(linkId) ?? nextOrdinal++
        await db.insert(workspaceAgentSessions).values({
          projectSlug,
          workspaceId,
          tool: d.tool,
          agentSessionId: d.agentSessionId,
          ordinal,
          paneId: d.paneId ?? null,
          firstSeenAt: seenAt,
          lastSeenAt: now,
        }).onConflictDoUpdate({
          target: [
            workspaceAgentSessions.projectSlug,
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

const linkKey = (projectSlug: string, workspaceId: string) => and(
  eq(workspaceAgentSessions.projectSlug, projectSlug),
  eq(workspaceAgentSessions.workspaceId, workspaceId),
)

/**
 * Set which of a workspace's conversations are live, from the pane set
 * observed on this tick. Everything linked but not named goes inactive.
 *
 * Call this ONLY while the pod is observed running. Teardown must leave the
 * last-written set alone: "what was active when the workspace stopped" is
 * exactly what a restart brings back, and zeroing it on the way out would
 * restart every workspace empty.
 */
export async function setActiveAgentSessions(
  projectSlug: string,
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
    }).from(workspaceAgentSessions).where(linkKey(projectSlug, workspaceId))

    for (const row of rows) {
      const isLive = liveIds.includes(`${row.tool}/${row.agentSessionId}`)
      const paneId = live.find(
        (l) => l.tool === row.tool && l.agentSessionId === row.agentSessionId,
      )?.paneId
      // Nothing observable changed — skip the write. This runs on every
      // reconciler tick for every conversation of every running workspace, and
      // a steady state is the overwhelmingly common case.
      if (row.active === isLive && (!isLive || row.paneId === (paneId ?? null))) continue
      await db.update(workspaceAgentSessions).set({
        active: isLive,
        lastSeenAt: now,
        ...(isLive ? { paneId: paneId ?? null } : {}),
      }).where(and(
        linkKey(projectSlug, workspaceId),
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
    projectSlug: workspaceAgentSessions.projectSlug,
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

type LinkedSelect = {
  projectSlug: string
  workspaceId: string
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
  model: string | null
}

function toLinkRow(r: LinkedSelect): AgentSessionLinkRow {
  return {
    projectSlug: r.projectSlug,
    workspaceId: r.workspaceId,
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
    ...(r.model !== null ? { model: r.model } : {}),
  }
}

/**
 * The link → conversation join. A function, not a module-scope const:
 * evaluating a table reference while this module is first loading can find
 * the db barrel's table exports still uninitialized, and deferring it to call
 * time removes the load-order dependency outright.
 */
const linkJoin = () => and(
  eq(workspaceAgentSessions.projectSlug, agentSessions.projectSlug),
  eq(workspaceAgentSessions.tool, agentSessions.tool),
  eq(workspaceAgentSessions.agentSessionId, agentSessions.agentSessionId),
)

/** One workspace's conversations, in restore order. */
export async function listWorkspaceAgentSessions(
  projectSlug: string,
  workspaceId: string,
): Promise<AgentSessionLinkRow[]> {
  const db = await getDb()
  const rows = await db.select(selectLinked())
    .from(workspaceAgentSessions)
    .innerJoin(agentSessions, linkJoin())
    .where(linkKey(projectSlug, workspaceId))
    .orderBy(asc(workspaceAgentSessions.ordinal))
  return rows.map(toLinkRow)
}

/**
 * The conversations a restart should bring back: those that were live when
 * the workspace was last observed running, in window order.
 */
export async function listActiveAgentSessions(
  projectSlug: string,
  workspaceId: string,
): Promise<AgentSessionLinkRow[]> {
  const db = await getDb()
  const rows = await db.select(selectLinked())
    .from(workspaceAgentSessions)
    .innerJoin(agentSessions, linkJoin())
    .where(and(linkKey(projectSlug, workspaceId), eq(workspaceAgentSessions.active, true)))
    .orderBy(asc(workspaceAgentSessions.ordinal))
  return rows.map(toLinkRow)
}

/**
 * The recorded conversations of a workspace that sit on a live handle —
 * what an ACP driver attaching to a running pod needs to re-address agents
 * it did not start (and to `session/load` after a restart). A link with no
 * pane id names nothing it could attach to, so it is filtered here.
 *
 * Swallows a read failure: a watcher starting against an unreadable
 * database must attach with no history rather than fail the whole
 * workspace's status stream.
 */
export async function recordedConversationHandles(
  projectSlug: string,
  workspaceId: string,
): Promise<Array<{ handle: string; agentSessionId: string }>> {
  const links = await listActiveAgentSessions(projectSlug, workspaceId).catch(() => [])
  return links.flatMap((l) => (l.paneId === undefined
    ? []
    : [{ handle: l.paneId, agentSessionId: l.agentSessionId }]))
}

/**
 * The conversations of the named workspaces, grouped by workspace id — one
 * query per project per list build, so a snapshot never pays per row.
 *
 * Scoped to the workspaces the caller will actually render rather than the
 * whole project: conversations are never pruned, so a long-lived project
 * accumulates them without bound, and an unfiltered read would haul every
 * one (4000-char prompts included) into memory on every ~5s list poll only
 * to discard all but the running few.
 */
export async function getProjectAgentSessions(
  projectSlug: string,
  workspaceIds: string[],
): Promise<Map<string, AgentSessionLinkRow[]>> {
  if (workspaceIds.length === 0) return new Map()
  const db = await getDb()
  const rows = await db.select(selectLinked())
    .from(workspaceAgentSessions)
    .innerJoin(agentSessions, linkJoin())
    .where(and(
      eq(workspaceAgentSessions.projectSlug, projectSlug),
      inArray(workspaceAgentSessions.workspaceId, workspaceIds),
    ))
    .orderBy(asc(workspaceAgentSessions.ordinal))
  const byWorkspace = new Map<string, AgentSessionLinkRow[]>()
  for (const r of rows) {
    const row = toLinkRow(r)
    byWorkspace.set(row.workspaceId, [...(byWorkspace.get(row.workspaceId) ?? []), row])
  }
  return byWorkspace
}

/** The same, for a set of workspaces across projects (the stopped listing,
 *  which is capped before it reads anything). */
export async function getAgentSessionsFor(
  workspaceIds: Array<{ projectSlug: string; workspaceId: string }>,
): Promise<Map<string, AgentSessionLinkRow[]>> {
  if (workspaceIds.length === 0) return new Map()
  const db = await getDb()
  const rows = await db.select(selectLinked())
    .from(workspaceAgentSessions)
    .innerJoin(agentSessions, linkJoin())
    // Narrowed by both columns in SQL so the read scales with the ids asked
    // about, not the projects' whole history; `wanted` is the exact pair filter.
    .where(and(
      inArray(workspaceAgentSessions.projectSlug, [...new Set(workspaceIds.map((w) => w.projectSlug))]),
      inArray(workspaceAgentSessions.workspaceId, [...new Set(workspaceIds.map((w) => w.workspaceId))]),
    ))
    .orderBy(asc(workspaceAgentSessions.ordinal))
  const wanted = new Set(workspaceIds.map((w) => `${w.projectSlug}/${w.workspaceId}`))
  const byWorkspace = new Map<string, AgentSessionLinkRow[]>()
  for (const r of rows) {
    const row = toLinkRow(r)
    const k = `${row.projectSlug}/${row.workspaceId}`
    if (!wanted.has(k)) continue
    byWorkspace.set(k, [...(byWorkspace.get(k) ?? []), row])
  }
  return byWorkspace
}


/**
 * Persist a conversation's captured first message, transcript path and model.
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
  await db.delete(workspaceAgentSessions)
    .where(eq(workspaceAgentSessions.projectSlug, projectSlug))
  await db.delete(agentSessions).where(eq(agentSessions.projectSlug, projectSlug))
}

/**
 * Drop one workspace's links, and with them every conversation it was the last
 * workspace holding. The create rollback's cleanup: a create that never came up
 * wrote both a link and the conversation behind it (with the ask the user
 * typed), and nothing else prunes either — unlinked rows are inert but
 * accumulate until the project is removed.
 *
 * Conversations are shared many-to-many, so one another workspace still links
 * survives: resuming a conversation into a second workspace must not make the
 * first workspace's rollback take it away from the second.
 */
export async function deleteWorkspaceAgentSessions(
  projectSlug: string,
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
    .from(workspaceAgentSessions).where(linkKey(projectSlug, workspaceId))
  await db.delete(workspaceAgentSessions).where(linkKey(projectSlug, workspaceId))
  if (dropped.length === 0) return

  // Asked after the delete, so a conversation this workspace held twice (one
  // per pane) does not count itself as the other holder.
  const survivors = new Set((await db.select(linkedColumns)
    .from(workspaceAgentSessions).where(and(
      eq(workspaceAgentSessions.projectSlug, projectSlug),
      inArray(workspaceAgentSessions.agentSessionId, dropped.map((l) => l.agentSessionId)),
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
 * A workspace's first conversation — the one whose tool the workspace runs and
 * whose opening message labels it. Create records it moments after the
 * workspace row itself, so a row can be read in between (and a create that
 * died in that gap leaves one for good); that reads as unknown here rather
 * than being guessed at, and each caller decides what to do without one.
 */
export async function firstAgentSession(
  projectSlug: string,
  workspaceId: string,
): Promise<AgentSessionLinkRow | undefined> {
  const [first] = await listWorkspaceAgentSessions(projectSlug, workspaceId)
  return first
}

/**
 * The first conversation of each named workspace, keyed `<slug>/<id>` — the
 * batched form for listings, which would otherwise pay a query per row.
 */
export async function firstAgentSessionsFor(
  workspaces: Array<{ projectSlug: string; workspaceId: string }>,
): Promise<Map<string, AgentSessionLinkRow>> {
  const byWorkspace = await getAgentSessionsFor(workspaces)
  const firsts = new Map<string, AgentSessionLinkRow>()
  for (const [k, links] of byWorkspace) {
    const first = links[0]
    if (first !== undefined) firsts.set(k, first)
  }
  return firsts
}
