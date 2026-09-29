import path from 'node:path'
import { claudeDir, codexDir, piDir, projectDir } from '@yaac/shared/project-paths'
import { agentSessionIdSchema, type AgentTool } from '@yaac/shared/types'
import { serverLog } from '#log'
import { openSandboxDir, type SandboxFile } from './sandbox-fs'

/**
 * Where each tool's session transcript lives on the host — the one place
 * that knows the per-tool file layout. The agent modules read what's *in*
 * these files; the session store records the path so nothing else has to
 * derive it, and the deleted-session listing stats it for last-activity.
 *
 * opencode is the odd one out: it keeps its history in a per-session sqlite
 * DB inside the container and leaves no host transcript, so its sessions
 * simply carry no path (their first message is captured over HTTP instead).
 *
 * Every transcript is a file the agent wrote, in a home it can write, so each
 * is read under that tool's own home (`SandboxFile`) — never the project dir,
 * which also holds `known_hosts`, the checkout and every other worktree's
 * files.
 */

/** The tool home a tool's transcripts live in, or undefined for one that
 *  keeps none on the host. */
function transcriptHome(slug: string, tool: AgentTool): string | undefined {
  switch (tool) {
    case 'claude': return claudeDir(slug)
    case 'codex': return codexDir(slug)
    case 'pi': return piDir(slug)
    case 'opencode': return undefined
  }
}

/** Where claude files a conversation, under its home: one directory per cwd
 *  it has been run in, named for that path with the separators punched out
 *  (`/workspace` becomes `-workspace`). */
const CLAUDE_PROJECTS = 'projects'

/**
 * Under the pod driver the agent's cwd is always `/workspace`, so this is the
 * only directory that can hold a conversation — and checking it first keeps
 * the common case a single `stat`.
 */
