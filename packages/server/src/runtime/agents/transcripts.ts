import fs from 'node:fs/promises'
import path from 'node:path'
import {
  agentHistoryDir,
  claudeDir,
  codexDir,
  piDir,
  projectDir,
  type AgentHistoryPart,
} from '@yaac/shared/project-paths'
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
 * Every transcript is a file the agent wrote, in a dir it can write, so each
 * is read under that dir (`SandboxFile`) — never the project dir, which also
 * holds `known_hosts`, the checkout and every other worktree's files.
 *
 * A transcript lives in one of two places. Its worktree's own history
 * (`agentHistoryDir`) is where every tool writes today, on either driver. The
 * project's shared tool home is where a conversation lands when nothing
 * reaches the history for it yet — a containerless conversation claude filed
 * under a cwd not linked in, a codex rollout written on a host — until the
 * worktree's next create moves it in (docs/worktree-storage.md). Readers look
 * in that order, so they work whoever wrote the file.
 */

/** Where one tool's transcripts sit, in both places: the part of a worktree's
 *  history holding them, and the subdirectory of the shared home that part
 *  stands in for (the one a pod's mount covers). */
const TRANSCRIPT_LAYOUT: Record<Exclude<AgentTool, 'opencode'>, {
  home: (slug: string) => string
  part: AgentHistoryPart
  shared: string
}> = {
  claude: { home: claudeDir, part: 'claude', shared: 'projects' },
  codex: { home: codexDir, part: 'codex', shared: 'sessions' },
  pi: { home: piDir, part: 'pi', shared: 'agent/sessions' },
}

/** The dirs a tool's transcripts are read under for one worktree, the
 *  worktree's own history first: each as the dir, and the path below it that
 *  holds the transcripts. Empty for a tool that keeps none on the host. */
function transcriptRoots(slug: string, worktreeId: string, tool: AgentTool): Array<{ dir: string; sub: string }> {
  if (tool === 'opencode') return []
  const { home, part, shared } = TRANSCRIPT_LAYOUT[tool]
  return [{ dir: agentHistoryDir(slug, worktreeId, part), sub: '' }, { dir: home(slug), sub: shared }]
}

const under = (sub: string, rel: string): string => sub === '' ? rel : `${sub}/${rel}`

/**
 * The directory claude files a conversation under for a cwd: the path with
 * every non-alphanumeric character punched out (`/workspace` becomes
 * `-workspace`), and past 200 characters cut there and suffixed with a hash
 * of the whole path. Verified against claude 2.1.282's own function (`cx`,
 * with the `(h << 5) - h + c | 0` string hash); a test pins it.
 */
export function claudeProjectDirName(cwd: string): string {
  const munged = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  if (munged.length <= 200) return munged
  let hash = 0
  for (let i = 0; i < cwd.length; i++) hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0
  return `${munged.slice(0, 200)}-${Math.abs(hash).toString(36)}`
}

/**
 * The cwd a pod runs claude in, so the only directory a pod files a
 * conversation under — and the one a worktree's history keeps every
 * conversation in, whichever driver wrote it. Checking it first keeps the
 * common case a single `stat`.
 */
export const CLAUDE_POD_CWD = claudeProjectDirName('/workspace')

/** Where a project's shared auto-memory lives in the shared `projects/`:
 *  named for the `/repo` claude once keyed it on, and mounted (or linked)
 *  over each worktree's own `memory` folder, since claude keys memory on the
 *  checkout's git root, which is now the checkout itself. */
export const CLAUDE_POD_REPO = claudeProjectDirName('/repo')

