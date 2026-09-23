import { describe, it, expect } from 'vitest'
import { defaultModelFor, modelDisplayName, modelsForTool } from '#domain/auth'
import { FALLBACK_MODELS } from '@yaac/shared/tool-providers'
import {
  MODELS_BY_PROVIDER,
  PI_MODELS_BY_PROVIDER,
  PI_PROVIDER_DEFAULT_MODELS,
} from '@yaac/shared/tool-providers.generated'

describe('modelsForTool', () => {
  it('lists a vendor tool\'s models by bare id, newest first, named', () => {
    const claude = modelsForTool('claude', undefined)
    expect(claude[0]).toEqual({ id: 'claude-opus-5-5', name: 'Opus 5.5' })
    expect(claude.map((m) => m.id)).toEqual(MODELS_BY_PROVIDER['anthropic'])
    expect(modelsForTool('codex', undefined).map((m) => m.id)).toEqual(MODELS_BY_PROVIDER['openai'])
  })

  it('qualifies a provider tool\'s ids with the credential\'s provider, from its own registry', () => {
    expect(modelsForTool('opencode', 'anthropic').map((m) => m.id))
      .toEqual((MODELS_BY_PROVIDER['anthropic'] ?? []).map((m) => `anthropic/${m}`))
    expect(modelsForTool('pi', 'anthropic').map((m) => m.id))
      .toEqual((PI_MODELS_BY_PROVIDER['anthropic'] ?? []).map((m) => `anthropic/${m}`))
    // No credential, no provider — nothing to offer.
    expect(modelsForTool('opencode', undefined)).toEqual([])
  })
})

describe('defaultModelFor', () => {
  it('answers the pinned fallback for claude and codex', () => {
    expect(defaultModelFor('claude', undefined)).toBe(FALLBACK_MODELS.claude)
    expect(defaultModelFor('codex', undefined)).toBe(FALLBACK_MODELS.codex)
  })

  it('answers pi\'s own default for its provider — what it launched with before', () => {
    expect(defaultModelFor('pi', 'anthropic')).toBe(PI_PROVIDER_DEFAULT_MODELS['anthropic'])
  })

  it('borrows pi\'s default for opencode where opencode lists it, else its provider\'s newest', () => {
    // anthropic: pi's default is in opencode's (models.dev) list too.
    expect(defaultModelFor('opencode', 'anthropic')).toBe(PI_PROVIDER_DEFAULT_MODELS['anthropic'])
    // A provider pi does not know: the newest model opencode lists for it.
    const unknownToPi = Object.keys(MODELS_BY_PROVIDER)
      .find((p) => PI_PROVIDER_DEFAULT_MODELS[p] === undefined)!
    expect(defaultModelFor('opencode', unknownToPi))
      .toBe(`${unknownToPi}/${MODELS_BY_PROVIDER[unknownToPi][0]}`)
  })
})

describe('modelDisplayName', () => {
  it('names an id from the catalog its tool reads, dropping claude\'s redundant "Claude"', () => {
    expect(modelDisplayName('claude', 'claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelDisplayName('codex', 'gpt-6-sol')).toBe('GPT-6 Sol')
    // Beside "OpenCode" the vendor is not implied, so it stays.
    expect(modelDisplayName('opencode', 'anthropic/claude-opus-5-5')).toBe('Claude Opus 5.5')
  })

  it('sees through the decorations a transcript adds', () => {
    expect(modelDisplayName('claude', 'claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
    expect(modelDisplayName('claude', 'claude-opus-5-5[1m]')).toBe('Opus 5.5')
  })

  it('answers undefined for an id the catalog does not name', () => {
    expect(modelDisplayName('claude', 'claude-next')).toBeUndefined()
    expect(modelDisplayName('opencode', 'no-provider-prefix')).toBeUndefined()
    expect(modelDisplayName('pi', 'nowhere/model')).toBeUndefined()
  })
})
