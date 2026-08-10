import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { z } from 'zod'
import {
  worktreeMetaPath,
  worktreeSessionStartsPath,
} from '@yaac/shared/project-paths'
import { createKeyedMutex } from '#platform/keyed-mutex'
import { MAX_PROMPT_LENGTH } from '@yaac/shared/herd'
import { AGENT_TOOLS } from '@yaac/shared/types'
import { serverLog } from '#log'

/**
 * The herd's own durable index of a worktree: what it is, and which agent
 * sessions it has hosted (docs/worktree-storage.md).
 *
 * This is the file that replaces the per-tool `.yaac-links` trees. The herd may
 * not read the database (docs/plans/layered-server.md), so it needs somewhere of
 * its own to remember what it has discovered — and one document per worktree,
 * rewritten whole, is a great deal easier to reason about than a tree of
 * pointer files spread across three tool homes.
 *
 * **It holds only what the herd needs to work without the database.** Titles,
 * background pins, `stoppedAt` and death causes are the server's; mirroring one
 * here would make two sources of truth that drift. What is here is what the
 * herd would otherwise have to ask for: which sessions a worktree has, where
 * their transcripts are, and which handle each is on right now.
 *
 * Writes are whole-document and atomic (tmp + rename), serialized per worktree
 * by the mutex below. The server process is the only writer — the in-pod hook
 * appends to a separate log this module folds in (see `foldSessionStarts`) —
 * so in-process serialization is sufficient mutual exclusion, and no lock has
 * to cross the pod boundary.
 */

export const WORKTREE_META_VERSION = 1

const sessionSchema = z.object({
  /** The tool's own session id — what `--resume` takes. */
  agentSessionId: z.string().min(1),
  tool: z.enum(AGENT_TOOLS),
  mode: z.enum(['tui', 'acp']),
  /**
   * Stamped by the herd when it first records the session, so the in-pod hook
   * never has to produce a timestamp. Array order is first-seen order, which
   * is also the order a restart brings windows back up in.
   */
  firstSeenMs: z.number().int().nonnegative(),
  /** Relative to the project directory, as everything stores it. */
  transcriptPath: z.string().optional(),
  firstPrompt: z.string().max(MAX_PROMPT_LENGTH).optional(),
  /**
   * The driver's handle — a tmux pane id under `tui`, the acpd window name
   * under `acp`. Meaningful only while `handleLifeId` names the current life:
   * tmux pane ids restart at `%0`, so last life's handle would otherwise name
   * this life's pane. That pairing is what `clearPanePointers` used to do by
   * deleting the pointers before a pod started.
   */
  handle: z.string().optional(),
  handleLifeId: z.string().optional(),
})

const lifeSchema = z.object({
  id: z.string().min(1),
  startedAtMs: z.number().int().nonnegative(),
  jobName: z.string().min(1),
  /**
   * How long the session-starts log was when this life began — the boundary
   * between what a previous pod appended and what this one has.
   *
   * The log is never truncated and its lines carry no life marker, so without
   * this every fold would re-stamp the previous life's pane onto the current
   * one. tmux pane ids restart at `%0`, so that stale pane usually belongs to
   * a *different* session in the new pod: the dead one would report active on
   * another session's pane, and the wrongly-active set is what freezes at
   * teardown for the next restart to resume. Recording the offset is what
   * makes "appended during this life" answerable without the hook having to
   * know which life it is in.
   */
  logBytes: z.number().int().nonnegative(),
})

export const worktreeMetaSchema = z.object({
  version: z.literal(WORKTREE_META_VERSION),
  projectSlug: z.string().min(1),
  worktreeId: z.string().min(1),
  createdAtMs: z.number().int().nonnegative(),
  branch: z.string().min(1),
  baseBranch: z.string().optional(),
  /** A prewarmed spare is not a worktree until claimed. Recorded so a reap can
   *  tell one from a real worktree once its pod is already gone. */
  spare: z.boolean(),
  /** The pod currently hosting it, if any. */
  life: lifeSchema.optional(),
  sessions: z.array(sessionSchema),
})

export type WorktreeMeta = z.infer<typeof worktreeMetaSchema>
export type WorktreeMetaSession = z.infer<typeof sessionSchema>

/** Serializes read-modify-write per worktree — see the module doc. */
const metaMutex = createKeyedMutex()

/**
 * Read a worktree's document, or undefined when it has none this install can
 * use.
 *
 * A document that fails its schema is treated as absent rather than fatal. The
 * herd's other inputs — the session-starts log, the transcripts on disk, the
 * cluster — are still there, so the worst case is that a worktree is
 * rediscovered rather than remembered. Refusing to proceed would strand it.
 */
