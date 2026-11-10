/**
 * Provider registries and helpers for the api-key-only agent tools
 * (`opencode`, `pi` and `omp`). The user stores an api key for one provider; yaac
 * seeds it into the workspace under `toolApiKeyEnvVar` (a placeholder the
 * egress proxy swaps on that provider's host, when there is a proxy), and
 * points the tool's own config at that variable.
 *
 * The provider data is generated into `tool-providers.generated.ts` by
 * `pnpm gen:providers` (scripts/gen-tool-providers.ts). One provider is not
 * generated: `custom`, a self-hosted OpenAI-compatible endpoint the user
 * defines once and attaches to any of these tools (`CustomEndpoint`,
 * docs/custom-endpoints.md).
 */
import {
  OMP_PROVIDERS as GENERATED_OMP_PROVIDERS,
  OPENCODE_PROVIDERS as GENERATED_OPENCODE_PROVIDERS,
  PI_PROVIDERS as GENERATED_PI_PROVIDERS,
  type ModelEfforts,
  type OmpProviderId,
  type OpencodeProviderId,
  type PiProviderId,
  type ToolProviderInfo,
} from '#tool-providers.generated'

export type { ToolProviderInfo }

/** The tools that authenticate only with an api key for a chosen provider. */
export type ApiKeyTool = 'opencode' | 'pi' | 'omp'

export const API_KEY_TOOLS: readonly ApiKeyTool[] = ['opencode', 'pi', 'omp']

export function isApiKeyTool(tool: string): tool is ApiKeyTool {
  return (API_KEY_TOOLS as readonly string[]).includes(tool)
}

/** The provider id of a self-hosted OpenAI-compatible endpoint. */
export const CUSTOM_PROVIDER = 'custom'

/**
 * The reasoning levels an endpoint may advertise for a model, in the words
 * of the OpenAI `reasoning_effort` parameter it is sent as, least first.
 */
export const ENDPOINT_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type EndpointEffort = typeof ENDPOINT_EFFORTS[number]

/** One model a custom endpoint serves, with its reasoning levels in the
 *  endpoint's words when it has any. */
export interface EndpointModel {
  id: string
  name?: string
  efforts?: { levels: EndpointEffort[]; default: EndpointEffort }
}

/**
 * A user's custom endpoint: where a `custom` provider sends requests, and
 * the models it serves. The proxy swaps a key in on `baseUrl`'s host, as it
 * does on a generated provider's `apiHost`.
 */
export interface CustomEndpoint {
  id: string
  name: string
  baseUrl: string
  models: EndpointModel[]
}

/**
 * A custom endpoint model's effort levels in an api-key tool's own words
 * (docs/effort-levels.md), or undefined when it advertises none. pi and omp
 * call `none` `off`; omp can always turn thinking off, so it offers `off`
 * either way. opencode leads with `default` (no variant), but defaults to
 * the endpoint's level so every launch names one.
 */
export function endpointEfforts(tool: ApiKeyTool, model: EndpointModel): ModelEfforts | undefined {
  if (model.efforts === undefined) return undefined
  const word = (level: EndpointEffort): string => (tool !== 'opencode' && level === 'none' ? 'off' : level)
  const levels = ENDPOINT_EFFORTS.filter((l) => model.efforts?.levels.includes(l)).map(word)
  const lead = tool === 'opencode' ? ['default'] : tool === 'omp' && !levels.includes('off') ? ['off'] : []
  return { levels: [...lead, ...levels], default: word(model.efforts.default) }
}

/**
 * The `custom` row. Its host comes from the credential's endpoint, and it
 * has no variable of its own to fall back to, so both are left empty.
 * Listed first so the provider pickers show it without a search.
 */
const CUSTOM_PROVIDER_INFO = {
  id: CUSTOM_PROVIDER, label: 'Custom (OpenAI-compatible)', envVar: '', apiHost: '',
} as const satisfies ToolProviderInfo

export const OPENCODE_PROVIDERS = [CUSTOM_PROVIDER_INFO, ...GENERATED_OPENCODE_PROVIDERS] as const
export const PI_PROVIDERS = [CUSTOM_PROVIDER_INFO, ...GENERATED_PI_PROVIDERS] as const
export const OMP_PROVIDERS = [CUSTOM_PROVIDER_INFO, ...GENERATED_OMP_PROVIDERS] as const

