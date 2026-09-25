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

/** Where claude files a conversation: one directory per cwd it has been run
 *  in, named for that path with the separators punched out (`/workspace`
 *  becomes `-workspace`). */
function claudeProjectsDir(slug: string): string {
  return path.join(claudeDir(slug), 'projects')
}

/**
 * Under the pod driver the agent's cwd is always `/workspace`, so this is the
 * only directory that can hold a conversation — and checking it first keeps
 * the common case a single `access`.
 */
function claudeTranscriptDir(slug: string): string {
  return path.join(claudeProjectsDir(slug), '-workspace')
}

/**
 * A claude conversation's transcript, by searching rather than by assuming
 * one cwd.
 *
 * The pod driver's `/workspace` is not universal: a containerless worktree
 * runs claude in the host checkout, so its conversations are filed under a
 * directory named for *that* path. Deriving the name would mean reproducing
 * claude's munging of an absolute path, and reproducing it for whichever
 * driver launched this particular worktree; the file is named for the
 * conversation either way, so looking for it is both simpler and driver-
 * neutral.
 *
 * Only reached when nothing recorded a path — the hook stamps one for every
 * conversation it sees, so this is the fallback for a worktree whose pod died
 * before the registry's first tick.
 *
 * A conversation id identifies one conversation, so at most one directory
 * should hold it; the scan is sorted anyway, so a session somehow filed twice
 * (resumed from a different cwd) resolves to the same file on every call
 * rather than to whatever the filesystem happened to enumerate first. An
 * arbitrary-but-stable answer is worth more here than a fresh coin flip per
 * read, since this one feeds a rendered transcript.
 */
async function findClaudeTranscript(slug: string, sessionId: string): Promise<string | undefined> {
  const conventional = path.join(claudeTranscriptDir(slug), `${sessionId}.jsonl`)
  if (await exists(conventional)) return conventional
  let entries: Dirent[]
  try {
    entries = await fs.readdir(claudeProjectsDir(slug), { withFileTypes: true })
  } catch {
    return undefined
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(claudeProjectsDir(slug), entry.name, `${sessionId}.jsonl`)
    if (await exists(candidate)) return candidate
  }
  return undefined
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
 * And an absolute path names one machine's layout: project-relative is the
 * form that stays true wherever the data dir sits
 * (docs/layered-server.md).
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
 * has none. Null is the same verdict the workspace-side hook reaches when it
 * writes an empty record (see worktree-bin/yaac-agent-links): the conversation
 * is real, only its path is unexpressible.
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
 * is why its one caller is worth naming: `absoluteTranscriptPath` in
 * `#domain/worktrees`, the door every reader of a *recorded* path comes
 * through (the stopped listing's last-activity stat and the detail route's
 * founding-ask parse both arrive that way).
 *
 * Absolute paths exist legitimately elsewhere without coming through here at
 * all — the discovery sweep builds its own with `sessionTranscriptPath` and
 * stats what it found, encoding with `toProjectRelative` on the way to a
 * column. Decoding is what has exactly one door.
 *
 * An absolute stored value is refused outright rather than joined onto the
 * project directory, which would fabricate a path that resolves nowhere. The
 * column holds project-relative values only: `toProjectRelative` emits
 * nothing else, and the hook's own schema refuses an absolute at the door.
 *
 * Refusing is logged because every caller degrades *silently* — `toLinkRow`
 * just omits the path, and the row surfaces as a listing with no prompt and no
 * last-activity. Only a writer that bypassed the encoder can put an absolute
 * here, so the line names a bug rather than a state: it is pure signal, and in
 * a healthy install this branch is unreachable.
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
  return findClaudeTranscript(projectSlug, worktreeId)
}

/** Last time the agent appended to a transcript, or undefined if it's gone. */
export async function transcriptLastActiveMs(transcriptPath: string): Promise<number | undefined> {
  try {
    return (await fs.stat(transcriptPath)).mtimeMs
  } catch {
    return undefined
  }
}
