import fs from 'node:fs/promises'
import path from 'node:path'
import type { Dirent } from 'node:fs'
import { claudeDir, piSessionsDir, projectDir } from '@yaac/shared/project-paths'
import type { AgentTool } from '@yaac/shared/types'
import { serverLog } from '#log'

/**
 * Where each tool's session transcript lives on the host — the one place
 * that knows the per-tool file layout. The agent modules read what's *in*
 * these files; the session store records the path so nothing else has to
 * derive it, and the deleted-session listing stats it for last-activity.
 *
 * opencode is the odd one out: it keeps its history in a per-session sqlite
 * DB inside the container and leaves no host transcript, so its sessions
 * simply carry no path (their first message is captured over HTTP instead).
 */

/** Claude writes `<claudeDir>/projects/-workspace/<worktreeId>.jsonl` — the
 *  agent's cwd is always /workspace, so the project dir name is fixed. */
function claudeTranscriptDir(slug: string): string {
  return path.join(claudeDir(slug), 'projects', '-workspace')
}

/**
 * How a transcript path travels and how it is stored: **relative to the
 * project directory**, never absolute, and the same form everywhere — in the
 * in-pod hook's record, in the `sessions-discovered` event, and in
 * `agent_sessions.transcriptPath`.
 *
 * One form rather than three. An absolute path carries the data dir, so it
 * pins a row to the directory that wrote it: move the data dir (a restored
 * backup, a changed `YAAC_DATA_DIR`) and every row points somewhere that no
 * longer exists, silently, because the readers only ever stat these paths.
 * And an absolute path in a herd event names a path on the *herd's* machine,
 * which the server can neither resolve nor meaningfully store once the two
 * are separate processes (docs/plans/herd-split.md).
 *
 * Project-relative rather than tool-home-relative because it needs no tool:
 * every tool home is `<projectDir>/<tool>`, so the tool segment is simply the
 * first component, and nothing has to know which home a path came out of.
 *
 * The pair is asymmetric on purpose: encoding can fail — a transcript outside
 * the project directory has no relative form — and decoding cannot.
 */

/** `path.relative` produced something that isn't *inside* the root. */
function escapesRoot(rel: string): boolean {
  return rel === '' || rel.startsWith('..') || path.isAbsolute(rel)
}

/**
 * An absolute transcript path in the form everything stores, or null when it
 * has none. Null is the same verdict the in-pod hook reaches when it writes
 * an empty record (see dockerfiles/Dockerfile.tools): the conversation is
 * real, only its path is unexpressible.
 *
 * Purely textual, and can be: every path that reaches here is built from
 * `projectDir(slug)` by the same literal joins this un-joins — the hook
 * strips its own home, and the host-side builders start from `claudeDir` /
 * `piSessionsDir`. Nothing hands it a realpath-resolved path.
 */
export function toProjectRelative(slug: string, absolute: string): string | null {
  const rel = path.relative(projectDir(slug), absolute)
  return escapesRoot(rel) ? null : rel
}

/**
 * The absolute path a stored value names, or undefined when it names one this
 * install cannot resolve.
 *
 * The only place the relative form is turned back into bytes on a disk, which
 * is why its callers are worth naming. Two: `toLinkRow` in the record store,
 * which is the single projection every server-side reader comes through (the
 * stopped listing's last-activity stat and the detail route's founding-ask
 * parse both arrive that way), and the discovery sweep, which is herd-side
 * and legitimately works in absolute paths. The first is the whole of the
 * shared-filesystem assumption between the halves — it wants to be a herd
 * call, and until it is, that funnel is where it lives.
 *
 * An absolute stored value is refused outright rather than joined onto the
 * project directory, which would fabricate a path that resolves nowhere. The
 * column holds project-relative values only: `toProjectRelative` emits
 * nothing else, and the hook's own schema refuses an absolute at the door.
 *
 * Refusing is logged because every caller degrades *silently* — `toLinkRow`
 * just omits the path, and the row surfaces as a listing with no prompt and no
 * last-activity. Two things can put an absolute here, and both are worth a
 * line: a new writer that bypassed the encoder, or a row stranded by an
 * install that upgraded past the pass that used to relativize them (claude and
 * pi rows recover through `stoppedPrompt`'s conventional-path fallback, but a
 * codex rollout filename follows from nothing, so that pointer is gone). The
 * line is pure signal — in a healthy install this branch is unreachable.
 */
