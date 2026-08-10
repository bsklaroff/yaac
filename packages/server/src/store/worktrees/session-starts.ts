import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { worktreeSessionStartsPath } from '@yaac/shared/project-paths'
import { AGENT_TOOLS } from '@yaac/shared/types'
import type { AgentTool } from '@yaac/shared/types'

/**
 * The one thing about a worktree that the host cannot see for itself: which
 * agent conversations a user has started inside its pod
 * (docs/worktree-storage.md).
 *
 * Every tool with a host-mounted home runs a `SessionStart` hook
 * (`/etc/yaac/agent-links.sh`, baked into the tools image) which appends one
 * JSON line per firing to this log, mounted into the pod as an RW `File`
 * hostPath. The hook fires on `startup`, `resume`, `clear` and `compact` —
 * exactly the events that change which conversation a pane is in — and it is
 * the only witness of a user-started one, because it alone sees `TMUX_PANE`
 * beside the tool's session id. A `/clear` and a hand-typed `claude --resume`
 * are invisible from outside the pod.
 *
 * The pod appends and the server folds. Nothing here writes what the pod
 * reads or reads what it writes twice: the log is append-only and never
 * renamed, which is exactly what makes mounting it safe, and it means no lock
 * has to cross the pod boundary from inside a gVisor sandbox.
 *
 * Nothing truncates it, either. Sightings are idempotent — a conversation id
 * maps to one handle — so re-folding the whole file every tick is correct,
 * and it avoids the drain/append race a truncation would introduce. Which
 * lines belong to the *current* pod is answered by `atByte` against the
 * worktree's recorded life boundary, not by anything in the file.
 */

/**
 * One line of the hook's log. Deliberately loose: the hook is POSIX sh and
 * must never fail the agent, so a line it garbled is skipped, not fatal.
 *
 * This is the layer that treats the pod's input as untrusted, and it is the
 * only one — the log is an RW mount, so anything running in the sandbox can
 * append to it, and everything downstream takes the value at face value: the
 * fold reports it, the server stores it verbatim, and the stopped listing
 * then stats and *parses* whatever it names. A path the hook could not
 * legitimately have written is therefore dropped here rather than sanitized
 * later.
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

/** A conversation the hook reported, with where in the log it was found —
 *  which is what says whether it belongs to the current life. */
export interface SessionStartSighting {
  agentSessionId: string
  tool: AgentTool
  /** Project-relative, as the column stores it. */
  transcriptPath?: string
  /** The tmux pane the conversation was on when the hook fired. */
  handle?: string
  /** Byte offset of the line this came from. Compared against the worktree's
   *  `lifeLogBytes`: below it, a previous pod appended the line. */
  atByte: number
}

/** What one read of the log saw. */
export interface SessionStarts {
  sightings: SessionStartSighting[]
  /**
   * The log's length as read. Reported alongside the sightings because it is
   * the quantity a recorded life boundary is an offset *into*, and comparing
   * the two is the only way to notice a log that shrank — which cannot happen
   * from anything yaac does. Taken from the same buffer as the sightings, so
   * a concurrent append cannot make the pair disagree.
   */
  sizeBytes: number
}

/**
 * Read everything the in-pod hook has appended, in log order.
 *
 * Order is first-seen order, which is also the order a restart brings windows
 * back up in, so callers must preserve it. A partial trailing line (the hook
 * writing as this reads) simply fails to parse and is picked up next tick.
 */
export async function readSessionStarts(
  projectSlug: string,
  worktreeId: string,
): Promise<SessionStarts> {
  let raw: Buffer
  try {
    raw = await fs.readFile(worktreeSessionStartsPath(projectSlug, worktreeId))
  } catch {
    return { sightings: [], sizeBytes: 0 }
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
  return { sightings: out, sizeBytes: raw.byteLength }
}

/**
 * How long the log is right now — the boundary a starting life records, so
 * the fold can tell what a previous pod appended from what this one has.
 *
 * A log that does not exist yet is a fresh worktree: zero.
 */
export async function sessionStartsLogSize(
  projectSlug: string,
  worktreeId: string,
): Promise<number> {
  return fs.stat(worktreeSessionStartsPath(projectSlug, worktreeId))
    .then((st) => st.size)
    .catch(() => 0)
}

/** Create the empty log so its `File` hostPath mount resolves on the pod's
 *  first attempt, the same reason the worktree dir is pre-created. */
export async function ensureSessionStartsLog(
  projectSlug: string,
  worktreeId: string,
): Promise<string> {
  const file = worktreeSessionStartsPath(projectSlug, worktreeId)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, '')
  return file
}

/** Remove it. Part of the worktree's single delete — see
 *  `deleteWorktreeState`. */
export async function deleteSessionStartsLog(
  projectSlug: string,
  worktreeId: string,
): Promise<void> {
  await fs.rm(worktreeSessionStartsPath(projectSlug, worktreeId), { force: true })
}
