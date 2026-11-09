/**
 * Provider registries and helpers for the api-key-only agent tools
 * (`opencode` and `pi`). The user stores an api key for one provider; yaac
 * seeds it into the workspace under `toolApiKeyEnvVar` (a placeholder the
 * egress proxy swaps on that provider's host, when there is a proxy), and
 * points the tool's own config at that variable.
 *
 * The provider data is generated into `tool-providers.generated.ts` by
 * `pnpm gen:providers` (scripts/gen-tool-providers.ts). One provider is not
 * generated: `custom`, a self-hosted OpenAI-compatible endpoint whose URL
 * and models the credential itself carries (`CustomEndpoint`).
 */
import {
  OPENCODE_PROVIDERS as GENERATED_OPENCODE_PROVIDERS,
  PI_PROVIDERS as GENERATED_PI_PROVIDERS,
  type OpencodeProviderId,
  type PiProviderId,
  type ToolProviderInfo,
} from '#tool-providers.generated'

export type { ToolProviderInfo }

/** The provider id of a self-hosted OpenAI-compatible endpoint. */
export const CUSTOM_PROVIDER = 'custom'

/**
 * Where a `custom` provider sends requests, and the model ids it serves.
 * The proxy swaps a key in on `baseUrl`'s host, as it does on a generated
 * provider's `apiHost`.
 */
export interface CustomEndpoint {
  baseUrl: string
  models: string[]
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

/**
 * A provider id for the tool, from the generated registry or `custom`.
 * Parse raw strings with `parseOpencodeProvider` / `parsePiProvider`.
 */
export type OpencodeProvider = OpencodeProviderId | typeof CUSTOM_PROVIDER
export type PiProvider = PiProviderId | typeof CUSTOM_PROVIDER

/** The picker's default provider. */
export const OPENCODE_DEFAULT_PROVIDER: OpencodeProvider = 'openrouter'
export const PI_DEFAULT_PROVIDER: PiProvider = 'openrouter'

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

/**
 * The host the proxy swaps a provider's key in on: the generated row's
 * `apiHost`, or a custom endpoint's host. Undefined when there is none,
 * so the key goes nowhere rather than to a guessed vendor.
 */
export function providerApiHost(
  list: readonly ToolProviderInfo[],
  provider: string | undefined,
  endpoint: CustomEndpoint | undefined,
): string | undefined {
  if (provider === CUSTOM_PROVIDER) return endpoint && new URL(endpoint.baseUrl).hostname
  return list.find((p) => p.id === provider)?.apiHost || undefined
}

/**
 * The workspace variable holding a tool's key for a provider, e.g.
 * `YAAC_PI_KEY_OPENROUTER`. Named per tool so opencode and pi can hold
 * different keys for one provider without clashing, and per provider so a
 * config entry left from a provider the user has since switched away from
 * is never handed the new provider's key.
 */
export function toolApiKeyEnvVar(tool: 'opencode' | 'pi', provider: string): string {
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