export function resolveProjectPath(slug: string, stored: string): string | undefined {
  if (path.isAbsolute(stored)) {
    serverLog(`[transcripts] refusing absolute recorded path for ${slug}: ${stored}`)
    return undefined
  }
  const root = projectDir(slug)
  const joined = path.join(root, stored)
  // Symmetric with the encoder: refuse anything that does not land inside the
  // project directory. `path.join` resolves embedded `..`, so a stored value
  // the encoder could never emit cannot walk out of it here.
  return escapesRoot(path.relative(root, joined)) ? undefined : joined
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * pi's JSONL logs under `slug`'s shared pi home, sorted chronologically. pi
 * names files `<timestamp>_<uuid>.jsonl` and may nest them under a
 * cwd-derived subdir, so walk one level of subdirectories too. The timestamp
 * prefix sorts chronologically, so a lexical basename sort matches session
 * order (mtime would drift as pi appends).
 */
export async function listPiJsonlFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  async function walk(d: string, depth: number): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isFile() && e.name.endsWith('.jsonl')) found.push(full)
      else if (e.isDirectory() && depth > 0) await walk(full, depth - 1)
    }
  }
  await walk(dir, 1)
  return found.sort((a, b) => path.basename(a).localeCompare(path.basename(b)))
}

/**
 * The session id embedded in a pi log filename. pi names each log
 * `<timestamp>_<worktreeId>.jsonl` (we pass our session id via `--session-id`);
 * the timestamp prefix carries no underscore, so the id is everything after
 * the first one. Returns undefined for a name without that separator.
 */
export function sessionIdFromPiLog(file: string): string | undefined {
  const base = path.basename(file, '.jsonl')
  const sep = base.indexOf('_')
  if (sep < 0) return undefined
  const id = base.slice(sep + 1)
  return id.length > 0 ? id : undefined
}

/** A session's pi logs (oldest first), matched by id within the shared home. */
export async function piSessionLogs(projectSlug: string, worktreeId: string): Promise<string[]> {
  const files = await listPiJsonlFiles(piSessionsDir(projectSlug))
  return files.filter((f) => sessionIdFromPiLog(f) === worktreeId)
}

/**
 * The transcript path to record for a session, or undefined when the tool
 * leaves none (opencode) or hasn't written one yet. claude and codex have
 * a deterministic path keyed by the session id. codex is absent: its rollout
 * filename is not derivable from any id, so only the recorded path finds it.
 * pi picks its own filename, so its newest log wins.
 */
export async function sessionTranscriptPath(
  projectSlug: string,
  worktreeId: string,
  tool: AgentTool,
): Promise<string | undefined> {
  // codex is absent on purpose: it names its rollout files unpredictably, so
  // nothing derives one from a session id. yaac used to index them with a
  // symlink; the DB now carries the path instead, and a codex conversation
  // the DB does not know is simply unresolvable.
  if (tool === 'opencode' || tool === 'codex') return undefined
  if (tool === 'pi') {
    const logs = await piSessionLogs(projectSlug, worktreeId)
    return logs[logs.length - 1]
  }
  const file = path.join(claudeTranscriptDir(projectSlug), `${worktreeId}.jsonl`)
  return await exists(file) ? file : undefined
}

/** Last time the agent appended to a transcript, or undefined if it's gone. */
export async function transcriptLastActiveMs(transcriptPath: string): Promise<number | undefined> {
  try {
    return (await fs.stat(transcriptPath)).mtimeMs
  } catch {
    return undefined
  }
}
