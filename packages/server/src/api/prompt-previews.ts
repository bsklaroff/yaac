import {
  CONVERSATION_PROMPT_PREVIEW_LENGTH,
  PROMPT_PREVIEW_LENGTH,
  type AgentSessionEntry,
} from '@yaac/shared/types'

/**
 * Prompts cut short for the reads that carry many rows at once: the
 * `/events` snapshot and the stopped list. A prompt can run to
 * `MAX_PROMPT_LENGTH`, and those reads only display and search it.
 */

/** `entry` with its prompt cut to `max` characters, never ending in half a
 *  surrogate pair. */
export function previewed<T extends { prompt?: string }>(entry: T, max = PROMPT_PREVIEW_LENGTH): T {
  const { prompt } = entry
  if (prompt === undefined || prompt.length <= max) return entry
  return { ...entry, prompt: prompt.slice(0, max).replace(/[\uD800-\uDBFF]$/, '') }
}

/** `previewed`, with its conversations' first prompts cut further. */
export function withPreviews<T extends { prompt?: string; agentSessions: AgentSessionEntry[] }>(entry: T): T {
  return {
    ...previewed(entry),
    agentSessions: entry.agentSessions.map((a) => previewed(a, CONVERSATION_PROMPT_PREVIEW_LENGTH)),
  }
}