export async function readWorktreeMeta(
  projectSlug: string,
  worktreeId: string,
): Promise<WorktreeMeta | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(worktreeMetaPath(projectSlug, worktreeId), 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    serverLog(`[herd] worktree meta ${projectSlug}/${worktreeId}: unparseable, ignoring`)
    return undefined
  }
  const result = worktreeMetaSchema.safeParse(parsed)
  if (!result.success) {
    // A *higher* version is the one case worth naming separately: it is not
    // corruption, it is a newer yaac's document, and the update path below
    // refuses to rewrite it for the same reason.
    const version = (parsed as { version?: unknown } | null)?.version
    serverLog(
      `[herd] worktree meta ${projectSlug}/${worktreeId}: `
      + (typeof version === 'number' && version > WORKTREE_META_VERSION
        ? `version ${version} is newer than ${WORKTREE_META_VERSION}, ignoring`
        : 'failed validation, ignoring'),
    )
    return undefined
  }
  return result.data
}

/** Is there a document here that a newer yaac wrote? */
async function isNewerVersion(file: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    const version = (parsed as { version?: unknown } | null)?.version
    return typeof version === 'number' && version > WORKTREE_META_VERSION
  } catch {
    return false
  }
}

/** Whole-document atomic write. Rename, so a reader never sees a torn file —
 *  and so this document can never be a `File` hostPath mount. */
