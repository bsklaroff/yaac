import { describe, expect, it } from 'vitest'
import { isRemoteConfig, parseRemoteConfig } from '#remote-config-file'

const VALID = { url: 'https://srv.ts.net', token: 'tok', enabled: true }

describe('isRemoteConfig', () => {
  it('accepts a well-formed config', () => {
    expect(isRemoteConfig(VALID)).toBe(true)
    expect(isRemoteConfig({ ...VALID, enabled: false })).toBe(true)
  })
  it('rejects non-objects and wrong shapes', () => {
    expect(isRemoteConfig(null)).toBe(false)
    expect(isRemoteConfig('str')).toBe(false)
    expect(isRemoteConfig(42)).toBe(false)
    expect(isRemoteConfig({})).toBe(false)
    expect(isRemoteConfig({ url: 'x', token: 't' })).toBe(false)
    expect(isRemoteConfig({ url: 'x', token: 't', enabled: 'yes' })).toBe(false)
    expect(isRemoteConfig({ url: 1, token: 't', enabled: true })).toBe(false)
  })
})

describe('parseRemoteConfig', () => {
  it('parses well-formed JSON', () => {
    expect(parseRemoteConfig(JSON.stringify(VALID))).toEqual(VALID)
  })
  it('returns null for malformed JSON or wrong shapes', () => {
    expect(parseRemoteConfig('not json')).toBeNull()
    expect(parseRemoteConfig('')).toBeNull()
    expect(parseRemoteConfig('null')).toBeNull()
    expect(parseRemoteConfig('[]')).toBeNull()
    expect(parseRemoteConfig(JSON.stringify({ url: 'x' }))).toBeNull()
  })
})
