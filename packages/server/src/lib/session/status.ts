import type { AgentTool } from '@yaac/shared/types'
import { getSessionFirstUserMessage as getSessionClaudeFirstMessage } from '#lib/session/claude-status'
import { getSessionCodexFirstUserMessage } from '#lib/session/codex-status'
import {
  getSessionOpencodeFirstUserMessage,
  getDeletedSessionOpencodeFirstUserMessage,
} from '#lib/session/opencode-status'

/** Normalize a raw `yaac.tool` label value into an AgentTool. */
export function normalizeTool(raw: string | undefined): AgentTool {
  if (raw === 'codex') return 'codex'
  if (raw === 'opencode') return 'opencode'
  return 'claude'
}

/**
 * First-message lookup for `yaac session list`. `jobName` is required
 * for opencode (HTTP probe into the running container) and ignored for
 * claude/codex (they read JSONL files from host bind-mounts). Pass
 * `undefined` for deleted-session listings where the Job is gone —
 * opencode then reads from its on-disk meta cache.
 */
export async function getSessionFirstMessage(
  projectSlug: string,
  sessionId: string,
  tool: AgentTool,
  jobName?: string,
): Promise<string | undefined> {
  if (tool === 'codex') return getSessionCodexFirstUserMessage(projectSlug, sessionId)
  if (tool === 'opencode') {
    if (jobName) {
      return getSessionOpencodeFirstUserMessage(projectSlug, sessionId, jobName)
    }
    return getDeletedSessionOpencodeFirstUserMessage(projectSlug, sessionId)
  }
  return getSessionClaudeFirstMessage(projectSlug, sessionId)
}
