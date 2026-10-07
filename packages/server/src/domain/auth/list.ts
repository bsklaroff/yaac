import { listCredentialSummaries } from '#domain/projects'
import { defaultModelFor, modelsForTool } from './models'
import { loadToolAuthEntry } from './store'
import type {
  AgentTool,
  AuthListResult,
  ToolAuthSummary,
} from '@yaac/shared/types'

function maskKey(key: string): string {
  return key.length > 4 ? '***' + key.slice(-4) : '****'
}

async function toolAuthSummary(owner: string, tool: AgentTool): Promise<ToolAuthSummary | null> {
  const entry = await loadToolAuthEntry(owner, tool)
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
 * Masked summary of `owner`'s git and tool credentials, for the settings
 * page, `yaac auth list` and the create form's model lists. Never
 * returns raw tokens or keys.
 */
export async function listAuth(owner: string): Promise<AuthListResult> {
  const [gitCredentials, claude, codex, opencode, pi] = await Promise.all([
    listCredentialSummaries(owner),
    toolAuthSummary(owner, 'claude'),
    toolAuthSummary(owner, 'codex'),
    toolAuthSummary(owner, 'opencode'),
    toolAuthSummary(owner, 'pi'),
  ])
  const toolAuth: ToolAuthSummary[] = []
  if (claude) toolAuth.push(claude)
  if (codex) toolAuth.push(codex)
  if (opencode) toolAuth.push(opencode)
  if (pi) toolAuth.push(pi)
  return { gitCredentials, toolAuth }
}
