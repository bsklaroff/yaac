import { describe, it, expect } from 'vitest'
import {
  OPENCODE_DEFAULT_PROVIDER,
  OPENCODE_PROVIDERS,
  PI_DEFAULT_PROVIDER,
  PI_PROVIDERS,
  opencodeProviderHost,
  opencodeProviderInfo,
  parseOpencodeProvider,
  parsePiProvider,
  piProviderHost,
  piProviderInfo,
  type OpencodeProvider,
  type PiProvider,
} from '@yaac/shared/tool-providers'

// Both registries are code-generated (scripts/gen-tool-providers.ts), so these
// assert invariants over whatever providers the tools currently ship rather
// than a hard-coded list — a regen must keep them holding.
const REGISTRIES = [
  { name: 'opencode', list: OPENCODE_PROVIDERS, defaultId: OPENCODE_DEFAULT_PROVIDER, hasModel: false },
  { name: 'pi', list: PI_PROVIDERS, defaultId: PI_DEFAULT_PROVIDER, hasModel: true },
] as const

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
      // apiHost is the bare hostname the proxy matches on — no scheme/port/path.
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
        // its own provider or pi would resolve it against the wrong backend.
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
    // The provider picks the env var the key is seeded under and the host the
    // proxy swaps it on, so a guess sends the credential to a vendor the user
    // never chose. Absent is as invalid as wrong; callers must decide.
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

  it('host matches the provider row', () => {
    expect(piProviderHost('anthropic')).toBe(piProviderInfo('anthropic').apiHost)
    expect(opencodeProviderHost('openrouter')).toBe('openrouter.ai')
  })
})
