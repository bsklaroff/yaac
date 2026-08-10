import { getAgentSessionFirstMessage } from '#runtime/agents'
import { MAX_PROMPT_LENGTH } from '@yaac/shared/types'
import type { AgentTool } from '@yaac/shared/types'

/**
 * A conversation's opening message, read from the transcript its link
 * resolved (or, for opencode, probed out of the pod — it leaves no host
 * transcript).
 *
 * Read once per conversation, which is what keeps every display path reading
 * prompts from the server's record instead of re-parsing a transcript on
 * every tick. Once per conversation *per server life*, gated on an
 * in-memory set rather than a row query: a restart re-reads each
 * conversation once and the fill-only write makes that a no-op. That is a
 * strictly better trade than the alternative, which is deriving a work
 * list from the rows on every pass.
 *
 * What is cached is the MESSAGE, not the fact of having read it, and the
 * difference matters: the row write can fail without saying so (the store
 * swallows its own errors so a lost prompt never blocks a teardown), so every
 * later sweep re-reports the cached message and the fill-only write makes the
 * retry free. Caching "already read" instead would drop the message on the
 * floor until the next server restart, since the sweep would go on reporting
 * that conversation with no prompt and `coalesce` can never fill a column
 * from a value that is not sent.
 *
 * There is no separate worktree-level capture: a worktree's founding ask *is*
 * its first conversation's opening message. That is what makes it survive a
 * `/clear` — the new conversation is a second row, so the first one's message
 * stays the worktree's label.
 *
 * A conversation whose agent has not been prompted yet reads as `undefined`
 * and is not marked read, so the next pass tries again.
 */
const known = new Map<string, string>()

export async function captureFirstPrompt(
  projectSlug: string,
  tool: AgentTool,
  agentSessionId: string,
  transcriptPath: string | undefined,
  jobName: string | undefined,
): Promise<string | undefined> {
  const key = `${projectSlug}/${tool}/${agentSessionId}`
  const cached = known.get(key)
  if (cached !== undefined) return cached
  const prompt = await getAgentSessionFirstMessage(tool, transcriptPath, jobName)
    .catch(() => undefined)
  if (prompt === undefined) return undefined
  // Stored at the length it will be recorded at, so the copy re-reported on
  // later sweeps and the copy the server kept cannot differ.
  const capped = prompt.slice(0, MAX_PROMPT_LENGTH)
  known.set(key, capped)
  return capped
}

/** Test helper: forget the messages read so far. */
export function _resetPromptCaptureForTests(): void {
  known.clear()
}
