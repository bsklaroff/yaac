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
 * first. claude and codex use bare ids (their vendor's models.dev list);
 * opencode and pi use `provider/model` for their credential's provider, and
 * pi uses its own registry. Not an allowlist: yaac only shape-checks ids.
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
 * The model a create uses when its project remembers none for this tool:
 * a pinned id for claude and codex (`FALLBACK_MODELS`), pi's own
 * per-provider default for pi, and for opencode pi's default for the same
 * provider if opencode's catalog lists it, else the provider's newest.
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

/** A provider's newest model as `provider/model`, or '' if the catalog lists
 *  none (the create then launches without a model). */
function qualifiedHead(catalog: Record<string, string[]>, provider: string): string {
  const head = catalog[provider]?.[0]
  return head !== undefined ? `${provider}/${head}` : ''
}

/**
 * A model id's display name from the tool's catalog, or undefined.
 *
 * Tries the id as reported, then without a `[1m]`-style context suffix and a
 * `-YYYYMMDD` snapshot suffix, which the catalog doesn't carry. claude's
 * names drop the leading "Claude", since the tool label already says it.
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

/**
 * Map a model an agent reported to the catalog's id, so every surface names
 * it as the create form did. A known id is kept; otherwise match on the
 * reported name (claude's ACP adapter reports aliases like `opus[1m]` named
 * "Opus 5.5", the catalog's name for `claude-opus-5-5`). Failing that, the
 * reported id is returned.
 */
export function catalogModel(tool: AgentTool, id: string, name: string | undefined): string {
  if (name === undefined || modelDisplayName(tool, id) !== undefined) return id
  return modelsForTool(tool, undefined).find((m) => m.name === name)?.id ?? id
}
