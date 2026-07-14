import { describe, it, expect } from 'vitest'
import type http from 'node:http'

/**
 * Tests for the proxy's placeholder-gated pi credential injection.
 * Mirrors the relevant slice of `buildDynamicRules` in k8s/proxy/proxy.ts —
 * the proxy runs in its own container and can't be imported directly, so we
 * copy the logic under test.
 *
 * pi is api-key only, across multiple providers, and — unlike opencode — the
 * provider decides which header carries the key: OpenRouter/OpenAI use
 * `Authorization: Bearer`, Anthropic uses `x-api-key`. Injection fires when
 * the session is registered as tool=pi AND the request host matches the
 * credential's provider host AND the inbound placeholder header matches. Every
 * other combination passes through unchanged.
 */

const PLACEHOLDER_API_KEY = 'yaac-ph-api-key'
const ANTHROPIC_API_HOST = 'api.anthropic.com'
const OPENAI_API_HOST = 'api.openai.com'
const OPENROUTER_API_HOST = 'openrouter.ai'

type PiProvider = 'openrouter' | 'anthropic' | 'openai'

type Injection = { action: 'set_header'; name: string; value: string }

type InjectionRule = {
  pathPattern: string
  injections: Injection[]
}

type PiCreds = { kind: 'api-key'; apiKey: string; provider: PiProvider }

function piProviderHost(provider: PiProvider): string {
  if (provider === 'anthropic') return ANTHROPIC_API_HOST
  if (provider === 'openai') return OPENAI_API_HOST
  return OPENROUTER_API_HOST
}

function piProviderAuthHeader(provider: PiProvider): 'authorization' | 'x-api-key' {
  return provider === 'anthropic' ? 'x-api-key' : 'authorization'
}

function headerValue(
  headers: http.IncomingHttpHeaders,
  name: string,
): string | undefined {
  const v = headers[name.toLowerCase()]
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v[0]
  return undefined
}

function buildPiRules(
  sessionTool: string | undefined,
  creds: PiCreds | null,
  hostname: string,
  reqHeaders: http.IncomingHttpHeaders,
): InjectionRule[] {
  if (sessionTool !== 'pi') return []
  if (!creds) return []
  if (hostname !== piProviderHost(creds.provider)) return []
  if (piProviderAuthHeader(creds.provider) === 'x-api-key') {
    if (headerValue(reqHeaders, 'x-api-key') !== PLACEHOLDER_API_KEY) return []
    return [{ pathPattern: '*', injections: [{ action: 'set_header', name: 'x-api-key', value: creds.apiKey }] }]
  }
  if (headerValue(reqHeaders, 'authorization') !== 'Bearer ' + PLACEHOLDER_API_KEY) return []
  return [{
    pathPattern: '*',
    injections: [{ action: 'set_header', name: 'Authorization', value: 'Bearer ' + creds.apiKey }],
  }]
}

describe('pi credential injection gating', () => {
  const orCreds: PiCreds = { kind: 'api-key', apiKey: 'sk-or-real', provider: 'openrouter' }
  const anthCreds: PiCreds = { kind: 'api-key', apiKey: 'sk-ant-real', provider: 'anthropic' }
  const oaiCreds: PiCreds = { kind: 'api-key', apiKey: 'sk-oai-real', provider: 'openai' }

  it('injects the OpenRouter key as Authorization Bearer', () => {
    const rules = buildPiRules('pi', orCreds, OPENROUTER_API_HOST, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })
    expect(rules).toEqual([{
      pathPattern: '*',
      injections: [{ action: 'set_header', name: 'Authorization', value: 'Bearer sk-or-real' }],
    }])
  })

  it('injects the OpenAI key as Authorization Bearer', () => {
    const rules = buildPiRules('pi', oaiCreds, OPENAI_API_HOST, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })
    expect(rules).toEqual([{
      pathPattern: '*',
      injections: [{ action: 'set_header', name: 'Authorization', value: 'Bearer sk-oai-real' }],
    }])
  })

  it('injects the Anthropic key as x-api-key (not Authorization)', () => {
    const rules = buildPiRules('pi', anthCreds, ANTHROPIC_API_HOST, {
      'x-api-key': PLACEHOLDER_API_KEY,
    })
    expect(rules).toEqual([{
      pathPattern: '*',
      injections: [{ action: 'set_header', name: 'x-api-key', value: 'sk-ant-real' }],
    }])
  })

  it('does not inject Anthropic when the placeholder rides Authorization instead of x-api-key', () => {
    const rules = buildPiRules('pi', anthCreds, ANTHROPIC_API_HOST, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })
    expect(rules).toEqual([])
  })

  it('does not inject on a host that does not match the credential provider', () => {
    expect(buildPiRules('pi', orCreds, ANTHROPIC_API_HOST, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })).toEqual([])
    expect(buildPiRules('pi', anthCreds, OPENROUTER_API_HOST, {
      'x-api-key': PLACEHOLDER_API_KEY,
    })).toEqual([])
  })

  it('does not inject when the session tool is not pi', () => {
    expect(buildPiRules('claude', anthCreds, ANTHROPIC_API_HOST, { 'x-api-key': PLACEHOLDER_API_KEY })).toEqual([])
    expect(buildPiRules('opencode', orCreds, OPENROUTER_API_HOST, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })).toEqual([])
    expect(buildPiRules(undefined, orCreds, OPENROUTER_API_HOST, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })).toEqual([])
  })

  it('does not inject when the header carries a user-provided real key', () => {
    expect(buildPiRules('pi', orCreds, OPENROUTER_API_HOST, {
      authorization: 'Bearer sk-or-user-supplied',
    })).toEqual([])
    expect(buildPiRules('pi', anthCreds, ANTHROPIC_API_HOST, {
      'x-api-key': 'sk-ant-user-supplied',
    })).toEqual([])
  })

  it('does not inject when the placeholder header is absent', () => {
    expect(buildPiRules('pi', orCreds, OPENROUTER_API_HOST, {})).toEqual([])
    expect(buildPiRules('pi', anthCreds, ANTHROPIC_API_HOST, {})).toEqual([])
  })

  it('requires the exact "Bearer " prefix for bearer providers', () => {
    expect(buildPiRules('pi', orCreds, OPENROUTER_API_HOST, {
      authorization: PLACEHOLDER_API_KEY,
    })).toEqual([])
  })

  it('does not inject when no pi credentials are configured', () => {
    expect(buildPiRules('pi', null, OPENROUTER_API_HOST, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })).toEqual([])
  })
})

describe('piProviderHost', () => {
  it('maps each provider to its API host', () => {
    expect(piProviderHost('openrouter')).toBe(OPENROUTER_API_HOST)
    expect(piProviderHost('anthropic')).toBe(ANTHROPIC_API_HOST)
    expect(piProviderHost('openai')).toBe(OPENAI_API_HOST)
  })
})

describe('piProviderAuthHeader', () => {
  it('uses x-api-key only for anthropic', () => {
    expect(piProviderAuthHeader('anthropic')).toBe('x-api-key')
    expect(piProviderAuthHeader('openrouter')).toBe('authorization')
    expect(piProviderAuthHeader('openai')).toBe('authorization')
  })
})
