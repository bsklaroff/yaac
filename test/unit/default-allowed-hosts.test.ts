import { describe, it, expect, vi, afterEach } from 'vitest'
import { DEFAULT_ALLOWED_HOSTS, hostMatchesPattern, resolveAllowedHosts } from '@/lib/container/default-allowed-hosts'
import type { YaacConfig } from '@/types'

describe('DEFAULT_ALLOWED_HOSTS', () => {
  it('is a non-empty array of strings', () => {
    expect(Array.isArray(DEFAULT_ALLOWED_HOSTS)).toBe(true)
    expect(DEFAULT_ALLOWED_HOSTS.length).toBeGreaterThan(100)
    for (const host of DEFAULT_ALLOWED_HOSTS) {
      expect(typeof host).toBe('string')
    }
  })

  it('includes critical hosts', () => {
    expect(DEFAULT_ALLOWED_HOSTS).toContain('api.anthropic.com')
    expect(DEFAULT_ALLOWED_HOSTS).toContain('github.com')
    expect(DEFAULT_ALLOWED_HOSTS).toContain('api.github.com')
  })
})

describe('hostMatchesPattern', () => {
  it('matches exact hostnames', () => {
    expect(hostMatchesPattern('example.com', 'example.com')).toBe(true)
  })

  it('rejects non-matching exact hostnames', () => {
    expect(hostMatchesPattern('other.com', 'example.com')).toBe(false)
  })

  it('matches leading wildcard patterns', () => {
    expect(hostMatchesPattern('foo.example.com', '*.example.com')).toBe(true)
    expect(hostMatchesPattern('bar.example.com', '*.example.com')).toBe(true)
  })

  it('rejects bare domain for leading wildcard', () => {
    expect(hostMatchesPattern('example.com', '*.example.com')).toBe(false)
  })

  it('matches interior wildcard patterns', () => {
    expect(hostMatchesPattern(
      'docker-images-prod.abc123.r2.cloudflarestorage.com',
      'docker-images-prod.*.r2.cloudflarestorage.com',
    )).toBe(true)
  })

  it('rejects interior wildcard when other segments differ', () => {
    expect(hostMatchesPattern(
      'docker-images-dev.abc123.r2.cloudflarestorage.com',
      'docker-images-prod.*.r2.cloudflarestorage.com',
    )).toBe(false)
  })

  it('rejects interior wildcard when segment count differs', () => {
    expect(hostMatchesPattern(
      'docker-images-prod.a.b.r2.cloudflarestorage.com',
      'docker-images-prod.*.r2.cloudflarestorage.com',
    )).toBe(false)
  })
})

describe('resolveAllowedHosts', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns DEFAULT_ALLOWED_HOSTS when neither field is set', () => {
    const result = resolveAllowedHosts({})
    expect(result).toBe(DEFAULT_ALLOWED_HOSTS)
  })

  it('returns setAllowedUrls when set (replaces defaults)', () => {
    const config: YaacConfig = { setAllowedUrls: ['custom.example.com'] }
    const result = resolveAllowedHosts(config)
    expect(result).toEqual(['custom.example.com'])
    expect(result).not.toContain('api.anthropic.com')
  })

  it('returns merged list when addAllowedUrls is set', () => {
    const config: YaacConfig = { addAllowedUrls: ['extra.example.com'] }
    const result = resolveAllowedHosts(config)
    expect(result).toContain('api.anthropic.com')
    expect(result).toContain('extra.example.com')
    expect(result.length).toBe(DEFAULT_ALLOWED_HOSTS.length + 1)
  })

  it('passes through ["*"] correctly', () => {
    const config: YaacConfig = { setAllowedUrls: ['*'] }
    const result = resolveAllowedHosts(config)
    expect(result).toEqual(['*'])
  })

  it('passes through empty array correctly', () => {
    const config: YaacConfig = { setAllowedUrls: [] }
    const result = resolveAllowedHosts(config)
    expect(result).toEqual([])
  })

  it('throws when both fields are set', () => {
    const config: YaacConfig = {
      addAllowedUrls: ['a.com'],
      setAllowedUrls: ['b.com'],
    }
    expect(() => resolveAllowedHosts(config)).toThrow('mutually exclusive')
  })

  it('warns when resolved list lacks api.anthropic.com', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resolveAllowedHosts({ setAllowedUrls: ['github.com', 'api.github.com'] })
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Anthropic API (api.anthropic.com)'),
    )
  })

  it('warns when resolved list lacks github.com', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resolveAllowedHosts({ setAllowedUrls: ['api.anthropic.com'] })
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('GitHub (github.com)'),
    )
  })

  it('does not warn about api.github.com', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resolveAllowedHosts({ setAllowedUrls: ['api.anthropic.com', 'github.com'] })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('does not warn when ["*"] is used', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resolveAllowedHosts({ setAllowedUrls: ['*'] })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('does not warn when defaults are used', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resolveAllowedHosts({})
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
