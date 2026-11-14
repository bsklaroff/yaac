import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  DEFAULT_ALLOWED_HOSTS,
  allowlistAllows,
  hostMatchesPattern,
  missingCriticalHosts,
  repoHostToAllow,
  resolveAllowedHosts,
} from '@yaac/shared/allowed-hosts'

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

// Mirrored in k8s/proxy/test/injection.test.ts; keep the two tables equal.
const LABEL_CASES: [host: string, pattern: string, expected: boolean][] = [
  ['productionresultssa42.blob.core.windows.net', 'productionresultssa*.blob.core.windows.net', true],
  ['productionresultssa.blob.core.windows.net', 'productionresultssa*.blob.core.windows.net', true],
  ['otherstorage.blob.core.windows.net', 'productionresultssa*.blob.core.windows.net', false],
  ['productionresultssa42.evil.blob.core.windows.net', 'productionresultssa*.blob.core.windows.net', false],
  ['productionresultssa4.2.blob.core.windows.net', 'productionresultssa*.blob.core.windows.net', false],
  ['ab.example.com', 'a*b.example.com', true],
  ['axyzb.example.com', 'a*b.example.com', true],
  ['axyz.example.com', 'a*b.example.com', false],
  ['xab.example.com', '*ab.example.com', true],
  ['xa.example.com', '*ab.example.com', false],
  ['abc.example.com', 'a*b*c.example.com', true],
  ['axbyc.example.com', 'a*b*c.example.com', true],
  ['acb.example.com', 'a*b*c.example.com', false],
  ['ab.example.com', 'a*b*b.example.com', false],
  ['ProductionResultsSA42.blob.core.windows.net', 'productionresultssa*.blob.core.windows.net', false],
  ['api.example.com', '(*.example.com', false],
  ['apixyz.example.com', 'api|evil*.example.com', false],
  ['api|evilx.example.com', 'api|evil*.example.com', false],
]

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

  it.each(LABEL_CASES)('matches %s against %s: %s', (host, pattern, expected) => {
    expect(hostMatchesPattern(host, pattern)).toBe(expected)
  })

  it('answers quickly for many wildcards in one label', () => {
    const start = Date.now()
    expect(hostMatchesPattern(`${'a'.repeat(200)}.example.com`, '*a*a*a*a*a*a*b.example.com')).toBe(false)
    expect(Date.now() - start).toBeLessThan(200)
  })

  it('allows GitHub Actions blob storage by default', () => {
    expect(DEFAULT_ALLOWED_HOSTS.some((p) => hostMatchesPattern('productionresultssa199.blob.core.windows.net', p))).toBe(true)
  })

  it('rejects interior wildcard when segment count differs', () => {
    expect(hostMatchesPattern(
      'docker-images-prod.a.b.r2.cloudflarestorage.com',
      'docker-images-prod.*.r2.cloudflarestorage.com',
    )).toBe(false)
  })
})

describe('allowlistAllows', () => {
  it('allows a host the defaults, an added pattern or a wildcard covers, and no other', () => {
    expect(allowlistAllows({ hosts: [], defaults: true }, 'github.com')).toBe(true)
    expect(allowlistAllows({ hosts: [], defaults: false }, 'github.com')).toBe(false)
    expect(allowlistAllows({ hosts: ['*.example.test'], defaults: false }, 'git.example.test')).toBe(true)
    expect(allowlistAllows({ hosts: ['*'], defaults: false }, 'anything.test')).toBe(true)
    expect(allowlistAllows({ hosts: ['other.test'], defaults: true }, 'git.example.test')).toBe(false)
    expect(allowlistAllows({ hosts: ['git.example.test'], defaults: false }, 'Git.Example.test')).toBe(true)
  })
})

describe('repoHostToAllow', () => {
  it('names a remote\'s host the list leaves out, and nothing for one it admits or no literal host', () => {
    const defaults = { hosts: [], defaults: true }
    expect(repoHostToAllow(defaults, 'https://Git.Example.test/acme/x.git')).toBe('git.example.test')
    expect(repoHostToAllow(defaults, 'git@git_host.test:acme/x.git')).toBe('git_host.test')
    expect(repoHostToAllow(defaults, 'https://github.com/acme/x.git')).toBeNull()
    expect(repoHostToAllow({ hosts: ['*.example.test'], defaults: false }, 'https://git.example.test/a/b')).toBeNull()
    for (const url of ['', 'not a url', 'https://*/a/b', 'https://evil.test\\@github.com/a/b']) {
      expect(repoHostToAllow(defaults, url), url).toBeNull()
    }
  })
})

describe('resolveAllowedHosts', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const only = (hosts: string[]) => resolveAllowedHosts({ hosts, defaults: false })

  it('returns the defaults when the project adds nothing', () => {
    expect(resolveAllowedHosts({ hosts: [], defaults: true })).toEqual(DEFAULT_ALLOWED_HOSTS)
  })

  it('appends added hosts to the defaults, skipping ones already there', () => {
    const result = resolveAllowedHosts({ hosts: ['extra.example.com', 'github.com'], defaults: true })
    expect(result).toContain('api.anthropic.com')
    expect(result).toContain('extra.example.com')
    expect(result.length).toBe(DEFAULT_ALLOWED_HOSTS.length + 1)
  })

  it('returns only the added hosts with the defaults off', () => {
    const result = only(['custom.example.com'])
    expect(result).toEqual(['custom.example.com'])
    expect(result).not.toContain('api.anthropic.com')
  })

  it('keeps the other entries of a list holding *', () => {
    expect(only(['*', '100.64.0.7'])).toEqual(['*', '100.64.0.7'])
  })

  it('returns an empty list with the defaults off and nothing added', () => {
    expect(only([])).toEqual([])
  })

  it('warns when resolved list lacks api.anthropic.com', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    only(['github.com', 'api.github.com'])
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Anthropic API (api.anthropic.com)'),
    )
  })

  it('warns when resolved list lacks github.com', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    only(['api.anthropic.com'])
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('GitHub (github.com)'),
    )
  })

  it('does not warn about api.github.com', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    only(['api.anthropic.com', 'github.com'])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('does not warn when ["*"] is used', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    only(['*'])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('does not warn when defaults are used', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resolveAllowedHosts({ hosts: [], defaults: true })
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe('missingCriticalHosts', () => {
  it('names the agent hosts a list leaves out, counting the defaults, patterns and *', () => {
    expect(missingCriticalHosts({ hosts: [], defaults: true })).toEqual([])
    expect(missingCriticalHosts({ hosts: ['*'], defaults: false })).toEqual([])
    expect(missingCriticalHosts({ hosts: ['*.anthropic.com', 'api.github.com'], defaults: false }))
      .toEqual([{ host: 'github.com', label: 'GitHub' }])
  })
})