async function writeWorktreeMeta(meta: WorktreeMeta): Promise<void> {
  const file = worktreeMetaPath(meta.projectSlug, meta.worktreeId)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${crypto.randomBytes(6).toString('hex')}`
  try {
    await fs.writeFile(tmp, JSON.stringify(meta, null, 2) + '\n')
    await fs.rename(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
}

/**
 * Apply `mutate` to the worktree's document and write the result, serialized
 * against every other update to the same worktree.
 *
 * `mutate` receives the current document, or `undefined` when there is none —
 * returning `undefined` from it declines the write, which is how a caller that
 * only ever *updates* (a discovery sweep, say) avoids inventing a document for
 * a worktree that create never recorded. Best-effort throughout: a failed write
 * degrades what the herd remembers, and must never fail a create or a teardown.
 */
export async function updateWorktreeMeta(
  projectSlug: string,
  worktreeId: string,
  mutate: (current: WorktreeMeta | undefined) => WorktreeMeta | undefined,
): Promise<void> {
  await metaMutex(`${projectSlug}/${worktreeId}`, async () => {
    try {
      const file = worktreeMetaPath(projectSlug, worktreeId)
      const current = await readWorktreeMeta(projectSlug, worktreeId)
      // Never downgrade: zod strips unknown keys, so rewriting a newer
      // document would silently drop whatever it knows that this version
      // does not.
      if (current === undefined && await isNewerVersion(file)) return
      const next = mutate(current)
      if (next === undefined) return
      await writeWorktreeMeta(next)
    } catch (err) {
      serverLog(`[herd] worktree meta ${projectSlug}/${worktreeId}: ${String(err)}`)
    }
  })
}

/**
 * Clear the spare flag, and answer whether the document now agrees.
 *
 * The one write on this document that a caller must be able to fail on. The
 * startup sweep DELETES a worktree's checkout on the strength of `spare:
 * true`, so a silently-dropped flip would leave a real worktree — one a user
 * is about to be handed — marked as a spare, and the next server start would
 * take their work with it. `updateWorktreeMeta` swallows its errors by design,
 * which is right for every other caller and exactly wrong for this one.
 *
 * Verified by reading back rather than by a throwing write: what matters is
 * not that the write succeeded but that the document no longer says `spare`,
 * and a missing or unreadable document satisfies that too — the sweep skips
 * both, so neither can trigger a deletion.
 */
export async function clearSpareFlag(
  projectSlug: string,
  worktreeId: string,
  fields: Partial<Pick<WorktreeMeta, 'baseBranch'>> = {},
): Promise<boolean> {
  await updateWorktreeMeta(projectSlug, worktreeId, (current) =>
    current === undefined ? undefined : { ...current, ...fields, spare: false })
  const after = await readWorktreeMeta(projectSlug, worktreeId).catch(() => undefined)
  return after?.spare !== true
}

/** A worktree's document as create first records it. */
export function newWorktreeMeta(input: {
  projectSlug: string
  worktreeId: string
  branch: string
  baseBranch?: string
  spare?: boolean
  createdAtMs: number
}): WorktreeMeta {
  return {
    version: WORKTREE_META_VERSION,
    projectSlug: input.projectSlug,
    worktreeId: input.worktreeId,
    createdAtMs: input.createdAtMs,
    branch: input.branch,
    ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
    spare: input.spare ?? false,
    sessions: [],
  }
}

/**
 * Record that a pod has come up for this worktree.
 *
 * A fresh life id is what invalidates every handle the previous one recorded,
 * without deleting anything: a handle counts only while `handleLifeId` matches
 * (see the schema). Session create used to achieve that by removing the pane
 * pointers from three tool homes before the pod started.
 *
 * The log's current length is recorded with it, because the id alone cannot
 * do the job: the fold would otherwise stamp the new life onto lines the
 * previous pod wrote. See `logBytes`.
 */
export async function recordWorktreeLife(
  projectSlug: string,
  worktreeId: string,
  jobName: string,
  startedAtMs: number,
): Promise<string> {
  const id = crypto.randomUUID()
  // Nothing has appended for this life yet, so whatever is there belongs to
  // the last one. A log that does not exist yet is a fresh worktree: zero.
  const logBytes = await fs.stat(worktreeSessionStartsPath(projectSlug, worktreeId))
    .then((st) => st.size)
    .catch(() => 0)
  await updateWorktreeMeta(projectSlug, worktreeId, (current) =>
    current === undefined
      ? undefined
      : { ...current, life: { id, startedAtMs, jobName, logBytes } })
  return id
}

/**
 * Merge sightings of a worktree's sessions into its document, in first-seen
 * order.
 *
 * Only ever adds and fills: a sweep that reads a compacted transcript must not
 * replace an opening message the create path recorded, and a session seen
 * without a handle has not moved — it simply was not observed this pass. The
 * one field that overwrites is the handle pair, because that is the thing whose
 * whole job is to say where a session is *now*.
 */
export function mergeSessions(
  current: WorktreeMeta,
  seen: Array<Partial<WorktreeMetaSession> & Pick<WorktreeMetaSession, 'agentSessionId' | 'tool'>>,
  nowMs: number,
): WorktreeMeta {
  const sessions = [...current.sessions]
  for (const s of seen) {
    const at = sessions.findIndex(
      (e) => e.agentSessionId === s.agentSessionId && e.tool === s.tool)
    if (at < 0) {
      sessions.push({
        agentSessionId: s.agentSessionId,
        tool: s.tool,
        mode: s.mode ?? 'tui',
        firstSeenMs: s.firstSeenMs ?? nowMs,
        ...(s.transcriptPath !== undefined ? { transcriptPath: s.transcriptPath } : {}),
        ...(s.firstPrompt !== undefined
          ? { firstPrompt: s.firstPrompt.slice(0, MAX_PROMPT_LENGTH) }
          : {}),
        ...(s.handle !== undefined ? { handle: s.handle } : {}),
        ...(s.handleLifeId !== undefined ? { handleLifeId: s.handleLifeId } : {}),
      })
      continue
    }
    const prev = sessions[at]
    sessions[at] = {
      ...prev,
      // Mode is decided when a session is opened and cannot change mid-life,
      // so a later sighting that guessed must not rewrite it.
      ...(s.transcriptPath !== undefined ? { transcriptPath: s.transcriptPath } : {}),
      ...(prev.firstPrompt === undefined && s.firstPrompt !== undefined
        ? { firstPrompt: s.firstPrompt.slice(0, MAX_PROMPT_LENGTH) }
        : {}),
      ...(s.handle !== undefined
        ? { handle: s.handle, ...(s.handleLifeId !== undefined ? { handleLifeId: s.handleLifeId } : {}) }
        : {}),
    }
  }
  return { ...current, sessions }
}

/**
 * The sessions this worktree is running right now, according to the document
 * alone: those whose handle belongs to the current life.
 *
 * Not the same question as "which are alive" — a handle outlives the pane that
 * wrote it — which is why the registry still intersects this with what the
 * status watcher can see.
 */
export function worktreesOnCurrentLife(meta: WorktreeMeta): WorktreeMetaSession[] {
  const lifeId = meta.life?.id
  if (lifeId === undefined) return []
  return meta.sessions.filter((s) => s.handle !== undefined && s.handleLifeId === lifeId)
}

/**
 * One line of the in-pod hook's log. Deliberately loose: the hook is POSIX sh
 * and must never fail the agent, so a line it garbled is skipped, not fatal.
 *
 * This is the layer that treats the pod's input as untrusted, and it is the
 * only one — the log is an RW `File` mount, so anything running in the
 * sandbox can append to it, and everything downstream takes the value at face
 * value: the fold writes it to the document, the document reports it, the
 * server stores it verbatim, and the stopped listing then stats and *parses*
 * whatever it names. A path the hook could not legitimately have written is
 * therefore dropped here rather than sanitized later.
 */
const sessionStartSchema = z.object({
  id: z.string().min(1),
  tool: z.enum(AGENT_TOOLS),
  /** tmux pane id with the leading `%` stripped, absent outside tmux. */
  pane: z.string().optional(),
  /**
   * Project-relative, empty when the tool wrote outside the project tree.
   *
   * Absolute is refused, not just traversal: an absolute path names a file
   * anywhere on the host, and the column holds project-relative values only.
   * The hook only ever emits a path it built by stripping its own home, so
   * anything else came from something other than the hook.
   */
  path: z.string().refine(
    (p) => p === '' || (!path.isAbsolute(p) && !p.split(/[\\/]/).includes('..')),
    { message: 'transcript path must be project-relative' },
  ).optional(),
})

/**
 * Read what the in-pod hook has appended since this worktree started, as
 * sightings to merge.
 *
 * Nothing truncates the log: sightings are idempotent — a session id maps to
 * one handle — so re-folding the whole file every tick is correct, and it
 * avoids the drain/append race a truncation would introduce. A partial trailing
 * line (the hook writing as this reads) simply fails to parse and is picked up
 * next tick.
 */
/** A sighting, with where in the log it was found — which is what says
 *  whether it belongs to the current life (see `life.logBytes`). */
export type SessionStartSighting =
  Pick<WorktreeMetaSession, 'agentSessionId' | 'tool'>
  & Partial<WorktreeMetaSession>
  & { atByte: number }

export async function readSessionStarts(
  projectSlug: string,
  worktreeId: string,
): Promise<SessionStartSighting[]> {
  let raw: Buffer
  try {
    raw = await fs.readFile(worktreeSessionStartsPath(projectSlug, worktreeId))
  } catch {
    return []
  }
  const out: SessionStartSighting[] = []
  let at = 0
  for (const line of raw.toString('utf8').split('\n')) {
    const startedAt = at
    // Byte length, not character count: the offset is compared against a
    // file size, and a multi-byte character would drift the two apart.
    at += Buffer.byteLength(line, 'utf8') + 1
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const result = sessionStartSchema.safeParse(parsed)
    if (!result.success) continue
    const { id, tool, pane, path: rel } = result.data
    out.push({
      atByte: startedAt,
      agentSessionId: id,
      tool,
      ...(rel !== undefined && rel !== '' ? { transcriptPath: rel } : {}),
      ...(pane !== undefined && pane !== '' ? { handle: `%${pane}` } : {}),
    })
  }
  return out
}

/**
 * Fold everything the in-pod hook has appended into the worktree's document
 * and return the result.
 *
 * The one call a discovery tick needs: the hook's log is the only thing that
 * knows a user started a session, and the document is the only thing that
 * remembers it across a herd restart. Returns undefined for a worktree with no
 * document — a spare that was never claimed, or one created before this
 * existed — which the caller treats as "nothing recorded yet".
 *
 * Handles are stamped with the current life as they are folded, because that
 * is the only moment both facts are in hand: the log says which pane, and the
 * document says which life that pane belongs to.
 */
export async function foldSessionStarts(
  projectSlug: string,
  worktreeId: string,
): Promise<WorktreeMeta | undefined> {
  const seen = await readSessionStarts(projectSlug, worktreeId)
  if (seen.length > 0) {
    await updateWorktreeMeta(projectSlug, worktreeId, (current) => {
      if (current === undefined) return undefined
      const life = current.life
      return mergeSessions(current, seen.map(({ atByte, ...s }) => {
        // A line the PREVIOUS pod appended still tells us the session exists
        // and where its transcript is — but its pane belongs to a pod that is
        // gone, and tmux pane ids restart at `%0`, so carrying the handle
        // forward would attribute a dead session to whichever live pane
        // inherited its number. Drop the handle, keep the session.
        if (life === undefined || atByte < life.logBytes) {
          const { handle: _stale, ...rest } = s
          return rest
        }
        return { ...s, ...(s.handle !== undefined ? { handleLifeId: life.id } : {}) }
      }), Date.now())
    })
  }
  return readWorktreeMeta(projectSlug, worktreeId)
}

/** Create the empty session-starts log so its `File` hostPath mount resolves
 *  on the pod's first attempt, the same reason the worktree dir is
 *  pre-created. */
export async function ensureSessionStartsLog(
  projectSlug: string,
  worktreeId: string,
): Promise<string> {
  const file = worktreeSessionStartsPath(projectSlug, worktreeId)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, '')
  return file
}

/** Remove both files. Part of the worktree's single delete — see
 *  `deleteWorktreeState`. */
export async function deleteWorktreeMeta(
  projectSlug: string,
  worktreeId: string,
): Promise<void> {
  await Promise.all([
    fs.rm(worktreeMetaPath(projectSlug, worktreeId), { force: true }),
    fs.rm(worktreeSessionStartsPath(projectSlug, worktreeId), { force: true }),
  ])
}
