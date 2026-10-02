/**
 * Provider registries and helpers for the api-key-only agent tools
 * (`opencode` and `pi`). The user stores an api key for one provider; yaac
 * seeds that provider's env var into the pod with a placeholder, and the
 * egress proxy swaps in the real key on that provider's host.
 *
 * The provider data is generated into `tool-providers.generated.ts` by
 * `pnpm gen:providers` (scripts/gen-tool-providers.ts).
 */
import {
  OPENCODE_PROVIDERS,
  PI_PROVIDERS,
  type OpencodeProviderId,
  type PiProviderId,
  type ToolProviderInfo,
} from '#tool-providers.generated'

export { OPENCODE_PROVIDERS, PI_PROVIDERS }
export type { ToolProviderInfo }

/**
 * A provider id for the tool, from the generated registry. Parse raw
 * strings with `parseOpencodeProvider` / `parsePiProvider`.
 */
export type OpencodeProvider = OpencodeProviderId
export type PiProvider = PiProviderId

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

/** A raw string as an OpencodeProvider, or undefined if it isn't one. */
export function parseOpencodeProvider(value: string | undefined): OpencodeProvider | undefined {
  return parseProvider(OPENCODE_PROVIDERS, value)
}

/** A raw string as a PiProvider, or undefined if it isn't one. */
export function parsePiProvider(value: string | undefined): PiProvider | undefined {
  return parseProvider(PI_PROVIDERS, value)
}
