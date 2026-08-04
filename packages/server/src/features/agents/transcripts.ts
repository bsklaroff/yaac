import fs from 'node:fs/promises'
import path from 'node:path'
import type { Dirent } from 'node:fs'
import { claudeDir, codexTranscriptDir, piSessionsDir, toolHomeDir } from '@yaac/shared/project-paths'
import type { AgentTool } from '@yaac/shared/types'

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

/** Claude writes `<claudeDir>/projects/-workspace/<sessionId>.jsonl` — the
 *  agent's cwd is always /workspace, so the project dir name is fixed. */
function claudeTranscriptDir(slug: string): string {
  return path.join(claudeDir(slug), 'projects', '-workspace')
}

/**
 * How `agent_sessions.transcriptPath` is stored: relative to the tool home,
 * never absolute.
 *
 * The home carries the data dir, so an absolute path pins every row to the
 * directory that wrote it — move the data dir (a restored backup, a changed
 * `YAAC_DATA_DIR`) and every row points somewhere that no longer exists,
 * silently, because the readers only ever stat these paths. Relative rows
 * survive the move: the home is rejoined at read time from the row's own
 * project and tool. The in-pod hook already records the link tree this way
 * (see `agent-links.ts`), so this makes the DB agree with it.
 *
 * The pair is asymmetric on purpose: encoding can fail — a transcript
 * outside the home has no relative form — and decoding cannot.
 */

/** Tools whose host-mounted home holds a transcript. opencode keeps its
 *  history in a per-session sqlite DB inside the container, so it never has
 *  a path to store. */
function hasToolHome(tool: AgentTool): tool is 'claude' | 'codex' | 'pi' {
  return tool === 'claude' || tool === 'codex' || tool === 'pi'
}

/** `path.relative` produced something that isn't *inside* the home. */
function escapesHome(rel: string): boolean {
  return rel === '' || rel.startsWith('..') || path.isAbsolute(rel)
}

/**
 * An absolute transcript path in the form the column stores, or null when it
 * has none. Null is the same verdict the in-pod hook reaches when it writes
 * an empty record (see dockerfiles/Dockerfile.tools): the conversation is
 * real, only its path is unexpressible.
 *
 * The realpath fallback exists for the legacy-symlink branch of
 * `readWorktreeLinks`, which resolves through symlinks — on a data dir with
 * a symlinked component (macOS `/tmp` → `/private/tmp`) the literal home is
 * not a textual prefix of the path it hands back.
 */
export async function toStoredTranscriptPath(
  slug: string,
  tool: AgentTool,
  absolute: string,
): Promise<string | null> {
  if (!hasToolHome(tool)) return null
  const home = toolHomeDir(slug, tool)
  const rel = path.relative(home, absolute)
  if (!escapesHome(rel)) return rel
  const realHome = await fs.realpath(home).catch(() => null)
  if (realHome === null) return null
  const viaReal = path.relative(realHome, absolute)
  return escapesHome(viaReal) ? null : viaReal
}

/**
 * The absolute path a stored value names, or undefined when the row names
 * one this install cannot resolve.
 *
 * An absolute stored value is a row the one-shot relativize sweep has not
 * reached (`relativizeTranscriptPaths`); return it as-is rather than joining
 * it onto the home, which would fabricate a path that resolves nowhere.
 */
export function fromStoredTranscriptPath(
  slug: string,
  tool: AgentTool,
  stored: string,
): string | undefined {
  if (path.isAbsolute(stored)) return stored
  if (!hasToolHome(tool)) return undefined
  const home = toolHomeDir(slug, tool)
  const joined = path.join(home, stored)
  // Symmetric with the encoder: refuse anything that does not land inside
  // the home. `path.join` resolves embedded `..`, so a stored value the
  // encoder could never emit cannot walk out of it here.
  return escapesHome(path.relative(home, joined)) ? undefined : joined
}

/**
 * The home-relative tail of an absolute path that a *different* data dir
 * wrote — the restored-backup case, where the path names a home this install
 * does not have and so `toStoredTranscriptPath` cannot express it.
 *
 * Every tool home is `<root>/projects/<slug>/<tool>`, so that boundary is
 * enough to recover the tail without the old root existing. The *last*
 * occurrence wins: a path from inside a yaac-in-yaac data dir repeats the
 * marker, and the innermost one is the real home.
 */
