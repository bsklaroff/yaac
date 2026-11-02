import { getConversationTitle, sessionTranscriptPath } from '#runtime/agents'
import type { SandboxFile } from '#runtime/agents'
import { normalizeTitle } from '@yaac/shared/titles'
import type { AgentTool } from '@yaac/shared/types'

/**
 * Conversation titles as each agent writes them for itself
 * (`getConversationTitle`). A workspace the user has not renamed is labelled
 * with its opening conversation's title (`conversationTitle` in `#db`), so
 * the label follows the agent's: generated after the first turn, and
 * replaced by a rename made inside the tool.
 *
 * A title can land at any turn, so a live conversation is read again every
 * `RECHECK_MS` while it is active (its transcript or ACP record changed
 * since the last read), and every `IDLE_RECHECK_MS` otherwise, since codex
 * names a thread a few seconds after its turn's last write. opencode's
 * lookup starts a server in the workspace, so it stops once the session is
 * titled (opencode titles a session once, and the row's title counts, so a
 * server restart does not look again), and an untitled session is looked
 * up at intervals doubling from `OPENCODE_RECHECK_MS` to
 * `OPENCODE_MAX_RECHECK_MS`, since one nobody prompts never gets a title.
 */
const RECHECK_MS = 30_000
const IDLE_RECHECK_MS = 5 * 60_000
const OPENCODE_RECHECK_MS = 2 * 60_000
const OPENCODE_MAX_RECHECK_MS = 30 * 60_000

interface Read {
  title?: string
  atMs: number
  activityMs?: number
  /** How long an untitled opencode session waits for its next lookup. */
  waitMs: number
}

/** The last read of each conversation, for this server's life. */
const reads = new Map<string, Read>()

/**
 * A live conversation's own title, or undefined while it has none.
 * `recorded` is the title its row holds. A read that finds nothing keeps
 * the last title found, so a title that scrolls out of the part of a file
 * that is read is not lost.
 */
export async function captureTitle(
  projectId: string,
  workspaceId: string,
  tool: AgentTool,
  conversationId: string,
  transcript: SandboxFile | undefined,
  jobName: string,
  activityMs: number | undefined,
  recorded: string | undefined,
): Promise<string | undefined> {
  const key = `${projectId}/${tool}/${conversationId}`
  const last = reads.get(key)
  const known = last?.title ?? recorded
  const now = Date.now()
  if (tool === 'opencode' && known !== undefined) return known
  if (last !== undefined) {
    const since = now - last.atMs
    const idle = activityMs === undefined || activityMs === last.activityMs
    const wait = tool === 'opencode' ? last.waitMs : idle ? IDLE_RECHECK_MS : RECHECK_MS
    if (since < wait) return known
  }
  // An acp conversation has no recorded transcript, but claude's is named
  // for it.
  const file = transcript
    ?? (tool === 'claude' ? await sessionTranscriptPath(projectId, workspaceId, tool, conversationId) : undefined)
  const found = await getConversationTitle(tool, {
    projectId,
    conversationId,
    jobName,
    ...(file !== undefined ? { transcript: file } : {}),
  }).catch(() => undefined)
  const title = (found !== undefined ? normalizeTitle(found) : '') || known
  reads.set(key, {
    atMs: now,
    waitMs: last === undefined ? OPENCODE_RECHECK_MS : Math.min(last.waitMs * 2, OPENCODE_MAX_RECHECK_MS),
    ...(title !== undefined ? { title } : {}),
    ...(activityMs !== undefined ? { activityMs } : {}),
  })
  return title
}

/** Test helper: forget every read. */
export function _resetTitleCaptureForTests(): void {
  reads.clear()
}
