import {
  CUSTOM_PROVIDER,
  FALLBACK_MODELS,
  OMP_DEFAULT_PROVIDER,
  OPENCODE_DEFAULT_PROVIDER,
  PI_DEFAULT_PROVIDER,
  endpointEfforts,
  isApiKeyTool,
  type CustomEndpoint,
} from '@yaac/shared/tool-providers'
import {
  CLAUDE_MODELS,
  EFFORTS,
  MODEL_NAMES,
  MODELS_BY_PROVIDER,
  OMP_MODEL_NAMES,
  OMP_MODELS_BY_PROVIDER,
  OMP_PROVIDER_DEFAULT_MODELS,
  PI_MODEL_NAMES,
  PI_MODELS_BY_PROVIDER,
  PI_PROVIDER_DEFAULT_MODELS,
} from '@yaac/shared/tool-providers.generated'
import type { AgentTool, ModelEfforts, ModelOption } from '@yaac/shared/types'

/**
 * The models a tool can be created with, from the baked catalog, newest
 * first, each with its effort levels. claude uses models.dev's anthropic
 * list less models the pinned claude doesn't know (`CLAUDE_MODELS`), codex
 * models.dev's openai list; opencode, pi and omp use `provider/model` for
 * their credential's provider, and pi and omp use their own registries. A
 * custom endpoint's models are the ones the endpoint lists, with its names
 * and levels. Not an allowlist: yaac only shape-checks ids.
 */
export function modelsForTool(tool: AgentTool, provider: string | undefined, endpoint?: CustomEndpoint): ModelOption[] {
  return catalogIds(tool, provider, endpoint).map((id) => option(tool, id, endpoint))
}

function catalogIds(tool: AgentTool, provider: string | undefined, endpoint?: CustomEndpoint): string[] {
  if (tool === 'claude') return CLAUDE_MODELS
  if (tool === 'codex') return MODELS_BY_PROVIDER.openai ?? []
  if (provider === CUSTOM_PROVIDER) return (endpoint?.models ?? []).map((m) => `${CUSTOM_PROVIDER}/${m.id}`)
  if (provider === undefined) return []
  return (OWN_CATALOGS[tool]?.ids ?? MODELS_BY_PROVIDER)[provider]?.map((m) => `${provider}/${m}`) ?? []
}

/** A tool's own model registry: ids and display names per provider, and
 *  each provider's default `provider/model`. */
interface OwnCatalog {
  ids: Record<string, string[]>
  names: Record<string, Record<string, string>>
  defaults: Record<string, string>
  defaultProvider: string
}

/** pi's and omp's own registries, which differ from models.dev's and from
 *  each other. */
const OWN_CATALOGS: Partial<Record<AgentTool, OwnCatalog>> = {
  pi: { ids: PI_MODELS_BY_PROVIDER, names: PI_MODEL_NAMES, defaults: PI_PROVIDER_DEFAULT_MODELS, defaultProvider: PI_DEFAULT_PROVIDER },
  omp: { ids: OMP_MODELS_BY_PROVIDER, names: OMP_MODEL_NAMES, defaults: OMP_PROVIDER_DEFAULT_MODELS, defaultProvider: OMP_DEFAULT_PROVIDER },
}

function option(tool: AgentTool, id: string, endpoint?: CustomEndpoint): ModelOption {
  const name = endpointModel(tool, id, endpoint)?.name ?? modelDisplayName(tool, id)
  const efforts = modelEfforts(tool, id, endpoint)
  return {
    id,
    ...(name !== undefined ? { name } : {}),
    ...(efforts !== undefined ? { efforts } : {}),
  }
}

/** A `custom/<id>` model of an api-key tool, from its endpoint's list. */
function endpointModel(tool: AgentTool, id: string, endpoint: CustomEndpoint | undefined) {
  if (endpoint === undefined || !isApiKeyTool(tool) || !id.startsWith(`${CUSTOM_PROVIDER}/`)) return undefined
  return endpoint.models.find((m) => m.id === id.slice(CUSTOM_PROVIDER.length + 1))
}

/**
 * Whether the catalog offers this model id. An api-key tool's ids name
 * their provider, which picks the catalog to look in; a custom model is
 * looked up in `endpoint`, the tool's custom endpoint.
 */
export function isCatalogModel(tool: AgentTool, id: string, endpoint?: CustomEndpoint): boolean {
  const provider = isApiKeyTool(tool) ? id.slice(0, Math.max(0, id.indexOf('/'))) : undefined
  return catalogIds(tool, provider, endpoint).includes(id)
}

/**
 * A model's effort levels and default (docs/effort-levels.md), or undefined
 * when the catalog has none for it. A custom model's come from `endpoint`,
 * in the tool's words (`endpointEfforts`). Otherwise tried as given, then
 * without a `[1m]` suffix or a `-YYYYMMDD` snapshot suffix, as
 * `modelDisplayName` does.
 */
export function modelEfforts(tool: AgentTool, id: string, endpoint?: CustomEndpoint): ModelEfforts | undefined {
  const custom = endpointModel(tool, id, endpoint)
  if (custom !== undefined && isApiKeyTool(tool)) return endpointEfforts(tool, custom)
  const table = EFFORTS[tool]
  const undecorated = id.replace(/\[[^\]]*\]$/, '')
  return table[id] ?? table[undecorated] ?? table[undecorated.replace(/-\d{8}$/, '')]
}

/**
 * The model a create uses when its project remembers none for this tool:
 * a pinned id for claude and codex (`FALLBACK_MODELS`), a custom
 * endpoint's first listed model, the tool's own per-provider default for pi
 * and omp, and for opencode pi's default for the same provider if opencode's
 * catalog lists it, else the provider's newest.
 */
export function defaultModelFor(tool: AgentTool, provider: string | undefined, endpoint?: CustomEndpoint): string {
  if (tool === 'claude' || tool === 'codex') return FALLBACK_MODELS[tool]
  if (provider === CUSTOM_PROVIDER) return catalogIds(tool, provider, endpoint)[0] ?? ''
  const own = OWN_CATALOGS[tool]
  if (own !== undefined) {
    const p = provider ?? own.defaultProvider
    return own.defaults[p] ?? qualifiedHead(own.ids, p)
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
    names = (OWN_CATALOGS[tool]?.names ?? MODEL_NAMES)[id.slice(0, slash)]
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
 * reported name (claude's ACP adapter reports aliases like `opus` named
 * "Opus 5.5", the catalog's name for `claude-opus-5-5`). Failing that, the
 * reported id is returned.
 */
export function catalogModel(tool: AgentTool, id: string, name: string | undefined): string {
  if (name === undefined || modelDisplayName(tool, id) !== undefined) return id
  return modelsForTool(tool, undefined).find((m) => m.name === name)?.id ?? id
}
