import fs from 'node:fs/promises'
import path from 'node:path'
import { toolHomeDir, worktreeLinksDir } from '@yaac/shared/project-paths'

/**
 * Host-side reader for the link tree the in-pod SessionStart hook maintains
 * (`/etc/yaac/agent-links.sh`, see dockerfiles/Dockerfile.tools). This is the
 * only thing that knows the tree's layout; the registry reconciler turns what
 * it returns into `agent_sessions` + `worktree_agent_sessions` rows.
 *
 * Every entry the current hook writes is a plain file, never a symlink.
 * `sessions/<agentSessionId>` holds its transcript's path *relative to the tool
 * home*, because the hook only ever sees the in-pod path
 * (`/home/yaac/.claude/…`) while this reads the same tree through the host
 * mount, where that prefix does not exist. Joining the host-side home back on
 * is the whole translation.
 *
 * The reader also understands the tree an earlier hook wrote, where each entry
 * was a symlink named `<agentSessionId>.jsonl` pointing at the transcript.
 * Those trees are on disk for every worktree that ever ran before the upgrade,
 * and a pod started from an older image keeps writing them until it is
 * restarted — so this is a reader branch rather than a one-shot startup
 * rewrite. Read as a record file, a symlink would name a phantom conversation
 * (`<id>.jsonl`), hide the real one, and slurp a whole transcript into memory
 * on every reconcile tick.
 *
 * The tree is deliberately readable without the pod: `sessions/` outlives the
 * container, so a stopped worktree can still list every conversation it hosted.
 * `panes/` is per-life state — session create wipes it before the pod starts,
 * so a pointer here always refers to the *current* life's pane. It still needs
 * cross-checking against the live pane set before it can mean "active": a pane
 * that exited leaves its pointer behind.
 */

/** Tools with a host-mounted home the hook can write into. opencode keeps its
 *  history in a per-session sqlite DB inside the container, so it has no link
 *  tree — its conversations are enumerated over HTTP while the pod runs. */
export type LinkableTool = 'claude' | 'codex' | 'pi'

const LINKABLE_TOOLS: LinkableTool[] = ['claude', 'codex', 'pi']

export interface AgentSessionLink {
  agentSessionId: string
  tool: LinkableTool
  /** Host path of the transcript, absent when the recorded file is gone. */
  transcriptPath?: string
  /**
   * Every tmux pane whose pointer names this conversation, ascending. Usually
   * one, but never assume it: a pane that exited leaves its pointer behind
   * until the pod's next start, and `claude --resume <id>` in a second window
   * genuinely puts one conversation on two panes at once. Which of these are
   * real is decided against the live pane list, not here.
   */
  paneIds: string[]
  /** Record birth time — the order conversations appeared in this worktree. */
  firstSeenMs: number
  /** Transcript mtime; the last-activity signal for a stopped worktree. */
  lastActiveMs?: number
}

/**
 * Agent session id → the panes pointing at it, from the worktree's `panes/`
 * dir. The pointers are written pane-keyed (one pane runs one conversation);
 * this inverts them, which is many-to-one in general — see `paneIds`.
 */
async function readPanePointers(dir: string): Promise<Map<string, string[]>> {
  const byAgentSession = new Map<string, string[]>()
  let entries: string[]
  try {
    entries = await fs.readdir(path.join(dir, 'panes'))
  } catch {
    return byAgentSession
  }
  // Ascending by pane number so the mapping is stable across ticks; readdir
  // order is not, and pane ids are numeric (`%0`, `%7`, `%12`).
  const byPane = await Promise.all(entries.map(async (name) => {
    try {
      const sid = (await fs.readFile(path.join(dir, 'panes', name), 'utf8')).trim()
      return sid === '' ? undefined : { pane: Number(name), sid }
    } catch {
      // raced with a rewrite — the next tick sees it
      return undefined
    }
  }))
  for (const entry of byPane
    .filter((e): e is { pane: number; sid: string } => e !== undefined && Number.isFinite(e.pane))
    .sort((a, b) => a.pane - b.pane)) {
    // The hook strips the leading '%' so the pointer is a plain filename; put
    // it back, since everything downstream speaks tmux pane ids.
    byAgentSession.set(entry.sid, [...(byAgentSession.get(entry.sid) ?? []), `%${entry.pane}`])
  }
  return byAgentSession
}

/** What the pre-record hook suffixed its symlinks with; the conversation id is
 *  the entry name without it. */
const LEGACY_RECORD_SUFFIX = '.jsonl'

/** One `sessions/` entry, in either format: which conversation it names, when
 *  the record itself was written, and where it says the transcript is. */
interface SessionRecord {
  agentSessionId: string
  firstSeenMs: number
  transcriptPath?: string
}

