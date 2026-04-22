import { describe, it, expect } from 'vitest'
import type http from 'node:http'

/**
 * Tests for the proxy's placeholder-gated Anthropic credential injection.
 * Mirrors the relevant slice of `buildDynamicRules` in
 * podman/proxy-sidecar/proxy.ts — the proxy runs in its own container and
 * can't be imported directly, so we copy the logic under test.
 */

const PLACEHOLDER_ACCESS_TOKEN = 'yaac-ph-access'
const PLACEHOLDER_API_KEY = 'yaac-ph-api-key'

type Injection =
  | { action: 'set_header'; name: string; value: string }
  | { action: 'replace_header'; name: string; value: string }

type InjectionRule = {
  pathPattern: string
  injections: Injection[]
}

type ClaudeCreds =
  | { kind: 'api-key'; apiKey: string }
  | { kind: 'oauth'; bundle: { accessToken: string } }

function headerValue(
  headers: http.IncomingHttpHeaders,
  name: string,
): string | undefined {
  const v = headers[name.toLowerCase()]
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v[0]
  return undefined
}

function buildAnthropicRules(
  creds: ClaudeCreds | null,
  reqHeaders: http.IncomingHttpHeaders,
): InjectionRule[] {
  const rules: InjectionRule[] = []
  const incomingApiKey = headerValue(reqHeaders, 'x-api-key')
  const incomingAuth = headerValue(reqHeaders, 'authorization')
  if (creds && creds.kind === 'api-key' && incomingApiKey === PLACEHOLDER_API_KEY) {
    rules.push({
      pathPattern: '*',
      injections: [{ action: 'set_header', name: 'x-api-key', value: creds.apiKey }],
    })
  } else if (creds && creds.kind === 'oauth'
    && incomingAuth === 'Bearer ' + PLACEHOLDER_ACCESS_TOKEN) {
    rules.push({
      pathPattern: '*',
      injections: [{
        action: 'replace_header',
        name: 'Authorization',
        value: 'Bearer ' + creds.bundle.accessToken,
      }],
    })
  }
  return rules
}

describe('Anthropic credential injection gating', () => {
  describe('api-key mode', () => {
    const creds: ClaudeCreds = { kind: 'api-key', apiKey: 'sk-ant-real' }

    it('injects when incoming x-api-key matches the placeholder', () => {
      const rules = buildAnthropicRules(creds, { 'x-api-key': PLACEHOLDER_API_KEY })
      expect(rules).toEqual([{
        pathPattern: '*',
        injections: [{ action: 'set_header', name: 'x-api-key', value: 'sk-ant-real' }],
      }])
    })

    it('does not inject when incoming x-api-key is a user-provided real key', () => {
      const rules = buildAnthropicRules(creds, { 'x-api-key': 'sk-ant-user-supplied' })
      expect(rules).toEqual([])
    })

    it('does not inject when incoming x-api-key is absent', () => {
      const rules = buildAnthropicRules(creds, {})
      expect(rules).toEqual([])
    })

    it('does not inject when incoming x-api-key is empty', () => {
      const rules = buildAnthropicRules(creds, { 'x-api-key': '' })
      expect(rules).toEqual([])
    })

    it('does not inject when the OAuth placeholder is passed in api-key mode', () => {
      // OAuth placeholder arriving at an api-key-configured proxy is still a
      // mismatch — only the api-key placeholder gates api-key injection.
      const rules = buildAnthropicRules(creds, {
        authorization: 'Bearer ' + PLACEHOLDER_ACCESS_TOKEN,
      })
      expect(rules).toEqual([])
    })
  })

  describe('oauth mode', () => {
    const creds: ClaudeCreds = { kind: 'oauth', bundle: { accessToken: 'real-access-token' } }

    it('injects when incoming Authorization matches the Bearer placeholder', () => {
      const rules = buildAnthropicRules(creds, {
        authorization: 'Bearer ' + PLACEHOLDER_ACCESS_TOKEN,
      })
      expect(rules).toEqual([{
        pathPattern: '*',
        injections: [{
          action: 'replace_header',
          name: 'Authorization',
          value: 'Bearer real-access-token',
        }],
      }])
    })

    it('does not inject when Authorization carries a non-placeholder Bearer token', () => {
      const rules = buildAnthropicRules(creds, {
        authorization: 'Bearer sk-ant-user-bearer',
      })
      expect(rules).toEqual([])
    })

    it('does not inject when Authorization is absent', () => {
      const rules = buildAnthropicRules(creds, {})
      expect(rules).toEqual([])
    })

    it('does not inject when the api-key placeholder is passed in oauth mode', () => {
      const rules = buildAnthropicRules(creds, { 'x-api-key': PLACEHOLDER_API_KEY })
      expect(rules).toEqual([])
    })

    it('requires the exact "Bearer " prefix', () => {
      const rules = buildAnthropicRules(creds, {
        authorization: PLACEHOLDER_ACCESS_TOKEN,
      })
      expect(rules).toEqual([])
    })
  })

  describe('no credentials configured', () => {
    it('does not inject even when the placeholder is present', () => {
      const rules = buildAnthropicRules(null, { 'x-api-key': PLACEHOLDER_API_KEY })
      expect(rules).toEqual([])
    })
  })
})
