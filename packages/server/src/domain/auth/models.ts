import {
  FALLBACK_MODELS,
  OPENCODE_DEFAULT_PROVIDER,
  PI_DEFAULT_PROVIDER,
} from '@yaac/shared/tool-providers'
import {
  MODEL_NAMES,
  MODELS_BY_PROVIDER,
  PI_MODEL_NAMES,
  PI_MODELS_BY_PROVIDER,
  PI_PROVIDER_DEFAULT_MODELS,
} from '@yaac/shared/tool-providers.generated'
import type { AgentTool, ModelOption } from '@yaac/shared/types'

/**
 * The models a tool can be created with, from the baked catalog, newest
 * first. claude and codex take bare ids (their vendor's models.dev list);
 * opencode and pi take `provider/model` for the provider their credential
 * names, and pi reads its own registry rather than models.dev.
 *
 * A convenience, not an allowlist — each tool accepts any id it recognizes,
 * and yaac only shape-checks what it is handed.
 */
export function modelsForTool(tool: AgentTool, provider: string | undefined): ModelOption[] {
  if (tool === 'claude' || tool === 'codex') {
    const vendor = tool === 'claude' ? 'anthropic' : 'openai'
    return (MODELS_BY_PROVIDER[vendor] ?? []).map((id) => option(tool, id))
  }
  if (provider === undefined) return []
  const catalog = tool === 'pi' ? PI_MODELS_BY_PROVIDER : MODELS_BY_PROVIDER
  return (catalog[provider] ?? []).map((m) => option(tool, `${provider}/${m}`))
}

function option(tool: AgentTool, id: string): ModelOption {
  const name = modelDisplayName(tool, id)
  return name !== undefined ? { id, name } : { id }
}

/**
 * The model a create runs when its project remembers none for this tool.
 *
 * claude and codex answer a hand-pinned id (`FALLBACK_MODELS`). pi answers its
 * own per-provider default — what it launched with before yaac named a model
 * at all. opencode has no default of its own to borrow, so it takes pi's for
 * the same provider when opencode's catalog lists that model, else the
 * provider's newest.
 */
export function defaultModelFor(tool: AgentTool, provider: string | undefined): string {
  if (tool === 'claude' || tool === 'codex') return FALLBACK_MODELS[tool]
  if (tool === 'pi') {
    const p = provider ?? PI_DEFAULT_PROVIDER
    return PI_PROVIDER_DEFAULT_MODELS[p] ?? qualifiedHead(PI_MODELS_BY_PROVIDER, p)
  }
  const p = provider ?? OPENCODE_DEFAULT_PROVIDER
  const borrowed = PI_PROVIDER_DEFAULT_MODELS[p]
  if (borrowed !== undefined && MODELS_BY_PROVIDER[p]?.includes(borrowed.slice(p.length + 1))) {
    return borrowed
  }
  return qualifiedHead(MODELS_BY_PROVIDER, p)
}

/** A provider's first (newest) model, qualified — or '' for a provider the
 *  catalog lists nothing for, which a create then launches without. */
function qualifiedHead(catalog: Record<string, string[]>, provider: string): string {
  const head = catalog[provider]?.[0]
  return head !== undefined ? `${provider}/${head}` : ''
}

/**
 * What a model id is called, from the catalog the tool's ids come from, or
 * undefined when the catalog has no name for it.
 *
 * Looked up as reported and then without the decorations a transcript adds
 * but the catalog does not carry: a `-YYYYMMDD` snapshot suffix (curation keeps
 * only the alias) and a `[1m]`-style context suffix. claude's names drop their
 * leading "Claude", which the tool label beside them already says.
 */
export function modelDisplayName(tool: AgentTool, id: string): string | undefined {
  let names: Record<string, string> | undefined
  let bare = id
  if (tool === 'claude' || tool === 'codex') {
    names = MODEL_NAMES[tool === 'claude' ? 'anthropic' : 'openai']
  } else {
    const slash = id.indexOf('/')
    if (slash <= 0) return undefined
    names = (tool === 'pi' ? PI_MODEL_NAMES : MODEL_NAMES)[id.slice(0, slash)]
    bare = id.slice(slash + 1)
  }
  if (names === undefined) return undefined
  const undecorated = bare.replace(/\[[^\]]*\]$/, '')
  const name = names[bare] ?? names[undecorated] ?? names[undecorated.replace(/-\d{8}$/, '')]
  return tool === 'claude' ? name?.replace(/^Claude /, '') : name
}