async function readSessionRecord(
  sessionsDir: string,
  name: string,
  home: string,
): Promise<SessionRecord | undefined> {
  const recordPath = path.join(sessionsDir, name)
  let entry
  try {
    // lstat, not stat: this both tells the two formats apart and takes the
    // record's *own* birth time, which orders the history. A legacy entry
    // followed to its target would report the transcript's instead — older
    // than the worktree that adopted it, for a resumed conversation.
    entry = await fs.lstat(recordPath)
  } catch {
    return undefined
  }
  const firstSeenMs = entry.birthtimeMs
  if (entry.isSymbolicLink()) {
    const agentSessionId = name.endsWith(LEGACY_RECORD_SUFFIX)
      ? name.slice(0, -LEGACY_RECORD_SUFFIX.length)
      : name
    // The link's target is relative to `sessions/`, and both ends sit under
    // the same host-mounted home, so it resolves here as it did in the pod.
    const transcriptPath = await fs.realpath(recordPath).catch(() => undefined)
    return { agentSessionId, firstSeenMs, ...(transcriptPath !== undefined ? { transcriptPath } : {}) }
  }
  let recorded: string
  try {
    recorded = (await fs.readFile(recordPath, 'utf8')).trim()
  } catch {
    return undefined
  }
  return {
    agentSessionId: name,
    firstSeenMs,
    ...(recorded !== '' ? { transcriptPath: path.join(home, recorded) } : {}),
  }
}

/**
 * Every agent session one tool's hook has linked to a worktree, oldest first.
 * Returns empty for a worktree whose pod predates the hook (or whose tool has
 * no link tree) — callers treat that as "one conversation, id = worktree id".
 */
export async function readWorktreeLinks(
  projectSlug: string,
  tool: LinkableTool,
  worktreeId: string,
): Promise<AgentSessionLink[]> {
  const dir = worktreeLinksDir(projectSlug, tool, worktreeId)
  const sessionsDir = path.join(dir, 'sessions')
  let names: string[]
  try {
    names = await fs.readdir(sessionsDir)
  } catch {
    return []
  }
  const panes = await readPanePointers(dir)
  const home = toolHomeDir(projectSlug, tool)

  const records = (await Promise.all(
    names.map((name) => readSessionRecord(sessionsDir, name, home)),
  )).filter((r): r is SessionRecord => r !== undefined)

  // A pod upgraded mid-life leaves both formats naming the same conversation,
  // so collapse by id: the legacy entry is the older sighting and the record
  // file is the newer, and either may be the one that knows the path.
  const byId = new Map<string, AgentSessionLink>()
  for (const record of records.sort((a, b) => a.firstSeenMs - b.firstSeenMs)) {
    let lastActiveMs: number | undefined
    let transcriptPath: string | undefined
    if (record.transcriptPath !== undefined) {
      try {
        lastActiveMs = (await fs.stat(record.transcriptPath)).mtimeMs
        transcriptPath = record.transcriptPath
      } catch {
        // The conversation is still real; its transcript is gone (or not
        // written yet), so it simply has no path to record.
      }
    }
    const existing = byId.get(record.agentSessionId)
    if (existing !== undefined) {
      if (existing.transcriptPath === undefined && transcriptPath !== undefined) {
        existing.transcriptPath = transcriptPath
        if (lastActiveMs !== undefined) existing.lastActiveMs = lastActiveMs
      }
      continue
    }
    byId.set(record.agentSessionId, {
      agentSessionId: record.agentSessionId,
      tool,
      firstSeenMs: record.firstSeenMs,
      paneIds: panes.get(record.agentSessionId) ?? [],
      ...(transcriptPath !== undefined ? { transcriptPath } : {}),
      ...(lastActiveMs !== undefined ? { lastActiveMs } : {}),
    })
  }

  return [...byId.values()].sort((a, b) => a.firstSeenMs - b.firstSeenMs)
}

/**
 * The worktree's links across every linkable tool, oldest first. Scanning all
 * three rather than just the worktree's recorded tool is deliberate: nothing
 * stops a user opening `codex` in a scratch window of a claude worktree, and
 * the tool a conversation belongs to is exactly which home its link lives in.
 */
export async function readAllWorktreeLinks(
  projectSlug: string,
  worktreeId: string,
): Promise<AgentSessionLink[]> {
  const perTool = await Promise.all(
    LINKABLE_TOOLS.map((tool) => readWorktreeLinks(projectSlug, tool, worktreeId)),
  )
  return perTool.flat().sort((a, b) => a.firstSeenMs - b.firstSeenMs)
}

/**
 * Drop the worktree's pane pointers. Called before a pod starts (create and
 * restart alike) so the previous life's pointers can't be mistaken for this
 * one's — the `sessions/` history is deliberately left alone.
 */
export async function clearPanePointers(
  projectSlug: string,
  worktreeId: string,
): Promise<void> {
  await Promise.all(LINKABLE_TOOLS.map(async (tool) => {
    try {
      const panes = path.join(worktreeLinksDir(projectSlug, tool, worktreeId), 'panes')
      await fs.rm(panes, { recursive: true, force: true })
    } catch {
      // Best-effort: a worktree that never linked anything has no dir, and a
      // failure costs at most one stale pointer the live-pane check discards
      // anyway. Never worth failing a create over.
    }
  }))
}
