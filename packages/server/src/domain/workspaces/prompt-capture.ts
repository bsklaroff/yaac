import { getConversationFirstMessage } from '#runtime/agents'
import type { SandboxFile } from '#runtime/agents'
import { MAX_PROMPT_LENGTH } from '@yaac/shared/types'
import type { AgentTool } from '@yaac/shared/types'

/**
 * First messages already read, per conversation, for this server's life. A
 * conversation's first message is read once from its transcript and then
 * re-reported from here on each sweep; the row write only fills an empty
 * column, so repeats are free and a silently failed write is retried.
 * Unprompted conversations are not cached, so the next pass tries again.
 */
const known = new Map<string, string>()

export async function captureFirstPrompt(
  projectId: string,
  tool: AgentTool,
  conversationId: string,
  transcript: SandboxFile | undefined,
): Promise<string | undefined> {
  const key = `${projectId}/${tool}/${conversationId}`
  const cached = known.get(key)
  if (cached !== undefined) return cached
  const prompt = await getConversationFirstMessage(tool, transcript).catch(() => undefined)
  if (prompt === undefined) return undefined
  // Cap to the recorded length so the cache and the row agree.
  const capped = prompt.slice(0, MAX_PROMPT_LENGTH)
  known.set(key, capped)
  return capped
}

/** Test helper: forget the messages read so far. */
export function _resetPromptCaptureForTests(): void {
  known.clear()
}