/**
 * A claude conversation's transcript, by searching rather than by assuming
 * one cwd: a conversation written into the shared home is filed under
 * whatever cwd claude ran in, and the file is named for the conversation
 * either way.
 *
 * Only reached when nothing recorded a path — the hook stamps one for every
 * conversation it sees, so this is the fallback for a worktree whose pod died
 * before the registry's first tick.
 *
 * A conversation id identifies one conversation, so at most one directory
 * should hold it; the scan is sorted anyway, so a session somehow filed twice
 * resolves to the same file on every call rather than to whatever the
 * filesystem happened to enumerate first. An arbitrary-but-stable answer is
 * worth more here than a fresh coin flip per read, since this one feeds a
 * rendered transcript.
 */
async function findClaudeTranscript(
  slug: string,
  worktreeId: string,
  sessionId: string,
): Promise<SandboxFile | undefined> {
  // The id names a file, so it is held to the one shape an id may take
  // before it is joined into a path.
  if (!agentSessionIdSchema.safeParse(sessionId).success) return undefined
  const name = `${sessionId}.jsonl`
  for (const { dir, sub } of transcriptRoots(slug, worktreeId, 'claude')) {
    const home = await openSandboxDir(slug, dir).catch(() => null)
    if (home === null) continue
    const found = async (cwd: string): Promise<SandboxFile | undefined> => {
      const rel = under(sub, `${cwd}/${name}`)
      return (await home.stat(rel))?.isFile() ? { slug, dir, rel } : undefined
    }
    const conventional = await found(CLAUDE_POD_CWD)
    if (conventional) return conventional
    const entries = await home.readdir(sub)
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = await found(entry.name)
      if (candidate) return candidate
    }
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
 * tool to be read. Decoding still checks it against the recording tool's
 * dirs, because the pane reports the path and anything in the workspace can
 * set the pane.
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
 * A value that is under neither the recording tool's shared home nor its part
 * of THIS worktree's history is refused: the pane that reported it can be set
 * by anything in the workspace, and a path naming `known_hosts`,
 * `repo/.git/config` or a sibling's history is not this conversation's
 * transcript. An absolute value is refused too — the column holds
 * project-relative values only, so only a writer that bypassed the encoder
 * can put one there, and that is logged: it names a bug rather than a state,
 * since every caller degrades silently (no prompt, no last-activity).
 */
export function resolveProjectPath(
  slug: string,
  worktreeId: string,
  tool: AgentTool,
  stored: string,
): SandboxFile | undefined {
  if (path.isAbsolute(stored)) {
    serverLog(`[transcripts] refusing absolute recorded path for ${slug}: ${stored}`)
    return undefined
  }
  // `path.join` resolves embedded `..`, so a stored value the encoder could
  // never emit cannot walk out of a dir here.
  const abs = path.join(projectDir(slug), stored)
  for (const { dir } of transcriptRoots(slug, worktreeId, tool)) {
    const rel = path.relative(dir, abs)
    if (!escapesRoot(rel)) return { slug, dir, rel }
  }
  return undefined
}

/**
 * Where a transcript the workspace reported really is, in the column's form,
 * or undefined when it is nowhere this worktree may read it from.
 *
 * The reporter speaks the layout the tool sees — `claude/projects/…` and
 * `codex/sessions/…`, the shared home's names — and in a pod those name the
 * worktree's history, mounted there. So the path is looked for in the
 * history first and the shared home second, and then resolved: a host
 * worktree reaches its history through links in the shared home, and the row
 * names the file the link leads to. Nothing there yet (claude writes on its
 * first turn) leaves the path out, for the next pass to fill.
 *
 * pi's reporter names no path — its logs sit outside the home it reports
 * against — so a pi conversation is found by its id, which names the file.
 *
 * A path landing anywhere `resolveProjectPath` would refuse — outside the
 * project, in a sibling's history — is dropped: on a host a link could point
 * anywhere.
 */
export async function locateTranscript(
  slug: string,
  worktreeId: string,
  tool: AgentTool,
  agentSessionId: string,
  reported: string | undefined,
): Promise<string | undefined> {
  if (tool === 'pi') {
    const logs = await piSessionLogs(slug, worktreeId, agentSessionId)
    const newest = logs[logs.length - 1]
    return newest === undefined ? undefined : toProjectRelative(newest) ?? undefined
  }
  if (tool === 'opencode' || reported === undefined) return undefined
  const { part, shared } = TRANSCRIPT_LAYOUT[tool]
  const prefix = `${tool}/${shared}/`
  if (!reported.startsWith(prefix)) return undefined
  const rest = reported.slice(prefix.length)
  const project = projectDir(slug)
  for (const candidate of [path.join(agentHistoryDir(slug, worktreeId, part), rest), path.join(project, reported)]) {
    const real = await fs.realpath(candidate).catch(() => null)
    if (real === null) continue
    const rel = path.relative(await fs.realpath(project), real)
    if (escapesRoot(rel) || resolveProjectPath(slug, worktreeId, tool, rel) === undefined) return undefined
    return rel
  }
  return undefined
}

/**
 * pi's JSONL logs for one worktree, sorted chronologically: its history's,
 * then any the shared home still holds. pi names files
 * `<timestamp>_<uuid>.jsonl` and may nest them under a cwd-derived subdir, so
 * walk one level of subdirectories too. The timestamp prefix sorts
 * chronologically, so a lexical basename sort matches session order (mtime
 * would drift as pi appends).
 */
async function listPiJsonlFiles(slug: string, worktreeId: string): Promise<SandboxFile[]> {
  const found: SandboxFile[] = []
  for (const { dir, sub } of transcriptRoots(slug, worktreeId, 'pi')) {
    const home = await openSandboxDir(slug, dir).catch(() => null)
    if (home === null) continue
    const walk = async (rel: string, depth: number): Promise<void> => {
      for (const e of await home.readdir(rel)) {
        const child = under(rel, e.name)
        if (e.isFile() && e.name.endsWith('.jsonl')) found.push({ slug, dir, rel: child })
        else if (e.isDirectory() && depth > 0) await walk(child, depth - 1)
      }
    }
    await walk(sub, 1)
  }
  return found.sort((a, b) => path.basename(a.rel).localeCompare(path.basename(b.rel)))
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

/** A conversation's pi logs (oldest first), matched by id. */
export async function piSessionLogs(
  slug: string,
  worktreeId: string,
  agentSessionId: string,
): Promise<SandboxFile[]> {
  const files = await listPiJsonlFiles(slug, worktreeId)
  return files.filter((f) => sessionIdFromPiLog(f.rel) === agentSessionId)
}

/**
 * The transcript of one of a worktree's conversations — by default the one
 * pinned to the worktree id — found without a recorded path, or undefined
 * when the tool leaves none (opencode) or hasn't written one yet. claude's is
 * named for the conversation. codex is absent: its rollout filename is not
 * derivable from any id, so only the recorded path finds it. pi picks its own
 * filename, so its newest log wins.
 */
export async function sessionTranscriptPath(
  projectSlug: string,
  worktreeId: string,
  tool: AgentTool,
  agentSessionId = worktreeId,
): Promise<SandboxFile | undefined> {
  // codex is absent on purpose: it names its rollout files unpredictably, so
  // nothing derives one from a session id; the DB carries the path instead,
  // and a codex conversation the DB does not know is simply unresolvable.
  if (tool === 'opencode' || tool === 'codex') return undefined
  if (tool === 'pi') {
    const logs = await piSessionLogs(projectSlug, worktreeId, agentSessionId)
    return logs[logs.length - 1]
  }
  return findClaudeTranscript(projectSlug, worktreeId, agentSessionId)
}

/** Last time the agent appended to a transcript (or a conversation record),
 *  or undefined if it's gone. */
export async function transcriptLastActiveMs(file: SandboxFile): Promise<number | undefined> {
  const root = await openSandboxDir(file.slug, file.dir).catch(() => null)
  const st = await root?.stat(file.rel)
  return st?.isFile() ? st.mtimeMs : undefined
}
