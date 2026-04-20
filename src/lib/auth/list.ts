import { listTokens } from '@/lib/project/credentials'
import { loadToolAuthEntry } from '@/lib/project/tool-auth'
import type { AgentTool, ToolAuthKind } from '@/types'

export interface GithubTokenSummary {
  pattern: string
  tokenPreview: string
}

export interface ToolAuthSummary {
  tool: AgentTool
  kind: ToolAuthKind
  /** Masked preview of the access token / API key (last 4 chars). */
  keyPreview: string
  savedAt: string
}

export interface AuthListResult {
  githubTokens: GithubTokenSummary[]
  toolAuth: ToolAuthSummary[]
}

function maskKey(key: string): string {
  return key.length > 4 ? '***' + key.slice(-4) : '****'
}

async function toolAuthSummary(tool: AgentTool): Promise<ToolAuthSummary | null> {
  const entry = await loadToolAuthEntry(tool)
  if (!entry) return null
  return {
    tool,
    kind: entry.kind,
    keyPreview: maskKey(entry.apiKey),
    savedAt: entry.savedAt,
  }
}

/**
 * Aggregate the masked view over GitHub tokens and per-tool credentials used
 * by `yaac auth list`. Never returns the raw tokens or API keys.
 */
export async function listAuth(): Promise<AuthListResult> {
  const [githubTokens, claude, codex] = await Promise.all([
    listTokens(),
    toolAuthSummary('claude'),
    toolAuthSummary('codex'),
  ])
  const toolAuth: ToolAuthSummary[] = []
  if (claude) toolAuth.push(claude)
  if (codex) toolAuth.push(codex)
  return { githubTokens, toolAuth }
}