/**
 * A provider id for the tool, from the generated registry or `custom`.
 * Parse raw strings with `parseOpencodeProvider` / `parsePiProvider` /
 * `parseOmpProvider`.
 */
export type OpencodeProvider = OpencodeProviderId | typeof CUSTOM_PROVIDER
export type PiProvider = PiProviderId | typeof CUSTOM_PROVIDER
export type OmpProvider = OmpProviderId | typeof CUSTOM_PROVIDER

/** The picker's default provider. */
export const OPENCODE_DEFAULT_PROVIDER: OpencodeProvider = 'openrouter'
export const PI_DEFAULT_PROVIDER: PiProvider = 'openrouter'
export const OMP_DEFAULT_PROVIDER: OmpProvider = 'openrouter'

/**
 * The model a claude / codex create runs when its project remembers none for
 * that tool. Maintained by hand because nothing generated names a current
 * default. Review both when the tools image updates claude or codex; a test
 * fails if a regen drops either from the catalog.
 */
export const FALLBACK_MODELS = {
  claude: 'claude-opus-5-5',
  codex: 'gpt-6-sol',
} as const

function infoOrDefault(
  list: readonly ToolProviderInfo[],
  id: string,
  defaultId: string,
): ToolProviderInfo {
  return list.find((p) => p.id === id)
    ?? list.find((p) => p.id === defaultId)
    ?? list[0]
}

/**
 * A recognized id, or undefined. Never falls back to a default: the
 * provider decides where the key is sent, so a guess could leak it to a
 * vendor the user never chose.
 */
function parseProvider<T extends string>(
  list: readonly ToolProviderInfo[],
  value: string | undefined,
): T | undefined {
  return list.some((p) => p.id === value) ? (value as T) : undefined
}

/** Look up an opencode provider's metadata; falls back to the default. */
export function opencodeProviderInfo(id: OpencodeProvider): ToolProviderInfo {
  return infoOrDefault(OPENCODE_PROVIDERS, id, OPENCODE_DEFAULT_PROVIDER)
}

/** Look up a pi provider's metadata; falls back to the default. */
export function piProviderInfo(id: PiProvider): ToolProviderInfo {
  return infoOrDefault(PI_PROVIDERS, id, PI_DEFAULT_PROVIDER)
}

/** Look up an omp provider's metadata; falls back to the default. */
export function ompProviderInfo(id: OmpProvider): ToolProviderInfo {
  return infoOrDefault(OMP_PROVIDERS, id, OMP_DEFAULT_PROVIDER)
}

/**
 * The host the proxy swaps a provider's key in on: the generated row's
 * `apiHost`, or a custom endpoint's host. Undefined when there is none,
 * so the key goes nowhere rather than to a guessed vendor.
 */
export function providerApiHost(
  list: readonly ToolProviderInfo[],
  provider: string | undefined,
  endpoint: { baseUrl: string } | undefined,
): string | undefined {
  if (provider === CUSTOM_PROVIDER) return endpoint && new URL(endpoint.baseUrl).hostname
  return list.find((p) => p.id === provider)?.apiHost || undefined
}

/**
 * The workspace variable holding a tool's key for a provider, e.g.
 * `YAAC_PI_KEY_OPENROUTER`. Named per tool so each api-key tool can hold
 * a different key for one provider without clashing, and per provider so a
 * config entry left from a provider the user has since switched away from
 * is never handed the new provider's key.
 */
export function toolApiKeyEnvVar(tool: ApiKeyTool, provider: string): string {
  return `YAAC_${tool.toUpperCase()}_KEY_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

/** A raw string as an OpencodeProvider, or undefined if it isn't one. */
export function parseOpencodeProvider(value: string | undefined): OpencodeProvider | undefined {
  return parseProvider(OPENCODE_PROVIDERS, value)
}

/** A raw string as a PiProvider, or undefined if it isn't one. */
export function parsePiProvider(value: string | undefined): PiProvider | undefined {
  return parseProvider(PI_PROVIDERS, value)
}

/** A raw string as an OmpProvider, or undefined if it isn't one. */
export function parseOmpProvider(value: string | undefined): OmpProvider | undefined {
  return parseProvider(OMP_PROVIDERS, value)
}
