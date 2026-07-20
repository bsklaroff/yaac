/**
 * Provider registries + helpers for the api-key-only agent tools (`opencode`
 * and `pi`). The user stores an api-key for one provider; yaac seeds that
 * provider's env var into the pod with a placeholder, and the egress proxy
 * swaps the placeholder for the real key on that provider's host.
 *
 * The provider *data* is code-generated from each tool's own registry
 * (opencode → models.dev, pi → the installed pi package) into
 * `tool-providers.generated.ts` — regenerate with `pnpm gen:providers`. This
 * module adds the hand-written helpers and the runtime-validated provider
 * types on top. Adding a provider is not a code change here; it's a regen.
 *
 * The proxy (k8s/proxy) can't import this module (it bundles self-only), so it
 * carries its own generated host copy (`k8s/proxy/tool-providers.generated.ts`)
 * emitted by the same codegen — no hand-maintained parallel table.
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
 * A provider id for the corresponding tool. A runtime-validated string union
 * derived from the generated registry — regenerating widens/narrows it to
 * whatever providers the tool currently ships. Coerce raw wire strings with
 * `parseOpencodeProvider` / `parsePiProvider`.
 */
export type OpencodeProvider = OpencodeProviderId
export type PiProvider = PiProviderId

/** Provider selected when none is stored/chosen (picker default). Both tools
 *  ship OpenRouter, a pay-per-token aggregator that's a sensible default. */
export const OPENCODE_DEFAULT_PROVIDER: OpencodeProvider = 'openrouter'
export const PI_DEFAULT_PROVIDER: PiProvider = 'openrouter'

function infoOrDefault(
  list: readonly ToolProviderInfo[],
  id: string,
  defaultId: string,
): ToolProviderInfo {
  return list.find((p) => p.id === id)
    ?? list.find((p) => p.id === defaultId)
    ?? list[0]
}

function parseProvider<T extends string>(
  list: readonly ToolProviderInfo[],
  value: string | undefined,
  defaultId: T,
): T {
  return list.some((p) => p.id === value) ? (value as T) : defaultId
}

/** Look up an opencode provider's metadata; falls back to the default. */
export function opencodeProviderInfo(id: OpencodeProvider): ToolProviderInfo {
  return infoOrDefault(OPENCODE_PROVIDERS, id, OPENCODE_DEFAULT_PROVIDER)
}

/** Look up a pi provider's metadata; falls back to the default. */
export function piProviderInfo(id: PiProvider): ToolProviderInfo {
  return infoOrDefault(PI_PROVIDERS, id, PI_DEFAULT_PROVIDER)
}

/** The API host the proxy swaps the placeholder key on for an opencode provider. */
export function opencodeProviderHost(id: OpencodeProvider): string {
  return opencodeProviderInfo(id).apiHost
}

/** The API host the proxy swaps the placeholder key on for a pi provider. */
export function piProviderHost(id: PiProvider): string {
  return piProviderInfo(id).apiHost
}

/**
 * Coerce a raw provider string to an OpencodeProvider, defaulting to
 * OPENCODE_DEFAULT_PROVIDER for anything unrecognized (including undefined).
 */
export function parseOpencodeProvider(value: string | undefined): OpencodeProvider {
  return parseProvider(OPENCODE_PROVIDERS, value, OPENCODE_DEFAULT_PROVIDER)
}

/**
 * Coerce a raw provider string to a PiProvider, defaulting to
 * PI_DEFAULT_PROVIDER for anything unrecognized (including undefined).
 */
export function parsePiProvider(value: string | undefined): PiProvider {
  return parseProvider(PI_PROVIDERS, value, PI_DEFAULT_PROVIDER)
}
