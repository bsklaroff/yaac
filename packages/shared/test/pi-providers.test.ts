import { describe, it, expect } from 'vitest'
import {
  PI_DEFAULT_PROVIDER,
  PI_PROVIDERS,
  parsePiProvider,
  piProviderHost,
  piProviderInfo,
} from '@yaac/shared/pi-providers'

describe('PI_PROVIDERS registry', () => {
  it('includes openrouter, anthropic, and openai', () => {
    expect(PI_PROVIDERS.map((p) => p.id)).toEqual(['openrouter', 'anthropic', 'openai'])
  })

  it('uses the default provider as the first entry', () => {
    expect(PI_PROVIDERS[0].id).toBe(PI_DEFAULT_PROVIDER)
  })

  it('carries a non-empty label, env var, host, and model per provider', () => {
    for (const p of PI_PROVIDERS) {
      expect(p.label.length).toBeGreaterThan(0)
      expect(p.envVar.length).toBeGreaterThan(0)
      expect(p.apiHost.length).toBeGreaterThan(0)
      expect(p.defaultModel.length).toBeGreaterThan(0)
    }
  })

  it('marks anthropic as x-api-key and the rest as bearer', () => {
    expect(piProviderInfo('anthropic').authHeader).toBe('x-api-key')
    expect(piProviderInfo('openrouter').authHeader).toBe('bearer')
    expect(piProviderInfo('openai').authHeader).toBe('bearer')
  })

  it('models start with their provider id (pi --model provider/id form)', () => {
    for (const p of PI_PROVIDERS) {
      expect(p.defaultModel.startsWith(`${p.id}/`)).toBe(true)
    }
  })
})

describe('piProviderHost', () => {
  it('maps each provider to its API host', () => {
    expect(piProviderHost('openrouter')).toBe('openrouter.ai')
    expect(piProviderHost('anthropic')).toBe('api.anthropic.com')
    expect(piProviderHost('openai')).toBe('api.openai.com')
  })
})

describe('parsePiProvider', () => {
  it('accepts known providers verbatim', () => {
    expect(parsePiProvider('openrouter')).toBe('openrouter')
    expect(parsePiProvider('anthropic')).toBe('anthropic')
    expect(parsePiProvider('openai')).toBe('openai')
  })

  it('falls back to the default for unknown or missing values', () => {
    expect(parsePiProvider(undefined)).toBe(PI_DEFAULT_PROVIDER)
    expect(parsePiProvider('')).toBe(PI_DEFAULT_PROVIDER)
    expect(parsePiProvider('neuralwatt')).toBe(PI_DEFAULT_PROVIDER)
    expect(parsePiProvider('bogus')).toBe(PI_DEFAULT_PROVIDER)
  })
})

describe('piProviderInfo', () => {
  it('returns the matching entry', () => {
    expect(piProviderInfo('anthropic').id).toBe('anthropic')
  })
})
