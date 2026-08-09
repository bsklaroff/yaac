import { describe, it, expect } from 'vitest'
import type http from 'node:http'
import { OPENCODE_PROVIDER_HOSTS } from 'yaac-proxy-sidecar/tool-providers.generated'

/**
 * Tests for the proxy's placeholder-gated opencode credential injection.
 * Mirrors the relevant slice of `buildDynamicRules` in k8s/proxy/proxy.ts —
 * the proxy runs in its own container and can't be imported directly, so we
 * copy the logic under test. The provider→host table, though, is the real
 * generated one (imported), so a regen that drops/moves a host is caught here.
 *
 * opencode is api-key only, against any provider in the generated registry.
 * Injection fires when the worktree is registered as tool=opencode AND the
 * request host matches the credential's provider host AND the inbound request
 * carries the api-key placeholder (in whichever auth header the tool used).
 * Every other combination passes through unchanged.
 */

const PLACEHOLDER_API_KEY = 'yaac-ph-api-key'

type Injection = { action: 'set_header'; name: string; value: string }

type InjectionRule = {
  pathPattern: string
  injections: Injection[]
}

type OpencodeCreds = { kind: 'api-key'; apiKey: string; provider: string }

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

function buildOpencodeRules(
  worktreeTool: string | undefined,
  creds: OpencodeCreds | null,
  hostname: string,
  reqHeaders: http.IncomingHttpHeaders,
): InjectionRule[] {
  if (worktreeTool !== 'opencode') return []
  if (!creds) return []
  if (hostname !== OPENCODE_PROVIDER_HOSTS[creds.provider]) return []
  return swapApiKeyHeader(reqHeaders, creds.apiKey)
}

const OPENROUTER_API_HOST = OPENCODE_PROVIDER_HOSTS['openrouter']
const NEURALWATT_API_HOST = OPENCODE_PROVIDER_HOSTS['neuralwatt']
const GROQ_API_HOST = OPENCODE_PROVIDER_HOSTS['groq']

describe('opencode credential injection gating', () => {
  const creds: OpencodeCreds = { kind: 'api-key', apiKey: 'sk-or-real', provider: 'openrouter' }
  const nwCreds: OpencodeCreds = { kind: 'api-key', apiKey: 'nw-real', provider: 'neuralwatt' }
  const groqCreds: OpencodeCreds = { kind: 'api-key', apiKey: 'gsk-real', provider: 'groq' }

  it('injects the OpenRouter key on openrouter.ai when the placeholder matches', () => {
    const rules = buildOpencodeRules('opencode', creds, OPENROUTER_API_HOST, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })
    expect(rules).toEqual([{
      pathPattern: '*',
      injections: [{ action: 'set_header', name: 'Authorization', value: 'Bearer sk-or-real' }],
    }])
  })

  it('injects the NeuralWatt key on its host when the placeholder matches', () => {
    const rules = buildOpencodeRules('opencode', nwCreds, NEURALWATT_API_HOST, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })
    expect(rules).toEqual([{
      pathPattern: '*',
      injections: [{ action: 'set_header', name: 'Authorization', value: 'Bearer nw-real' }],
    }])
  })

  it('injects a newly-supported provider (groq) on its generated host', () => {
    expect(GROQ_API_HOST).toBe('api.groq.com')
    const rules = buildOpencodeRules('opencode', groqCreds, GROQ_API_HOST, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })
    expect(rules).toEqual([{
      pathPattern: '*',
      injections: [{ action: 'set_header', name: 'Authorization', value: 'Bearer gsk-real' }],
    }])
  })

  it('does not inject on a host that does not match the credential provider', () => {
    expect(buildOpencodeRules('opencode', creds, NEURALWATT_API_HOST, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })).toEqual([])
    expect(buildOpencodeRules('opencode', groqCreds, OPENROUTER_API_HOST, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })).toEqual([])
  })

  it('does not inject for an unknown provider (no generated host)', () => {
    const bogus: OpencodeCreds = { kind: 'api-key', apiKey: 'x', provider: 'not-a-provider' }
    expect(buildOpencodeRules('opencode', bogus, OPENROUTER_API_HOST, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })).toEqual([])
  })

  it('does not inject when the worktree tool is not opencode', () => {
    expect(buildOpencodeRules('claude', creds, OPENROUTER_API_HOST, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })).toEqual([])
    expect(buildOpencodeRules('codex', creds, OPENROUTER_API_HOST, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })).toEqual([])
    expect(buildOpencodeRules(undefined, creds, OPENROUTER_API_HOST, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })).toEqual([])
  })

  it('does not inject when Authorization carries a user-provided real key', () => {
    expect(buildOpencodeRules('opencode', creds, OPENROUTER_API_HOST, {
      authorization: 'Bearer sk-or-user-supplied',
    })).toEqual([])
  })

  it('does not inject when the placeholder header is absent or empty', () => {
    expect(buildOpencodeRules('opencode', creds, OPENROUTER_API_HOST, {})).toEqual([])
    expect(buildOpencodeRules('opencode', creds, OPENROUTER_API_HOST, { authorization: '' })).toEqual([])
  })

  it('requires the exact "Bearer " prefix', () => {
    expect(buildOpencodeRules('opencode', creds, OPENROUTER_API_HOST, {
      authorization: PLACEHOLDER_API_KEY,
    })).toEqual([])
  })

  it('does not inject when no opencode credentials are configured', () => {
    expect(buildOpencodeRules('opencode', null, OPENROUTER_API_HOST, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })).toEqual([])
  })
})

