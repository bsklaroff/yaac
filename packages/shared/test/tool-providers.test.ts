import { describe, it, expect } from 'vitest'
import {
  FALLBACK_MODELS,
  OPENCODE_DEFAULT_PROVIDER,
  OPENCODE_PROVIDERS,
  PI_DEFAULT_PROVIDER,
  PI_PROVIDERS,
  opencodeProviderInfo,
  parseOpencodeProvider,
  parsePiProvider,
  piProviderInfo,
  type OpencodeProvider,
  type PiProvider,
  type ToolProviderInfo,
} from '@yaac/shared/tool-providers'
import { MODEL_NAMES, MODELS_BY_PROVIDER } from '@yaac/shared/tool-providers.generated'

// Both registries are generated (scripts/gen-tool-providers.ts), so these
// check invariants rather than a fixed list.
const REGISTRIES: Array<{ name: string; list: readonly ToolProviderInfo[]; defaultId: string; hasModel: boolean }> = [
  { name: 'opencode', list: OPENCODE_PROVIDERS, defaultId: OPENCODE_DEFAULT_PROVIDER, hasModel: false },
  { name: 'pi', list: PI_PROVIDERS, defaultId: PI_DEFAULT_PROVIDER, hasModel: true },
]

describe.each(REGISTRIES)('$name provider registry', ({ list, defaultId, hasModel }) => {
  it('is non-empty and includes the default provider', () => {
    expect(list.length).toBeGreaterThan(0)
    expect(list.some((p) => p.id === defaultId)).toBe(true)
  })

  it('has unique provider ids', () => {
    const ids = list.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('carries a non-empty label + env var and a bare host per provider', () => {
    for (const p of list) {
      expect(p.label.length).toBeGreaterThan(0)
      expect(p.envVar.length).toBeGreaterThan(0)
      // A bare hostname: no scheme, port or path.
      expect(p.apiHost).toMatch(/^[a-z0-9.-]+$/i)
      expect(p.apiHost).not.toMatch(/[/:]/)
    }
  })

  it(hasModel ? 'gives every provider a provider-prefixed default model' : 'omits default models', () => {
    for (const p of list) {
      const model = p.defaultModel
      if (hasModel) {
        expect(model).toBeDefined()
        // pi launches with `--model <provider>/<id>`, so the model must name
        // its own provider.
        expect(model?.startsWith(`${p.id}/`)).toBe(true)
      } else {
        expect(model).toBeUndefined()
      }
    }
  })
})

describe('parse*Provider', () => {
  it('accepts known providers verbatim', () => {
    expect(parsePiProvider('anthropic')).toBe('anthropic')
    expect(parseOpencodeProvider('openrouter')).toBe('openrouter')
  })

  it('drops anything unrecognized, absent, or empty — never coerces', () => {
    // The provider decides where the key is sent, so a missing one is as
    // invalid as a wrong one; callers must decide.
    expect(parsePiProvider(undefined)).toBeUndefined()
    expect(parsePiProvider('')).toBeUndefined()
    expect(parseOpencodeProvider(undefined)).toBeUndefined()
    expect(parseOpencodeProvider('bogus')).toBeUndefined()
    expect(parsePiProvider('bogus')).toBeUndefined()
  })

  it('does not cross tools — neuralwatt is an opencode provider, not a pi one', () => {
    expect(parseOpencodeProvider('neuralwatt')).toBe('neuralwatt')
    expect(parsePiProvider('neuralwatt')).toBeUndefined()
  })
})

describe('provider info + host lookup', () => {
  it('returns the matching entry', () => {
    expect(piProviderInfo('anthropic').id).toBe('anthropic')
    expect(opencodeProviderInfo('openrouter').id).toBe('openrouter')
  })

  it('falls back to the default entry for a stale/unknown id', () => {
    expect(piProviderInfo('nope' as PiProvider).id).toBe(PI_DEFAULT_PROVIDER)
    expect(opencodeProviderInfo('nope' as OpencodeProvider).id).toBe(OPENCODE_DEFAULT_PROVIDER)
  })
})

// Pinned by hand because neither CLI is pinned in the tools image. A regen
// that drops one means the vendor retired it.
describe('FALLBACK_MODELS', () => {
  it('names a model the catalog still lists for each tool', () => {
    expect(MODELS_BY_PROVIDER['anthropic']).toContain(FALLBACK_MODELS.claude)
    expect(MODELS_BY_PROVIDER['openai']).toContain(FALLBACK_MODELS.codex)
  })
})

// The picker's order and dedup are baked in at generation time.
describe('MODELS_BY_PROVIDER', () => {
  it('drops a dated snapshot whose alias is listed', () => {
    for (const ids of Object.values(MODELS_BY_PROVIDER)) {
      const listed = new Set(ids)
      for (const id of ids) {
        const alias = /^(.+)-\d{8}$/.exec(id)?.[1]
        expect(alias !== undefined && listed.has(alias), id).toBe(false)
      }
    }
  })

  it('names models without the "(latest)" an alias carries upstream', () => {
    expect(MODEL_NAMES['anthropic']?.['claude-opus-5-5']).toBe('Claude Opus 5.5')
    for (const names of Object.values(MODEL_NAMES)) {
      for (const name of Object.values(names)) expect(name).not.toContain('(latest)')
    }
  })
})
