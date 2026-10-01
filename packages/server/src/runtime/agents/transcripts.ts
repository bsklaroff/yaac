import fs from 'node:fs/promises'
import path from 'node:path'
import {
  agentHistoryDir,
  claudeDir,
  codexDir,
  projectDir,
  type AgentHistoryPart,
} from '@yaac/shared/project-paths'
import { agentSessionIdSchema, type AgentTool } from '@yaac/shared/types'
import { serverLog } from '#log'
import { openSandboxDir, type SandboxFile } from './sandbox-fs'

/**
 * Where each tool's transcripts live on the host; the only place that knows
 * the per-tool layout. The agent modules read the contents, and the
 * session store records the path.
 *
 * opencode keeps history in a sqlite DB inside the workspace, so its
 * sessions have no path (the first message is fetched over HTTP instead).
 *
 * Transcripts are agent-written files in agent-writable dirs, so each is
 * read confined to its dir (`SandboxFile`), never the whole project dir.
 *
 * A transcript is either in the workspace's own history (`agentHistoryDir`),
 * where every tool writes on both drivers, or in the project's shared tool
 * home when nothing linked it into the history yet (e.g. a containerless
 * claude conversation under an unlinked cwd), until the next create moves it
 * (docs/workspace-storage.md). Readers check history first.
 */

/** Where one tool's transcripts sit: the part of a workspace's history
 *  holding them, and the shared-home subdirectory it stands in for (the one
 *  a pod's mount covers). */
const TRANSCRIPT_LAYOUT: Record<'claude' | 'codex', {
  home: (slug: string) => string
  part: AgentHistoryPart
  shared: string
}> = {
  claude: { home: claudeDir, part: 'claude', shared: 'projects' },
  codex: { home: codexDir, part: 'codex', shared: 'sessions' },
}

/** The dirs a tool's transcripts are read under for one workspace, history
 *  first, each as the dir plus the subpath holding transcripts. Empty for a
 *  tool with none on the host; pi writes only to the history. */
function transcriptRoots(slug: string, workspaceId: string, tool: AgentTool): Array<{ dir: string; sub: string }> {
  if (tool === 'opencode') return []
  if (tool === 'pi') return [{ dir: agentHistoryDir(slug, workspaceId, 'pi'), sub: '' }]
  const { home, part, shared } = TRANSCRIPT_LAYOUT[tool]
  return [{ dir: agentHistoryDir(slug, workspaceId, part), sub: '' }, { dir: home(slug), sub: shared }]
}

const under = (sub: string, rel: string): string => sub === '' ? rel : `${sub}/${rel}`

/**
 * The directory claude files a conversation under for a cwd: every
 * non-alphanumeric character replaced with `-` (`/workspace` becomes
 * `-workspace`), and past 200 characters truncated and suffixed with a hash
 * of the whole path. Matches claude 2.1.286's project-dir function (string
 * hash `(h << 5) - h + c | 0`); a test pins it.
 */
export function claudeProjectDirName(cwd: string): string {
  const munged = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  if (munged.length <= 200) return munged
  let hash = 0
  for (let i = 0; i < cwd.length; i++) hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0
  return `${munged.slice(0, 200)}-${Math.abs(hash).toString(36)}`
}

/**
 * The cwd claude runs in inside a pod, and so the directory a workspace's
 * history keeps every conversation in. Checked first, so the common case is
 * one `stat`.
 */
export const CLAUDE_POD_CWD = claudeProjectDirName('/workspace')

/** The project's shared auto-memory dir in the shared `projects/`, named as
 *  claude would for a `/repo` cwd. It is mounted (or linked) over each workspace's own
 *  `memory` folder, since claude keys memory on the checkout's git root. */
export const CLAUDE_POD_REPO = claudeProjectDirName('/repo')

/**
 * Find a claude conversation's transcript by searching, since a
 * conversation in the shared home is filed under whatever cwd claude ran in.
 * Only a fallback for when no path was recorded (e.g. the pod died before
 * the registry's first tick).
 *
 * The scan is sorted so a conversation somehow filed twice resolves to the
 * same file every time.
 */
