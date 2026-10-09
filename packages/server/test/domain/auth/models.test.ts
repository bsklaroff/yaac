import { describe, it, expect } from 'vitest'
import { catalogModel, defaultModelFor, isCatalogModel, modelDisplayName, modelEfforts, modelsForTool } from '#domain/auth'
import { FALLBACK_MODELS } from '@yaac/shared/tool-providers'
import {
  CLAUDE_MODELS,
  EFFORTS,
  MODELS_BY_PROVIDER,
  PI_MODELS_BY_PROVIDER,
  PI_PROVIDER_DEFAULT_MODELS,
} from '@yaac/shared/tool-providers.generated'

describe('modelsForTool', () => {
  it('lists a vendor tool\'s models by bare id, newest first, named, with their effort levels', () => {
    const claude = modelsForTool('claude', undefined)
    expect(claude[0]).toEqual({ id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', efforts: EFFORTS.claude['claude-sonnet-5-5'] })
    // Only the models the pinned claude knows (docs/effort-levels.md).
    expect(claude.map((m) => m.id)).toEqual(CLAUDE_MODELS)
    expect(claude.find((m) => m.id === 'claude-opus-4-5')).not.toHaveProperty('efforts')
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

describe('isCatalogModel', () => {
  it('finds an id in the catalog its tool, and for opencode or pi its provider, offers', () => {
    expect(isCatalogModel('claude', 'claude-opus-4-5')).toBe(true)
    expect(isCatalogModel('claude', 'opus')).toBe(false)
    expect(isCatalogModel('opencode', 'anthropic/claude-opus-5-5')).toBe(true)
    expect(isCatalogModel('opencode', 'nowhere/claude-opus-5-5')).toBe(false)
    expect(isCatalogModel('pi', 'no-slash')).toBe(false)
  })
})

describe('modelEfforts', () => {
  it('looks a model up as given and through the decorations a transcript adds', () => {
    const opus = EFFORTS.claude['claude-opus-4-7']
    expect(modelEfforts('claude', 'claude-opus-4-7')).toBe(opus)
    expect(modelEfforts('claude', 'claude-opus-4-7[1m]')).toBe(opus)
    expect(modelEfforts('claude', 'claude-opus-4-7-20260101')).toBe(opus)
    expect(modelEfforts('codex', 'gpt-6-sol')?.levels).toContain('ultra')
    expect(modelEfforts('claude', 'opus')).toBeUndefined()
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

describe('catalogModel', () => {
  it('maps an adapter-only id to the catalog id its name belongs to', () => {
    // claude's ACP adapter answers in its picker's values, not in model ids.
    expect(catalogModel('claude', 'opus[1m]', 'Opus 5.5')).toBe('claude-opus-5-5')
    expect(catalogModel('claude', 'sonnet', 'Sonnet 5')).toBe('claude-sonnet-5')
  })

  it('keeps an id the catalog already names, and one no name ties to it', () => {
    expect(catalogModel('claude', 'claude-fable-5', 'Something else')).toBe('claude-fable-5')
    expect(catalogModel('claude', 'default', 'Default (recommended)')).toBe('default')
    expect(catalogModel('claude', 'opus[1m]', undefined)).toBe('opus[1m]')
    expect(catalogModel('pi', 'openrouter/moonshotai/kimi-k2.6', 'Kimi K2.6')).toBe('openrouter/moonshotai/kimi-k2.6')
  })
})