/**
 * Mirror of readOpencodeCreds' provider validation in proxy.ts. The proxy
 * re-reads the credential file itself at request time, so this guard is what
 * stops it from disagreeing with the server about whether a credential is
 * usable — and, before it existed, a file with no provider was read as
 * openrouter and the key was injected on openrouter.ai.
 */
function readCreds(file: Record<string, unknown>): OpencodeCreds | null {
  if (file.kind === 'api-key' && typeof file.apiKey === 'string' && file.apiKey) {
    const provider = typeof file.provider === 'string' ? file.provider : ''
    if (!Object.hasOwn(OPENCODE_PROVIDER_HOSTS, provider)) return null
    return { kind: 'api-key', apiKey: file.apiKey, provider }
  }
  return null
}

describe('opencode credential-file reading', () => {
  it('accepts a credential naming a provider in the registry', () => {
    expect(readCreds({ kind: 'api-key', apiKey: 'sk-or-real', provider: 'openrouter' }))
      .toEqual({ kind: 'api-key', apiKey: 'sk-or-real', provider: 'openrouter' })
  })

  it('rejects a credential with no provider instead of assuming openrouter', () => {
    // The pre-provider file shape. Defaulting it would swap this key on
    // openrouter.ai — a vendor the user never named.
    expect(readCreds({ kind: 'api-key', apiKey: 'sk-legacy' })).toBeNull()
    expect(readCreds({ kind: 'api-key', apiKey: 'sk-legacy', provider: '' })).toBeNull()
  })

  it('rejects a provider the registry no longer carries', () => {
    expect(readCreds({ kind: 'api-key', apiKey: 'sk-x', provider: 'perplexity' })).toBeNull()
  })

  it('rejects a prototype-chain key rather than reading it as a provider', () => {
    // The map is a plain object, so `MAP['constructor']` indexes to a truthy
    // inherited member — a truthiness check would accept it and report the
    // credential usable on /tools. Injection was never reachable (the swap
    // sites compare hostname === MAP[provider], and no Function equals a
    // hostname), so this is the residue that hasOwn closes.
    for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(readCreds({ kind: 'api-key', apiKey: 'sk-x', provider: key })).toBeNull()
    }
  })

  it('never treats the empty provider as a routable host', () => {
    // The property the guard leans on, asserted against the real table.
    expect(OPENCODE_PROVIDER_HOSTS['']).toBeUndefined()
  })
})

describe('OPENCODE_PROVIDER_HOSTS (generated)', () => {
  it('maps the well-known providers to their hosts', () => {
    expect(OPENCODE_PROVIDER_HOSTS['openrouter']).toBe('openrouter.ai')
    expect(OPENCODE_PROVIDER_HOSTS['anthropic']).toBe('api.anthropic.com')
    expect(OPENCODE_PROVIDER_HOSTS['openai']).toBe('api.openai.com')
  })

  it('covers many providers (the whole point of generating it)', () => {
    expect(Object.keys(OPENCODE_PROVIDER_HOSTS).length).toBeGreaterThan(50)
  })
})
