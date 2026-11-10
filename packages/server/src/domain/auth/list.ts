import { listCredentialSummaries } from './git-credentials'
import { defaultModelFor, modelsForTool } from './models'
import { authEntryEndpoint, authEntryProvider, loadToolAuthEntry } from './store'
import {
  AGENT_TOOLS,
  type AgentTool,
  type AuthListResult,
  type ToolAuthSummary,
} from '@yaac/shared/types'

/** A key's last four characters; empty for a keyless custom endpoint. */
function maskKey(key: string): string {
  if (key === '') return ''
  return key.length > 4 ? '***' + key.slice(-4) : '****'
}

async function toolAuthSummary(owner: string, tool: AgentTool): Promise<ToolAuthSummary | null> {
  const entry = await loadToolAuthEntry(owner, tool)
  if (!entry) return null
  const provider = authEntryProvider(entry)
  const endpoint = authEntryEndpoint(entry)
  return {
    tool,
    kind: entry.kind,
    keyPreview: maskKey(entry.apiKey),
    savedAt: entry.savedAt,
    // `entry` is the full union, so narrow per tool.
    opencodeProvider: entry.tool === 'opencode' ? entry.opencodeProvider : undefined,
    piProvider: entry.tool === 'pi' ? entry.piProvider : undefined,
    ompProvider: entry.tool === 'omp' ? entry.ompProvider : undefined,
    ...(endpoint !== undefined ? { endpoint } : {}),
    // The create form's model list; for an api-key tool it depends on the
    // provider.
    models: modelsForTool(tool, provider, endpoint),
    defaultModel: defaultModelFor(tool, provider, endpoint),
  }
}

/**
 * Masked summary of `owner`'s git and tool credentials, for the settings
 * page, `yaac auth list` and the create form's model lists. Never
 * returns raw tokens or keys.
 */
export async function listAuth(owner: string): Promise<AuthListResult> {
  const [gitCredentials, summaries] = await Promise.all([
    listCredentialSummaries(owner),
    Promise.all(AGENT_TOOLS.map((tool) => toolAuthSummary(owner, tool))),
  ])
  const toolAuth = summaries.filter((s) => s !== null)
  return { gitCredentials, toolAuth }
}
