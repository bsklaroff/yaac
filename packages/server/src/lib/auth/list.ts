import { listEntries } from '#lib/project/credentials'
import { loadToolAuthEntry } from '@yaac/shared/tool-auth'
import type {
  AgentTool,
  AuthListResult,
  GitCredentialSummary,
  ToolAuthSummary,
} from '@yaac/shared/types'

export type { AuthListResult, GitCredentialSummary, ToolAuthSummary }

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
    opencodeProvider: entry.opencodeProvider,
  }
}

/**
 * Aggregate the masked view over git credentials and per-tool credentials
 * used by `yaac auth list`. Never returns the raw tokens, key bytes, or
 * API keys.
 */
export async function listAuth(): Promise<AuthListResult> {
  const [gitCredentials, claude, codex, opencode] = await Promise.all([
    listEntries(),
    toolAuthSummary('claude'),
    toolAuthSummary('codex'),
    toolAuthSummary('opencode'),
  ])
  const toolAuth: ToolAuthSummary[] = []
  if (claude) toolAuth.push(claude)
  if (codex) toolAuth.push(codex)
  if (opencode) toolAuth.push(opencode)
  return { gitCredentials, toolAuth }
}
