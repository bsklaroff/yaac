import { describe, it, expect } from 'vitest'
import { parseUpstreamRedirectsEnv } from '@/daemon/session-create'

describe('parseUpstreamRedirectsEnv', () => {
  it('returns undefined for missing env', () => {
    expect(parseUpstreamRedirectsEnv(undefined)).toBeUndefined()
    expect(parseUpstreamRedirectsEnv('')).toBeUndefined()
  })

  it('returns undefined for invalid JSON', () => {
    expect(parseUpstreamRedirectsEnv('not-json')).toBeUndefined()
    expect(parseUpstreamRedirectsEnv('{"unterminated')).toBeUndefined()
  })

  it('returns undefined when parsed value is not an object', () => {
    expect(parseUpstreamRedirectsEnv('42')).toBeUndefined()
    expect(parseUpstreamRedirectsEnv('null')).toBeUndefined()
    expect(parseUpstreamRedirectsEnv('"a string"')).toBeUndefined()
  })

  it('parses a single redirect without tls flag', () => {
    const result = parseUpstreamRedirectsEnv(
      JSON.stringify({ 'api.anthropic.com': { host: '10.0.0.5', port: 8080 } }),
    )
    expect(result).toEqual({
      'api.anthropic.com': { host: '10.0.0.5', port: 8080, tls: undefined },
    })
  })

  it('preserves tls boolean when provided', () => {
    const result = parseUpstreamRedirectsEnv(
      JSON.stringify({
        'api.anthropic.com': { host: '10.0.0.5', port: 8080, tls: false },
        'api.openai.com': { host: '10.0.0.5', port: 8080, tls: true },
      }),
    )
    expect(result?.['api.anthropic.com']?.tls).toBe(false)
    expect(result?.['api.openai.com']?.tls).toBe(true)
  })

  it('drops entries with non-string host or non-number port', () => {
    const result = parseUpstreamRedirectsEnv(
      JSON.stringify({
        good: { host: '10.0.0.5', port: 8080 },
        badHost: { host: 42, port: 8080 },
        badPort: { host: '10.0.0.5', port: 'eighty-eighty' },
        nullVal: null,
        numberVal: 42,
      }),
    )
    expect(result).toEqual({
      good: { host: '10.0.0.5', port: 8080, tls: undefined },
    })
  })

  it('returns undefined when every entry is invalid', () => {
    const result = parseUpstreamRedirectsEnv(
      JSON.stringify({ bad: { host: 42, port: 'nope' } }),
    )
    expect(result).toBeUndefined()
  })

  it('drops a non-boolean tls field instead of propagating it', () => {
    const result = parseUpstreamRedirectsEnv(
      JSON.stringify({
        host: { host: '10.0.0.5', port: 8080, tls: 'maybe' },
      }),
    )
    expect(result?.host?.tls).toBeUndefined()
  })
})
