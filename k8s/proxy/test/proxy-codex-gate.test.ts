import { describe, it, expect } from 'vitest'
import type http from 'node:http'

/**
 * Tests for the proxy's placeholder-gated Codex credential injection.
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

type CodexCreds =
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

function buildCodexRules(
  creds: CodexCreds | null,
  reqHeaders: http.IncomingHttpHeaders,
): InjectionRule[] {
  const rules: InjectionRule[] = []
  const incomingAuth = headerValue(reqHeaders, 'authorization')
  if (creds && creds.kind === 'api-key'
    && incomingAuth === 'Bearer ' + PLACEHOLDER_API_KEY) {
    rules.push({
      pathPattern: '*',
      injections: [{
        action: 'set_header',
        name: 'Authorization',
        value: 'Bearer ' + creds.apiKey,
      }],
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

describe('Codex credential injection gating', () => {
  describe('api-key mode', () => {
    const creds: CodexCreds = { kind: 'api-key', apiKey: 'sk-openai-real' }

    it('injects when incoming Authorization matches the api-key Bearer placeholder', () => {
      const rules = buildCodexRules(creds, {
        authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
      })
      expect(rules).toEqual([{
        pathPattern: '*',
        injections: [{
          action: 'set_header',
          name: 'Authorization',
          value: 'Bearer sk-openai-real',
        }],
      }])
    })

    it('does not inject when Authorization carries a user-provided real key', () => {
      const rules = buildCodexRules(creds, {
        authorization: 'Bearer sk-openai-user-supplied',
      })
      expect(rules).toEqual([])
    })

    it('does not inject when Authorization is absent', () => {
      const rules = buildCodexRules(creds, {})
      expect(rules).toEqual([])
    })

    it('does not inject when Authorization is empty', () => {
      const rules = buildCodexRules(creds, { authorization: '' })
      expect(rules).toEqual([])
    })

    it('does not inject when the OAuth placeholder is passed in api-key mode', () => {
      // OAuth placeholder arriving at an api-key-configured proxy is still a
      // mismatch — only the api-key placeholder gates api-key injection.
      const rules = buildCodexRules(creds, {
        authorization: 'Bearer ' + PLACEHOLDER_ACCESS_TOKEN,
      })
      expect(rules).toEqual([])
    })

    it('requires the exact "Bearer " prefix', () => {
      const rules = buildCodexRules(creds, {
        authorization: PLACEHOLDER_API_KEY,
      })
      expect(rules).toEqual([])
    })
  })

  describe('oauth mode', () => {
    const creds: CodexCreds = {
      kind: 'oauth',
      bundle: { accessToken: 'real-access-token' },
    }

    it('injects when incoming Authorization matches the Bearer placeholder', () => {
      const rules = buildCodexRules(creds, {
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
      const rules = buildCodexRules(creds, {
        authorization: 'Bearer user-provided-bearer',
      })
      expect(rules).toEqual([])
    })

    it('does not inject when Authorization is absent', () => {
      const rules = buildCodexRules(creds, {})
      expect(rules).toEqual([])
    })

    it('does not inject when the api-key placeholder is passed in oauth mode', () => {
      const rules = buildCodexRules(creds, {
        authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
      })
      expect(rules).toEqual([])
    })

    it('requires the exact "Bearer " prefix', () => {
      const rules = buildCodexRules(creds, {
        authorization: PLACEHOLDER_ACCESS_TOKEN,
      })
      expect(rules).toEqual([])
    })
  })

  describe('no credentials configured', () => {
    it('does not inject even when the placeholder is present', () => {
      const rules = buildCodexRules(null, {
        authorization: 'Bearer ' + PLACEHOLDER_ACCESS_TOKEN,
      })
      expect(rules).toEqual([])
    })
  })
})
