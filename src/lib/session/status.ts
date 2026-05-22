import type { AgentTool } from '@/shared/types'
import { getSessionClaudeStatus, getSessionFirstUserMessage as getSessionClaudeFirstMessage } from '@/lib/session/claude-status'
import { getSessionCodexStatus, getSessionCodexFirstUserMessage } from '@/lib/session/codex-status'
import {
  getSessionOpencodeStatus,
  getSessionOpencodeFirstUserMessage,
  getDeletedSessionOpencodeFirstUserMessage,
} from '@/lib/session/opencode-status'

export function getToolFromContainer(container: { Labels?: Record<string, string> }): AgentTool {
  const tool = container.Labels?.['yaac.tool']
  if (tool === 'codex') return 'codex'
  if (tool === 'opencode') return 'opencode'
  return 'claude'
}

export async function getSessionStatus(
  projectSlug: string,
  sessionId: string,
  tool: AgentTool,
  containerName: string,
): Promise<'running' | 'waiting'> {
  if (tool === 'codex') return getSessionCodexStatus(projectSlug, sessionId)
  if (tool === 'opencode') return getSessionOpencodeStatus(projectSlug, sessionId, containerName)
  return getSessionClaudeStatus(projectSlug, sessionId, containerName)
}

/**
 * First-message lookup for `yaac session list`. `containerName` is
 * required for opencode (HTTP probe into the running container) and
 * ignored for claude/codex (they read JSONL files from host bind-mounts).
 * Pass `undefined` for deleted-session listings where the container is
 * gone — opencode then reads from its on-disk meta cache.
 */
export async function getSessionFirstMessage(
  projectSlug: string,
  sessionId: string,
  tool: AgentTool,
  containerName?: string,
): Promise<string | undefined> {
  if (tool === 'codex') return getSessionCodexFirstUserMessage(projectSlug, sessionId)
  if (tool === 'opencode') {
    if (containerName) {
      return getSessionOpencodeFirstUserMessage(projectSlug, sessionId, containerName)
    }
    return getDeletedSessionOpencodeFirstUserMessage(projectSlug, sessionId)
  }
  return getSessionClaudeFirstMessage(projectSlug, sessionId)
}
