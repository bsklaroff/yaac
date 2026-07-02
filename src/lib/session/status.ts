import type { AgentTool } from '@/shared/types'
import { getSessionClaudeStatus, getSessionFirstUserMessage as getSessionClaudeFirstMessage } from '@/lib/session/claude-status'
import { getSessionCodexStatus, getSessionCodexFirstUserMessage } from '@/lib/session/codex-status'
import {
  getSessionOpencodeStatus,
  getSessionOpencodeFirstUserMessage,
  getDeletedSessionOpencodeFirstUserMessage,
} from '@/lib/session/opencode-status'

/** Normalize a raw `yaac.tool` label value into an AgentTool. */
export function normalizeTool(raw: string | undefined): AgentTool {
  if (raw === 'codex') return 'codex'
  if (raw === 'opencode') return 'opencode'
  return 'claude'
}

export async function getSessionStatus(
  projectSlug: string,
  sessionId: string,
  tool: AgentTool,
  jobName: string,
): Promise<'running' | 'waiting'> {
  if (tool === 'codex') return getSessionCodexStatus(projectSlug, sessionId, jobName)
  if (tool === 'opencode') return getSessionOpencodeStatus(projectSlug, sessionId, jobName)
  return getSessionClaudeStatus(projectSlug, sessionId, jobName)
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
