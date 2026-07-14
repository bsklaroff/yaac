// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readExchangeToken, postWebSession, stripTokenFromUrl } from '#lib/webSession'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('readExchangeToken', () => {
  it('extracts the token query param', () => {
    expect(readExchangeToken('?token=abc123')).toBe('abc123')
  })

  it('returns null when absent', () => {
    expect(readExchangeToken('?foo=1')).toBeNull()
    expect(readExchangeToken('')).toBeNull()
  })
})

describe('stripTokenFromUrl', () => {
  it('removes only the token param, keeping the rest of the URL', () => {
    window.history.replaceState({}, '', '/?token=abc&project=p#h')
    stripTokenFromUrl()
    expect(window.location.search).toBe('?project=p')
    expect(window.location.hash).toBe('#h')
  })
})

describe('postWebSession', () => {
  it('returns true on 204', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 204 }) as unknown as typeof fetch
    expect(await postWebSession('token')).toBe(true)
  })

  it('returns false on a non-204 (e.g. expired token → 401)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 401 }) as unknown as typeof fetch
    expect(await postWebSession('token')).toBe(false)
  })
})