export function rehomeTranscriptPath(
  slug: string,
  tool: AgentTool,
  absolute: string,
): string | null {
  if (!hasToolHome(tool)) return null
  const marker = `${path.sep}${path.join('projects', slug, tool)}${path.sep}`
  const at = absolute.lastIndexOf(marker)
  if (at < 0) return null
  const rel = absolute.slice(at + marker.length)
  return escapesHome(rel) ? null : rel
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
 * `<timestamp>_<sessionId>.jsonl` (we pass our session id via `--session-id`);
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
export async function piSessionLogs(projectSlug: string, sessionId: string): Promise<string[]> {
  const files = await listPiJsonlFiles(piSessionsDir(projectSlug))
  return files.filter((f) => sessionIdFromPiLog(f) === sessionId)
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
  sessionId: string,
  tool: AgentTool,
): Promise<string | undefined> {
  // codex is absent on purpose: it names its rollout files unpredictably, so
  // nothing derives one from a session id. yaac used to index them with a
  // symlink; the DB now carries the path instead, and a codex conversation
  // the DB does not know is simply unresolvable.
  if (tool === 'opencode' || tool === 'codex') return undefined
  if (tool === 'pi') {
    const logs = await piSessionLogs(projectSlug, sessionId)
    return logs[logs.length - 1]
  }
  const file = path.join(claudeTranscriptDir(projectSlug), `${sessionId}.jsonl`)
  return await exists(file) ? file : undefined
}

/** What the backfill learns about one session from the files it left behind. */
export interface TranscriptRecord {
  sessionId: string
  tool: AgentTool
  transcriptPath: string
  createdAtMs: number
}

async function collect(
  dir: string,
  tool: AgentTool,
  files: string[],
  sessionIdOf: (file: string) => string | undefined,
): Promise<TranscriptRecord[]> {
  const out: TranscriptRecord[] = []
  for (const file of files) {
    const sessionId = sessionIdOf(file)
    if (sessionId === undefined) continue
    const full = path.isAbsolute(file) ? file : path.join(dir, file)
    try {
      // stat follows through, so a recorded path that is still a legacy
      // symlink stats its target rather than the link itself.
      // it's the rollout's timestamps we want.
      const s = await fs.stat(full)
      out.push({ sessionId, tool, transcriptPath: full, createdAtMs: s.birthtimeMs })
    } catch {
      // Unstattable (raced deletion, dangling legacy symlink) — skip.
    }
  }
  return out
}

/**
 * Every session a project's transcripts prove existed, for the one-shot
 * backfill of sessions that predate the `agent_sessions` table.
 * Deliberately NOT a steady-state input: after the backfill, an
 * unrecognized transcript belongs to a conversation the agent started for
 * itself (`/clear`), not to a yaac session, and adopting it would
 * resurrect the phantom rows this table exists to remove.
 */
export async function scanProjectTranscripts(projectSlug: string): Promise<TranscriptRecord[]> {
  const jsonlNames = async (dir: string): Promise<string[]> => {
    try {
      return (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'))
    } catch {
      return [] // no record dir for this tool
    }
  }
  const claudeRoot = claudeTranscriptDir(projectSlug)
  const codexRoot = codexTranscriptDir(projectSlug)
  const basename = (f: string): string => path.basename(f, '.jsonl')
  return [
    ...await collect(claudeRoot, 'claude', await jsonlNames(claudeRoot), basename),
    ...await collect(codexRoot, 'codex', await jsonlNames(codexRoot), basename),
    ...await collect('', 'pi', await listPiJsonlFiles(piSessionsDir(projectSlug)), sessionIdFromPiLog),
  ]
}

/** Last time the agent appended to a transcript, or undefined if it's gone. */
export async function transcriptLastActiveMs(transcriptPath: string): Promise<number | undefined> {
  try {
    return (await fs.stat(transcriptPath)).mtimeMs
  } catch {
    return undefined
  }
}
