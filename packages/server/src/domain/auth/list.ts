import { listCredentialSummaries } from '#domain/projects'
import { loadToolAuthEntry } from '@yaac/shared/tool-auth'
import { defaultModelFor, modelsForTool } from './models'
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
  const provider = entry.tool === 'opencode' ? entry.opencodeProvider
    : entry.tool === 'pi' ? entry.piProvider
    : undefined
  return {
    tool,
    kind: entry.kind,
    keyPreview: maskKey(entry.apiKey),
    savedAt: entry.savedAt,
    // `entry` is the full union, so narrow per tool.
    opencodeProvider: entry.tool === 'opencode' ? entry.opencodeProvider : undefined,
    piProvider: entry.tool === 'pi' ? entry.piProvider : undefined,
    // The create form's model list; for opencode/pi it depends on the
    // provider.
    models: modelsForTool(tool, provider),
    defaultModel: defaultModelFor(tool, provider),
  }
}

/**
 * Masked summary of git credentials and per-tool credentials, for the
 * settings page, `yaac auth list` and the create form's model lists. Never
 * returns raw tokens or keys.
 */
export async function listAuth(): Promise<AuthListResult> {
  const [gitCredentials, claude, codex, opencode, pi] = await Promise.all([
    listCredentialSummaries(),
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
