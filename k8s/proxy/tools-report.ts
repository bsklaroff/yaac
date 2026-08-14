// Pure helpers for the `GET yaac.internal/tools` endpoint, which serves the
// legacy `yaac-spawn --models` (docs/legacy-compat-shims.md):
// given which tool credentials the host has and the worktree's registered tool,
// report which agent tools are usable and their accepted model ids. proxy.ts
// starts servers on import, so this logic lives in its own side-effect-free
// module to stay unit-testable in isolation.

import {
  OPENCODE_PROVIDER_HOSTS,
  PI_PROVIDER_HOSTS,
  PI_PROVIDER_DEFAULT_MODELS,
  MODELS_BY_PROVIDER,
  PI_MODELS_BY_PROVIDER,
} from './tool-providers.generated'

export const AGENT_TOOLS = ['claude', 'codex', 'opencode', 'pi'] as const
export type AgentTool = (typeof AGENT_TOOLS)[number]

// Vendor hosts, mirroring proxy.ts's constants. claude always authenticates
// against api.anthropic.com (api-key and OAuth alike); codex splits by kind —
// OAuth (ChatGPT) inference routes to chatgpt.com/backend-api, api-key to
// api.openai.com. opencode/pi resolve theirs from the configured provider.
const ANTHROPIC_API_HOST = 'api.anthropic.com'
const OPENAI_API_HOST = 'api.openai.com'
const CHATGPT_HOST = 'chatgpt.com'

/** What the report needs about one tool's host credentials. */
export type ToolCredsView =
  | { authed: false }
  | { authed: true; kind: 'oauth' | 'api-key'; provider?: string }

export interface ToolReportEntry {
  tool: AgentTool
  authed: boolean
  /** True when this is the tool the querying worktree itself runs. */
  current: boolean
  kind?: 'oauth' | 'api-key'
  provider?: string
  apiHost?: string
  /** pi only: the `provider/model` it launches with when --model is omitted. */
  defaultModel?: string
  /** Accepted model ids; present only when includeModels was requested. */
  models?: string[]
}

export interface ToolsReport {
  currentTool: string | null
  tools: ToolReportEntry[]
}

export interface BuildToolsReportInput {
  currentTool?: string | null
  creds: Record<AgentTool, ToolCredsView>
  includeModels: boolean
}

/**
 * Accepted model ids for a tool, from the baked models.dev catalog. claude →
 * claude → the `anthropic` provider (bare ids), codex → `openai` (bare ids),
 * both from models.dev's tool-calling catalog. opencode and pi take
 * `provider/model`, so their ids are prefixed with the configured provider —
 * opencode from models.dev, pi from pi's own registry (which differs). pi falls
 * back to its default when the registry lists nothing. Empty when nothing is
 * known — the tool still accepts any id it recognizes; the list is a
 * convenience, not an allowlist.
 */
export function modelsForTool(tool: AgentTool, provider: string | undefined): string[] {
  if (tool === 'claude') return MODELS_BY_PROVIDER['anthropic'] ?? []
  if (tool === 'codex') return MODELS_BY_PROVIDER['openai'] ?? []
  if (tool === 'opencode') {
    // opencode's `--model` is `provider/model` (agent-command.ts), like pi.
    return provider ? (MODELS_BY_PROVIDER[provider] ?? []).map((m) => `${provider}/${m}`) : []
  }
  // pi: `provider/model`, from pi's own catalog (not models.dev).
  if (!provider) return []
  const base = PI_MODELS_BY_PROVIDER[provider] ?? []
  if (base.length) return base.map((m) => `${provider}/${m}`)
  const dflt = PI_PROVIDER_DEFAULT_MODELS[provider]
  return dflt ? [dflt] : []
}

/** The host a tool's api key authenticates against, if resolvable. */
export function apiHostForTool(
  tool: AgentTool,
  provider: string | undefined,
  kind: 'oauth' | 'api-key' | undefined,
): string | undefined {
  if (tool === 'claude') return ANTHROPIC_API_HOST
  // Codex OAuth (ChatGPT) inference goes to chatgpt.com/backend-api, not the
  // api-key host api.openai.com (see proxy.ts).
  if (tool === 'codex') return kind === 'oauth' ? CHATGPT_HOST : OPENAI_API_HOST
  if (tool === 'opencode') return provider ? OPENCODE_PROVIDER_HOSTS[provider] : undefined
  return provider ? PI_PROVIDER_HOSTS[provider] : undefined
}

/** Build the availability report from host creds + the worktree's tool. */
export function buildToolsReport(input: BuildToolsReportInput): ToolsReport {
  const currentTool = input.currentTool ?? null
  const tools = AGENT_TOOLS.map((tool): ToolReportEntry => {
    const cred = input.creds[tool]
    const entry: ToolReportEntry = { tool, authed: cred.authed, current: tool === currentTool }
    if (!cred.authed) return entry
    entry.kind = cred.kind
    const provider = cred.provider
    if (tool === 'opencode' || tool === 'pi') entry.provider = provider
    entry.apiHost = apiHostForTool(tool, provider, cred.kind)
    if (tool === 'pi' && provider) entry.defaultModel = PI_PROVIDER_DEFAULT_MODELS[provider]
    if (input.includeModels) entry.models = modelsForTool(tool, provider)
    return entry
  })
  return { currentTool, tools }
}

/** Render the report as the default human-readable text/plain body. */
export function formatToolsReport(report: ToolsReport): string {
  const lines: string[] = [
    `Agent tools available in this project (current worktree tool: ${report.currentTool ?? 'unknown'})`,
    '',
  ]
  for (const t of report.tools) {
    const name = t.tool.padEnd(9)
    if (!t.authed) {
      lines.push(`${name} not configured`)
      continue
    }
    const bits = [`${name} authed (${t.kind ?? '?'})`]
    if (t.provider) bits.push(`provider=${t.provider}`)
    if (t.apiHost) bits.push(`host=${t.apiHost}`)
    if (t.current) bits.push('[current]')
    lines.push(bits.join('  '))
    if (t.defaultModel) lines.push(`    default: ${t.defaultModel}`)
    if (t.models) {
      lines.push(t.models.length
        ? `    models (${t.models.length}): ${t.models.join(', ')}`
        : '    models: none listed — pass any id the tool accepts')
    }
  }
  lines.push('', 'Spawn with:  yaac-spawn --tool <tool> --model <id> "<prompt>"')
  return `${lines.join('\n')}\n`
}
