import type { AgentTool } from '@/types'
import { getSessionClaudeStatus, getSessionFirstUserMessage as getSessionClaudeFirstMessage } from '@/lib/session/claude-status'
import { getSessionCodexStatus, getSessionCodexFirstUserMessage } from '@/lib/session/codex-status'

export function getToolFromContainer(container: { Labels?: Record<string, string> }): AgentTool {
  const tool = container.Labels?.['yaac.tool']
  if (tool === 'codex') return 'codex'
  return 'claude'
}

export async function getSessionStatus(
  projectSlug: string,
  sessionId: string,
  tool: AgentTool,
): Promise<'running' | 'waiting'> {
  if (tool === 'codex') return getSessionCodexStatus(projectSlug, sessionId)
  return getSessionClaudeStatus(projectSlug, sessionId)
}

export async function getSessionFirstMessage(
  projectSlug: string,
  sessionId: string,
  tool: AgentTool,
): Promise<string | undefined> {
  if (tool === 'codex') return getSessionCodexFirstUserMessage(projectSlug, sessionId)
  return getSessionClaudeFirstMessage(projectSlug, sessionId)
}
