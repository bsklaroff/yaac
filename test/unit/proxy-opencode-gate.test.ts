import { describe, it, expect } from 'vitest'
import type http from 'node:http'

/**
 * Tests for the proxy's placeholder-gated opencode credential injection.
 * Mirrors the relevant slice of `buildDynamicRules` in
 * podman/proxy-sidecar/proxy.ts — the proxy runs in its own container
 * and can't be imported directly, so we copy the logic under test.
 *
 * opencode (OpenRouter) is api-key only. Injection fires when the
 * session is registered as tool=opencode AND the inbound Authorization
 * header is the api-key Bearer placeholder. Every other combination
 * passes through unchanged.
 */

const PLACEHOLDER_API_KEY = 'yaac-ph-api-key'

type Injection = { action: 'set_header'; name: string; value: string }

type InjectionRule = {
  pathPattern: string
  injections: Injection[]
}

type OpencodeCreds = { kind: 'api-key'; apiKey: string }

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
  reqHeaders: http.IncomingHttpHeaders,
): InjectionRule[] {
  if (sessionTool !== 'opencode') return []
  if (!creds) return []
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
  const creds: OpencodeCreds = { kind: 'api-key', apiKey: 'sk-or-real' }

  it('injects when session is opencode and Authorization matches the placeholder', () => {
    const rules = buildOpencodeRules('opencode', creds, {
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

  it('does not inject when the session tool is claude', () => {
    const rules = buildOpencodeRules('claude', creds, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })
    expect(rules).toEqual([])
  })

  it('does not inject when the session tool is codex', () => {
    const rules = buildOpencodeRules('codex', creds, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })
    expect(rules).toEqual([])
  })

  it('does not inject when the session has no registered tool', () => {
    const rules = buildOpencodeRules(undefined, creds, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })
    expect(rules).toEqual([])
  })

  it('does not inject when Authorization carries a user-provided real key', () => {
    const rules = buildOpencodeRules('opencode', creds, {
      authorization: 'Bearer sk-or-user-supplied',
    })
    expect(rules).toEqual([])
  })

  it('does not inject when Authorization is absent', () => {
    const rules = buildOpencodeRules('opencode', creds, {})
    expect(rules).toEqual([])
  })

  it('does not inject when Authorization is empty', () => {
    const rules = buildOpencodeRules('opencode', creds, { authorization: '' })
    expect(rules).toEqual([])
  })

  it('requires the exact "Bearer " prefix', () => {
    const rules = buildOpencodeRules('opencode', creds, {
      authorization: PLACEHOLDER_API_KEY,
    })
    expect(rules).toEqual([])
  })

  it('does not inject when no opencode credentials are configured', () => {
    const rules = buildOpencodeRules('opencode', null, {
      authorization: 'Bearer ' + PLACEHOLDER_API_KEY,
    })
    expect(rules).toEqual([])
  })
})
