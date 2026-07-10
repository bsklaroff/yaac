import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  CLAUDE_PROFILE_URL,
  CLAUDE_USAGE_URL,
  parsePlanUsageLimits,
  queryClaudePlanUsage,
  queryClaudeRateLimitTier,
} from '@yaac/server/lib/auth/usage'
import type { ClaudeOAuthBundle } from '@yaac/shared/types'

/** Trimmed copy of a real api/oauth/usage payload (fields we don't read kept
 *  where they exercise the ignore-the-rest behavior). */
const UPSTREAM_BODY = {
  five_hour: { utilization: 19.0, resets_at: '2026-07-10T03:49:59.538046+00:00' },
  seven_day: { utilization: 6.0, resets_at: '2026-07-15T21:59:59.538067+00:00' },
  extra_usage: { is_enabled: false },
  limits: [
    {
      kind: 'session',
      group: 'session',
      percent: 19,
      severity: 'normal',
      resets_at: '2026-07-10T03:49:59.538046+00:00',
      scope: null,
      is_active: true,
    },
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 6,
      severity: 'normal',
      resets_at: '2026-07-15T21:59:59.538067+00:00',
      scope: null,
      is_active: false,
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 11,
      severity: 'normal',
      resets_at: '2026-07-15T21:59:59.538322+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: false,
    },
  ],
  spend: { percent: 0, severity: 'normal' },
}

describe('parsePlanUsageLimits', () => {
  it('normalizes the upstream limits array', () => {
    expect(parsePlanUsageLimits(UPSTREAM_BODY)).toEqual([
      {
        kind: 'session',
        percent: 19,
        severity: 'normal',
        resetsAt: '2026-07-10T03:49:59.538046+00:00',
        modelName: null,
      },
      {
        kind: 'weekly_all',
        percent: 6,
        severity: 'normal',
        resetsAt: '2026-07-15T21:59:59.538067+00:00',
        modelName: null,
      },
      {
        kind: 'weekly_scoped',
        percent: 11,
        severity: 'normal',
        resetsAt: '2026-07-15T21:59:59.538322+00:00',
        modelName: 'Fable',
      },
    ])
  })

  it('tolerates missing resets_at and scope sub-fields', () => {
    const limits = parsePlanUsageLimits({
      limits: [
        { kind: 'session', percent: 0, severity: 'normal' },
        { kind: 'weekly_scoped', percent: 1, severity: 'normal', scope: { model: null } },
      ],
    })
    expect(limits).toEqual([
      { kind: 'session', percent: 0, severity: 'normal', resetsAt: null, modelName: null },
      { kind: 'weekly_scoped', percent: 1, severity: 'normal', resetsAt: null, modelName: null },
    ])
  })

  it('throws on a body without a recognizable limits array', () => {
    expect(() => parsePlanUsageLimits({ five_hour: { utilization: 3 } }))
      .toThrow('unrecognized usage response shape')
    expect(() => parsePlanUsageLimits('nope'))
      .toThrow('unrecognized usage response shape')
  })
})

describe('queryClaudePlanUsage', () => {
  const fetchMock = vi.fn<typeof fetch>()

  const bundle: ClaudeOAuthBundle = {
    accessToken: 'tok-123',
    refreshToken: 'ref-123',
    expiresAt: 1783667619085,
    scopes: ['user:inference'],
    subscriptionType: 'max',
  }

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('queries the usage endpoint with the OAuth bearer and beta header', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(UPSTREAM_BODY), { status: 200 }))

    const result = await queryClaudePlanUsage(bundle)
    // rateLimitTier stays null here — the server composes it in from its
    // own (once-per-credential) profile fetch.
    expect(result).toMatchObject({ available: true, subscriptionType: 'max', rateLimitTier: null })
    if (result.available) {
      expect(result.limits).toHaveLength(3)
      expect(result.limits[2]).toMatchObject({ kind: 'weekly_scoped', modelName: 'Fable' })
    }

    expect(fetchMock).toHaveBeenCalledWith(CLAUDE_USAGE_URL, expect.objectContaining({
      headers: {
        'Authorization': 'Bearer tok-123',
        'anthropic-beta': 'oauth-2025-04-20',
      },
    }))
  })

  it('reports a null subscriptionType when the bundle omits it', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(UPSTREAM_BODY), { status: 200 }))
    expect(await queryClaudePlanUsage({ ...bundle, subscriptionType: undefined }))
      .toMatchObject({ available: true, subscriptionType: null })
  })

  it('maps 401/403 to unauthorized', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }))
    expect(await queryClaudePlanUsage(bundle)).toEqual({ available: false, reason: 'unauthorized' })
    fetchMock.mockResolvedValueOnce(new Response('', { status: 403 }))
    expect(await queryClaudePlanUsage(bundle)).toEqual({ available: false, reason: 'unauthorized' })
  })

  it('maps other upstream failures to an error with the status', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 429 }))
    expect(await queryClaudePlanUsage(bundle)).toEqual({
      available: false,
      reason: 'error',
      message: 'usage endpoint returned 429',
    })
  })

  it('maps network failures to an error with the message', async () => {
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'))
    expect(await queryClaudePlanUsage(bundle)).toEqual({
      available: false,
      reason: 'error',
      message: 'getaddrinfo ENOTFOUND',
    })
  })

  it('maps an unrecognized 200 body to an error', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ surprise: true }), { status: 200 }))
    expect(await queryClaudePlanUsage(bundle)).toEqual({
      available: false,
      reason: 'error',
      message: 'unrecognized usage response shape',
    })
  })
})

describe('queryClaudeRateLimitTier', () => {
  const fetchMock = vi.fn<typeof fetch>()

  const bundle: ClaudeOAuthBundle = {
    accessToken: 'tok-123',
    refreshToken: 'ref-123',
    expiresAt: 1783667619085,
    scopes: ['user:inference'],
    subscriptionType: 'max',
  }

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('extracts the org rate-limit tier from the profile endpoint', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      account: { has_claude_max: true },
      organization: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' },
    }), { status: 200 }))

    expect(await queryClaudeRateLimitTier(bundle)).toBe('default_claude_max_20x')
    expect(fetchMock).toHaveBeenCalledWith(CLAUDE_PROFILE_URL, expect.objectContaining({
      headers: {
        'Authorization': 'Bearer tok-123',
        'anthropic-beta': 'oauth-2025-04-20',
      },
    }))
  })

  it('is null when the profile omits the tier', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ organization: {} }), { status: 200 }))
    expect(await queryClaudeRateLimitTier(bundle)).toBeNull()
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
    expect(await queryClaudeRateLimitTier(bundle)).toBeNull()
  })

  it('is null on HTTP failures, garbage bodies, and network errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }))
    expect(await queryClaudeRateLimitTier(bundle)).toBeNull()
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }))
    expect(await queryClaudeRateLimitTier(bundle)).toBeNull()
    fetchMock.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND'))
    expect(await queryClaudeRateLimitTier(bundle)).toBeNull()
  })
})