async function findClaudeTranscript(
  slug: string,
  workspaceId: string,
  sessionId: string,
): Promise<SandboxFile | undefined> {
  // Validate the id before joining it into a path.
  if (!agentSessionIdSchema.safeParse(sessionId).success) return undefined
  const name = `${sessionId}.jsonl`
  for (const { dir, sub } of transcriptRoots(slug, workspaceId, 'claude')) {
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
 * Transcript paths are always stored and passed **relative to the project
 * directory**: in the in-pod hook's record, the `sessions-discovered` event,
 * and `agent_sessions.transcriptPath`. An absolute path would tie rows to
 * one data-dir location, silently breaking them if it moves
 * (docs/layered-server.md).
 *
 * Project-relative rather than tool-home-relative so the column needs no
 * tool to be read. Decoding still checks the path against the tool's dirs,
 * since anything in the workspace can set the pane that reports it.
 *
 * Encoding can fail (a path outside the project has no relative form), and
 * decoding can refuse.
 */

/** Whether `path.relative` produced something outside the root. */
function escapesRoot(rel: string): boolean {
  return rel === '' || rel.startsWith('..') || path.isAbsolute(rel)
}

/**
 * A transcript in stored form, or null if it has none (as when the hook
 * writes an empty record; see workspace-bin/yaac-agent-links): the
 * conversation is real but its path cannot be expressed.
 */
export function toProjectRelative(file: SandboxFile): string | null {
  const rel = path.relative(projectDir(file.slug), path.join(file.dir, file.rel))
  return escapesRoot(rel) ? null : rel
}

/**
 * The transcript a stored value names, or undefined if this install will
 * not read it. The only decoder; its caller is `recordedTranscript` in
 * `#domain/workspaces`, through which every reader of a recorded path goes.
 *
 * Values outside the tool's shared home and this workspace's history are
 * refused, since the reporting pane can be set by anything in the workspace
 * and could name `known_hosts`, `repo/.git/config` or a sibling's history.
 * Absolute values are refused and logged: only a writer bypassing the
 * encoder could store one, which is a bug.
 */
export function resolveProjectPath(
  slug: string,
  workspaceId: string,
  tool: AgentTool,
  stored: string,
): SandboxFile | undefined {
  if (path.isAbsolute(stored)) {
    serverLog(`[transcripts] refusing absolute recorded path for ${slug}: ${stored}`)
    return undefined
  }
  // `path.join` resolves embedded `..`, so a crafted value cannot escape.
  const abs = path.join(projectDir(slug), stored)
  for (const { dir } of transcriptRoots(slug, workspaceId, tool)) {
    const rel = path.relative(dir, abs)
    if (!escapesRoot(rel)) return { slug, dir, rel }
  }
  return undefined
}

/**
 * Where a reported transcript really is, in stored form, or undefined if it
 * is nowhere this workspace may read.
 *
 * The reporter uses the shared home's names (`claude/projects/…`,
 * `codex/sessions/…`), which in a pod are the workspace's history mounted
 * there. So look in history first, then the shared home, and resolve links
 * (a host workspace reaches its history through links). If nothing is there
 * yet (claude writes on its first turn), the path is left for a later pass.
 *
 * pi reports no path, so its conversation is found by id.
 *
 * A path resolving somewhere `resolveProjectPath` would refuse is dropped,
 * since on a host a link could point anywhere.
 */
export async function locateTranscript(
  slug: string,
  workspaceId: string,
  tool: AgentTool,
  agentSessionId: string,
  reported: string | undefined,
): Promise<string | undefined> {
  if (tool === 'pi') {
    const logs = await piSessionLogs(slug, workspaceId, agentSessionId)
    const newest = logs[logs.length - 1]
    return newest === undefined ? undefined : toProjectRelative(newest) ?? undefined
  }
  if (tool === 'opencode' || reported === undefined) return undefined
  const { part, shared } = TRANSCRIPT_LAYOUT[tool]
  const prefix = `${tool}/${shared}/`
  if (!reported.startsWith(prefix)) return undefined
  const rest = reported.slice(prefix.length)
  const project = projectDir(slug)
  for (const candidate of [path.join(agentHistoryDir(slug, workspaceId, part), rest), path.join(project, reported)]) {
    const real = await fs.realpath(candidate).catch(() => null)
    if (real === null) continue
    const rel = path.relative(await fs.realpath(project), real)
    if (escapesRoot(rel) || resolveProjectPath(slug, workspaceId, tool, rel) === undefined) return undefined
    return rel
  }
  return undefined
}

/**
 * pi's JSONL logs for one workspace's history, oldest first. pi names files
 * `<timestamp>_<uuid>.jsonl`, possibly under a cwd-derived subdir, so one
 * level of subdirectories is walked. The timestamp prefix makes a basename
 * sort chronological (mtime would change as pi appends).
 */
async function listPiJsonlFiles(slug: string, workspaceId: string): Promise<SandboxFile[]> {
  const found: SandboxFile[] = []
  for (const { dir, sub } of transcriptRoots(slug, workspaceId, 'pi')) {
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
 * The session id in a pi log filename, `<timestamp>_<sessionId>.jsonl` (we
 * pass the id via `--session-id`). The timestamp has no underscore, so the
 * id follows the first one. Undefined without that separator.
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
  workspaceId: string,
  agentSessionId: string,
): Promise<SandboxFile[]> {
  const files = await listPiJsonlFiles(slug, workspaceId)
  return files.filter((f) => sessionIdFromPiLog(f.rel) === agentSessionId)
}

/**
 * The transcript of a workspace conversation (by default the one pinned to
 * the workspace id) found without a recorded path, or undefined if the tool
 * leaves none (opencode) or has not written one. claude's is named for the
 * conversation; pi's newest log wins. codex is not supported: its rollout
 * filename is not derivable from any id, so only a recorded path finds it.
 */
export async function sessionTranscriptPath(
  projectSlug: string,
  workspaceId: string,
  tool: AgentTool,
  agentSessionId = workspaceId,
): Promise<SandboxFile | undefined> {
  if (tool === 'opencode' || tool === 'codex') return undefined
  if (tool === 'pi') {
    const logs = await piSessionLogs(projectSlug, workspaceId, agentSessionId)
    return logs[logs.length - 1]
  }
  return findClaudeTranscript(projectSlug, workspaceId, agentSessionId)
}

/** When the agent last appended to a transcript (or conversation record),
 *  or undefined if it is gone. */
export async function transcriptLastActiveMs(file: SandboxFile): Promise<number | undefined> {
  const root = await openSandboxDir(file.slug, file.dir).catch(() => null)
  const st = await root?.stat(file.rel)
  return st?.isFile() ? st.mtimeMs : undefined
}