const CLAUDE_POD_CWD = '-workspace'

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
async function findClaudeTranscript(slug: string, sessionId: string): Promise<SandboxFile | undefined> {
  // The id names a file, so it is held to the one shape an id may take
  // before it is joined into a path.
  if (!agentSessionIdSchema.safeParse(sessionId).success) return undefined
  const dir = claudeDir(slug)
  const home = await openSandboxDir(slug, dir).catch(() => null)
  if (home === null) return undefined
  const name = `${sessionId}.jsonl`
  const found = async (cwd: string): Promise<SandboxFile | undefined> => {
    const rel = `${CLAUDE_PROJECTS}/${cwd}/${name}`
    return (await home.stat(rel))?.isFile() ? { slug, dir, rel } : undefined
  }
  const conventional = await found(CLAUDE_POD_CWD)
  if (conventional) return conventional
  const entries = await home.readdir(CLAUDE_PROJECTS)
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = await found(entry.name)
    if (candidate) return candidate
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
 * Project-relative rather than tool-home-relative so the column needs no
 * tool to be read: every tool home is `<projectDir>/<tool>`, so the tool
 * segment is simply the first component. Decoding still checks it against
 * the recording tool's home, because the pane reports the path and anything
 * in the workspace can set the pane.
 *
 * The pair is asymmetric on purpose: encoding can fail — a transcript outside
 * the project directory has no relative form — and decoding can refuse.
 */

/** `path.relative` produced something that isn't *inside* the root. */
function escapesRoot(rel: string): boolean {
  return rel === '' || rel.startsWith('..') || path.isAbsolute(rel)
}

/**
 * A transcript in the form everything stores, or null when it has none. Null
 * is the same verdict the workspace-side hook reaches when it writes an empty
 * record (see worktree-bin/yaac-agent-links): the conversation is real, only
 * its path is unexpressible.
 */
export function toProjectRelative(file: SandboxFile): string | null {
  const rel = path.relative(projectDir(file.slug), path.join(file.dir, file.rel))
  return escapesRoot(rel) ? null : rel
}

/**
 * The transcript a stored value names, or undefined when it names none this
 * install will read.
 *
 * The only place the relative form is turned back into a file, which is why
 * its one caller is worth naming: `recordedTranscript` in `#domain/worktrees`,
 * the door every reader of a *recorded* path comes through (the stopped
 * listing's last-activity stat and the detail route's founding-ask parse both
 * arrive that way).
 *
 * A value that is not under the recording tool's own home is refused: the
 * pane that reported it can be set by anything in the workspace, and a path
 * naming `known_hosts`, `repo/.git/config` or another worktree's files is not
 * a transcript. An absolute value is refused too — the column holds
 * project-relative values only, so only a writer that bypassed the encoder
 * can put one there, and that is logged: it names a bug rather than a state,
 * since every caller degrades silently (no prompt, no last-activity).
 */
export function resolveProjectPath(slug: string, tool: AgentTool, stored: string): SandboxFile | undefined {
  if (path.isAbsolute(stored)) {
    serverLog(`[transcripts] refusing absolute recorded path for ${slug}: ${stored}`)
    return undefined
  }
  const dir = transcriptHome(slug, tool)
  if (dir === undefined) return undefined
  // `path.join` resolves embedded `..`, so a stored value the encoder could
  // never emit cannot walk out of the home here.
  const rel = path.relative(dir, path.join(projectDir(slug), stored))
  return escapesRoot(rel) ? undefined : { slug, dir, rel }
}

/** Where pi keeps its session logs, under its home. */
const PI_SESSIONS = 'agent/sessions'

/**
 * pi's JSONL logs under `slug`'s shared pi home, sorted chronologically. pi
 * names files `<timestamp>_<uuid>.jsonl` and may nest them under a
 * cwd-derived subdir, so walk one level of subdirectories too. The timestamp
 * prefix sorts chronologically, so a lexical basename sort matches session
 * order (mtime would drift as pi appends).
 */
async function listPiJsonlFiles(slug: string): Promise<SandboxFile[]> {
  const dir = piDir(slug)
  const home = await openSandboxDir(slug, dir).catch(() => null)
  if (home === null) return []
  const found: SandboxFile[] = []
  const walk = async (rel: string, depth: number): Promise<void> => {
    for (const e of await home.readdir(rel)) {
      const child = `${rel}/${e.name}`
      if (e.isFile() && e.name.endsWith('.jsonl')) found.push({ slug, dir, rel: child })
      else if (e.isDirectory() && depth > 0) await walk(child, depth - 1)
    }
  }
  await walk(PI_SESSIONS, 1)
  return found.sort((a, b) => path.basename(a.rel).localeCompare(path.basename(b.rel)))
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
export async function piSessionLogs(projectSlug: string, worktreeId: string): Promise<SandboxFile[]> {
  const files = await listPiJsonlFiles(projectSlug)
  return files.filter((f) => sessionIdFromPiLog(f.rel) === worktreeId)
}

/**
 * The transcript to record for a session, or undefined when the tool leaves
 * none (opencode) or hasn't written one yet. claude has a deterministic path
 * keyed by the session id. codex is absent: its rollout filename is not
 * derivable from any id, so only the recorded path finds it. pi picks its own
 * filename, so its newest log wins.
 */
export async function sessionTranscriptPath(
  projectSlug: string,
  worktreeId: string,
  tool: AgentTool,
): Promise<SandboxFile | undefined> {
  // codex is absent on purpose: it names its rollout files unpredictably, so
  // nothing derives one from a session id; the DB carries the path instead,
  // and a codex conversation the DB does not know is simply unresolvable.
  if (tool === 'opencode' || tool === 'codex') return undefined
  if (tool === 'pi') {
    const logs = await piSessionLogs(projectSlug, worktreeId)
    return logs[logs.length - 1]
  }
  return findClaudeTranscript(projectSlug, worktreeId)
}

/** Last time the agent appended to a transcript (or a conversation record),
 *  or undefined if it's gone. */
export async function transcriptLastActiveMs(file: SandboxFile): Promise<number | undefined> {
  const root = await openSandboxDir(file.slug, file.dir).catch(() => null)
  const st = await root?.stat(file.rel)
  return st?.isFile() ? st.mtimeMs : undefined
}
