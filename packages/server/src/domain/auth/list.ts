import { listEntries } from '#store/projects'
import { loadToolAuthEntry } from '@yaac/shared/tool-auth'
import type {
  AgentTool,
  AuthListResult,
  ToolAuthSummary,
} from '@yaac/shared/types'

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
    // `tool` is a runtime value here, so the entry is the full union —
    // narrowed per tool rather than read off a shape that carries every
    // tool's optional fields at once.
    opencodeProvider: entry.tool === 'opencode' ? entry.opencodeProvider : undefined,
    piProvider: entry.tool === 'pi' ? entry.piProvider : undefined,
  }
}

/**
 * Aggregate the masked view over git credentials and per-tool credentials
 * used by `yaac auth list`. Never returns the raw tokens, key bytes, or
 * API keys.
 */
export async function listAuth(): Promise<AuthListResult> {
  const [gitCredentials, claude, codex, opencode, pi] = await Promise.all([
    listEntries(),
    toolAuthSummary('claude'),
    toolAuthSummary('codex'),
    toolAuthSummary('opencode'),
    toolAuthSummary('pi'),
  ])
  const toolAuth: ToolAuthSummary[] = []
  if (claude) toolAuth.push(claude)
  if (codex) toolAuth.push(codex)
  if (opencode) toolAuth.push(opencode)
  if (pi) toolAuth.push(pi)
  return { gitCredentials, toolAuth }
}
