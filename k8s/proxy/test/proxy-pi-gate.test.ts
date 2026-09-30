import { describe, it, expect } from 'vitest'
import type http from 'node:http'
import { PI_PROVIDER_HOSTS } from 'yaac-proxy-sidecar/tool-providers.generated'

/**
 * Tests for the proxy's placeholder-gated pi credential injection, mirrored
 * from `buildDynamicRules` in k8s/proxy/proxy.ts (which can't be imported).
 * The provider→host table is the real generated one, so a regen that drops
 * or moves a host is caught here.
 *
 * The header carrying the key varies by provider (`x-api-key` or
 * `Authorization: Bearer`), so the proxy replaces the placeholder wherever
 * it appears. Injection fires only when the workspace is registered as
 * tool=pi, the host is the credential's provider host, and the placeholder
 * is present.
 */

const PLACEHOLDER_API_KEY = 'yaac-ph-api-key'

type Injection = { action: 'set_header'; name: string; value: string }

type InjectionRule = {
  pathPattern: string
  injections: Injection[]
}

type PiCreds = { kind: 'api-key'; apiKey: string; provider: string }

function headerValue(
  headers: http.IncomingHttpHeaders,
  name: string,
): string | undefined {
  const v = headers[name.toLowerCase()]
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v[0]
  return undefined
}

// Mirror of proxy.ts swapApiKeyHeader: substitute the placeholder wherever it
// appears (x-api-key first, then Authorization: Bearer).
function swapApiKeyHeader(reqHeaders: http.IncomingHttpHeaders, apiKey: string): InjectionRule[] {
  if (headerValue(reqHeaders, 'x-api-key') === PLACEHOLDER_API_KEY) {
    return [{ pathPattern: '*', injections: [{ action: 'set_header', name: 'x-api-key', value: apiKey }] }]
  }
  if (headerValue(reqHeaders, 'authorization') === 'Bearer ' + PLACEHOLDER_API_KEY) {
    return [{ pathPattern: '*', injections: [{ action: 'set_header', name: 'Authorization', value: 'Bearer ' + apiKey }] }]
  }
  return []
}

function buildPiRules(
  workspaceTool: string | undefined,
  creds: PiCreds | null,
  hostname: string,
  reqHeaders: http.IncomingHttpHeaders,
): InjectionRule[] {
  if (workspaceTool !== 'pi') return []
  if (!creds) return []
  if (hostname !== PI_PROVIDER_HOSTS[creds.provider]) return []
  return swapApiKeyHeader(reqHeaders, creds.apiKey)
}

const OPENROUTER_API_HOST = PI_PROVIDER_HOSTS['openrouter']
const ANTHROPIC_API_HOST = PI_PROVIDER_HOSTS['anthropic']
const GROQ_API_HOST = PI_PROVIDER_HOSTS['groq']

describe('pi credential injection gating', () => {
  const orCreds: PiCreds = { kind: 'api-key', apiKey: 'sk-or-real', provider: 'openrouter' }
  const anthCreds: PiCreds = { kind: 'api-key', apiKey: 'sk-ant-real', provider: 'anthropic' }
  const groqCreds: PiCreds = { kind: 'api-key', apiKey: 'gsk-real', provider: 'groq' }

  it('injects the OpenRouter key as Authorization Bearer', () => {
    const rules = buildPiRules('pi', orCreds, OPENROUTER_API_HOST, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })
    expect(rules).toEqual([{
      pathPattern: '*',
      injections: [{ action: 'set_header', name: 'Authorization', value: 'Bearer sk-or-real' }],
    }])
  })

  it('injects the Anthropic key as x-api-key (the header pi actually uses)', () => {
    const rules = buildPiRules('pi', anthCreds, ANTHROPIC_API_HOST, {
      'x-api-key': PLACEHOLDER_API_KEY,
    })
    expect(rules).toEqual([{
      pathPattern: '*',
      injections: [{ action: 'set_header', name: 'x-api-key', value: 'sk-ant-real' }],
    }])
  })

  it('injects a newly-supported provider (groq) on its generated host', () => {
    expect(GROQ_API_HOST).toBe('api.groq.com')
    const rules = buildPiRules('pi', groqCreds, GROQ_API_HOST, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })
    expect(rules).toEqual([{
      pathPattern: '*',
      injections: [{ action: 'set_header', name: 'Authorization', value: 'Bearer gsk-real' }],
    }])
  })

  it('substitutes wherever the placeholder rides — x-api-key wins when both are present', () => {
    // x-api-key takes precedence when both headers carry the placeholder.
    const rules = buildPiRules('pi', anthCreds, ANTHROPIC_API_HOST, {
      'x-api-key': PLACEHOLDER_API_KEY,
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })
    expect(rules).toEqual([{
      pathPattern: '*',
      injections: [{ action: 'set_header', name: 'x-api-key', value: 'sk-ant-real' }],
    }])
  })

  it('does not inject on a host that does not match the credential provider', () => {
    expect(buildPiRules('pi', orCreds, ANTHROPIC_API_HOST, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })).toEqual([])
    expect(buildPiRules('pi', anthCreds, OPENROUTER_API_HOST, {
      'x-api-key': PLACEHOLDER_API_KEY,
    })).toEqual([])
  })

  it('does not inject for an unknown provider (no generated host)', () => {
    const bogus: PiCreds = { kind: 'api-key', apiKey: 'x', provider: 'not-a-provider' }
    expect(buildPiRules('pi', bogus, OPENROUTER_API_HOST, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })).toEqual([])
  })

  it('does not inject when the workspace tool is not pi', () => {
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

describe('PI_PROVIDER_HOSTS (generated)', () => {
  it('maps the well-known providers to their hosts', () => {
    expect(PI_PROVIDER_HOSTS['openrouter']).toBe('openrouter.ai')
    expect(PI_PROVIDER_HOSTS['anthropic']).toBe('api.anthropic.com')
    expect(PI_PROVIDER_HOSTS['openai']).toBe('api.openai.com')
  })
})
