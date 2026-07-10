import { describe, it, expect } from 'vitest'
import type http from 'node:http'

/**
 * Tests for the proxy's placeholder-gated opencode credential injection.
 * Mirrors the relevant slice of `buildDynamicRules` in k8s/proxy/proxy.ts —
 * the proxy runs in its own container and can't be imported directly, so we
 * copy the logic under test.
 *
 * opencode is api-key only, against either OpenRouter or NeuralWatt. Injection
 * fires when the session is registered as tool=opencode AND the request host
 * matches the credential's provider host AND the inbound Authorization header
 * is the api-key Bearer placeholder. Every other combination passes through
 * unchanged.
 */

const PLACEHOLDER_API_KEY = 'yaac-ph-api-key'
const OPENROUTER_API_HOST = 'openrouter.ai'
const NEURALWATT_API_HOST = 'api.neuralwatt.com'

type OpencodeProvider = 'openrouter' | 'neuralwatt'

type Injection = { action: 'set_header'; name: string; value: string }

type InjectionRule = {
  pathPattern: string
  injections: Injection[]
}

type OpencodeCreds = { kind: 'api-key'; apiKey: string; provider: OpencodeProvider }

function opencodeProviderHost(provider: OpencodeProvider): string {
  return provider === 'neuralwatt' ? NEURALWATT_API_HOST : OPENROUTER_API_HOST
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

function buildOpencodeRules(
  sessionTool: string | undefined,
  creds: OpencodeCreds | null,
  hostname: string,
  reqHeaders: http.IncomingHttpHeaders,
): InjectionRule[] {
  if (sessionTool !== 'opencode') return []
  if (!creds) return []
  if (hostname !== opencodeProviderHost(creds.provider)) return []
  const incomingAuth = headerValue(reqHeaders, 'authorization')
  if (incomingAuth !== 'Bearer ' + PLACEHOLDER_API_KEY) return []
  return [{
    pathPattern: '*',
    injections: [{
      action: 'set_header',
      name: 'Authorization',
      value: 'Bearer ' + creds.apiKey,
    }],
  }]
}

describe('opencode credential injection gating', () => {
  const creds: OpencodeCreds = { kind: 'api-key', apiKey: 'sk-or-real', provider: 'openrouter' }
  const nwCreds: OpencodeCreds = { kind: 'api-key', apiKey: 'nw-real', provider: 'neuralwatt' }

  it('injects the OpenRouter key on openrouter.ai when the placeholder matches', () => {
    const rules = buildOpencodeRules('opencode', creds, OPENROUTER_API_HOST, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })
    expect(rules).toEqual([{
      pathPattern: '*',
      injections: [{
        action: 'set_header',
        name: 'Authorization',
        value: 'Bearer sk-or-real',
      }],
    }])
  })

  it('injects the NeuralWatt key on api.neuralwatt.com when the placeholder matches', () => {
    const rules = buildOpencodeRules('opencode', nwCreds, NEURALWATT_API_HOST, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })
    expect(rules).toEqual([{
      pathPattern: '*',
      injections: [{
        action: 'set_header',
        name: 'Authorization',
        value: 'Bearer nw-real',
      }],
    }])
  })

  it('does not inject on a host that does not match the credential provider', () => {
    // OpenRouter creds, but the request is to NeuralWatt's host.
    expect(buildOpencodeRules('opencode', creds, NEURALWATT_API_HOST, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })).toEqual([])
    // NeuralWatt creds, but the request is to OpenRouter's host.
    expect(buildOpencodeRules('opencode', nwCreds, OPENROUTER_API_HOST, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })).toEqual([])
  })

  it('does not inject when the session tool is claude', () => {
    const rules = buildOpencodeRules('claude', creds, OPENROUTER_API_HOST, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })
    expect(rules).toEqual([])
  })

  it('does not inject when the session tool is codex', () => {
    const rules = buildOpencodeRules('codex', creds, OPENROUTER_API_HOST, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })
    expect(rules).toEqual([])
  })

  it('does not inject when the session has no registered tool', () => {
    const rules = buildOpencodeRules(undefined, creds, OPENROUTER_API_HOST, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })
    expect(rules).toEqual([])
  })

  it('does not inject when Authorization carries a user-provided real key', () => {
    const rules = buildOpencodeRules('opencode', creds, OPENROUTER_API_HOST, {
      authorization: 'Bearer sk-or-user-supplied',
    })
    expect(rules).toEqual([])
  })

  it('does not inject when Authorization is absent', () => {
    const rules = buildOpencodeRules('opencode', creds, OPENROUTER_API_HOST, {})
    expect(rules).toEqual([])
  })

  it('does not inject when Authorization is empty', () => {
    const rules = buildOpencodeRules('opencode', creds, OPENROUTER_API_HOST, { authorization: '' })
    expect(rules).toEqual([])
  })

  it('requires the exact "Bearer " prefix', () => {
    const rules = buildOpencodeRules('opencode', creds, OPENROUTER_API_HOST, {
      authorization: PLACEHOLDER_API_KEY,
    })
    expect(rules).toEqual([])
  })

  it('does not inject when no opencode credentials are configured', () => {
    const rules = buildOpencodeRules('opencode', null, OPENROUTER_API_HOST, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })
    expect(rules).toEqual([])
  })
})

describe('opencodeProviderHost', () => {
  it('maps openrouter to openrouter.ai', () => {
    expect(opencodeProviderHost('openrouter')).toBe(OPENROUTER_API_HOST)
  })
  it('maps neuralwatt to api.neuralwatt.com', () => {
    expect(opencodeProviderHost('neuralwatt')).toBe(NEURALWATT_API_HOST)
  })
})
