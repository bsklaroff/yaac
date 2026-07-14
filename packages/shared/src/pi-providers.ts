/**
 * The model providers a `pi` (earendil) session can authenticate against.
 *
 * pi is api-key only in yaac (mirroring opencode): the user stores a key for
 * one provider, yaac seeds the provider's placeholder env var into the pod,
 * and the egress proxy swaps the placeholder for the real key on that
 * provider's host. pi itself supports ~25 providers; this is the curated set
 * yaac exposes in the credential picker. Adding another provider is one row —
 * the picker, placeholder-env wiring, and proxy swap all derive from here.
 *
 * The proxy (k8s/proxy) can't import this module (it imports self only), so it
 * keeps a small parallel host/header table — keep the two in sync.
 */
export type PiProvider = 'openrouter' | 'anthropic' | 'openai'

export interface PiProviderInfo {
  id: PiProvider
  /** Display label shown in the credential picker. */
  label: string
  /** Env var pi reads the API key from (seeded with the placeholder). */
  envVar: string
  /** API host the proxy swaps the placeholder key on. */
  apiHost: string
  /**
   * Which request header carries the key on `apiHost`, so the proxy knows
   * where to substitute the placeholder: `Authorization: Bearer <key>` for
   * most providers, `x-api-key: <key>` for Anthropic.
   */
  authHeader: 'bearer' | 'x-api-key'
  /**
   * Default pi `--model` value (`<provider>/<id>` form — pi resolves the
   * provider from the prefix and uses its credential). Centralized here so
   * model-id bumps live in one place. Verify against pi's current model
   * registry (models.dev) when the ids drift.
   */
  defaultModel: string
}

export const PI_PROVIDERS: readonly PiProviderInfo[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    envVar: 'OPENROUTER_API_KEY',
    apiHost: 'openrouter.ai',
    authHeader: 'bearer',
    // A cheap, fast default for the pay-per-token aggregator.
    defaultModel: 'openrouter/deepseek/deepseek-v4-flash',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    apiHost: 'api.anthropic.com',
    authHeader: 'x-api-key',
    defaultModel: 'anthropic/claude-sonnet-5',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    envVar: 'OPENAI_API_KEY',
    apiHost: 'api.openai.com',
    authHeader: 'bearer',
    // Terra is OpenAI's balanced mid-tier — same class and roughly the same
    // price as claude-sonnet-5 ($2.50/$15 vs $3/$15). Sol is the pricier
    // top-tier flagship; Luna is the cheap/fast tier.
    defaultModel: 'openai/gpt-5.6-terra',
  },
]

/** Provider selected when none is stored/chosen (picker default). */
export const PI_DEFAULT_PROVIDER: PiProvider = 'openrouter'

/** Look up a provider's metadata; falls back to the default provider. */
export function piProviderInfo(id: PiProvider): PiProviderInfo {
  return PI_PROVIDERS.find((p) => p.id === id) ?? PI_PROVIDERS[0]
}

/** The API host the proxy swaps the placeholder key on for `id`. */
export function piProviderHost(id: PiProvider): string {
  return piProviderInfo(id).apiHost
}

/**
 * Coerce a raw provider string to a PiProvider, defaulting to
 * PI_DEFAULT_PROVIDER for anything unrecognized (including undefined).
 */
export function parsePiProvider(value: string | undefined): PiProvider {
  const match = PI_PROVIDERS.find((p) => p.id === value)
  return match ? match.id : PI_DEFAULT_PROVIDER
}
