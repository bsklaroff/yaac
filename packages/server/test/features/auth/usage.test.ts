import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  CLAUDE_PROFILE_URL,
  CLAUDE_USAGE_URL,
  CODEX_USAGE_URL,
  parseCodexPlanUsage,
  parsePlanUsageLimits,
  queryClaudePlanUsage,
  queryClaudeRateLimitTier,
  queryCodexPlanUsage,
} from '#features/auth/usage'
import type { ClaudeOAuthBundle, CodexOAuthBundle } from '@yaac/shared/types'

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

/** Trimmed copy of a real wham/usage payload (reset-credit and spend-control
 *  fields dropped; the ones kept exercise the ignore-the-rest behavior). The
 *  flattened RateLimitStatusPayload shape: plan_type + rate_limit windows. */
const CODEX_BODY = {
  plan_type: 'plus',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 42,
      limit_window_seconds: 18000, // 5h
      reset_after_seconds: 3600,
      reset_at: 1783670400,
    },
    secondary_window: {
      used_percent: 18,
      limit_window_seconds: 604800, // weekly
      reset_after_seconds: 172800,
      reset_at: 1784102400,
    },
  },
  rate_limit_reset_credits: { available_count: 0 },
}

describe('parseCodexPlanUsage', () => {
  it('normalizes the plan type and both rate-limit windows', () => {
    expect(parseCodexPlanUsage(CODEX_BODY)).toEqual({
      subscriptionType: 'plus',
      limits: [
        {
          kind: 'codex_primary',
          percent: 42,
          severity: 'normal',
          resetsAt: new Date(1783670400 * 1000).toISOString(),
          modelName: null,
          windowMinutes: 300,
        },
        {
          kind: 'codex_secondary',
          percent: 18,
          severity: 'normal',
          resetsAt: new Date(1784102400 * 1000).toISOString(),
          modelName: null,
          windowMinutes: 10080,
        },
      ],
    })
  })

  it('tolerates a missing secondary window and window/reset sub-fields', () => {
    expect(parseCodexPlanUsage({
      plan_type: 'pro',
      rate_limit: { primary_window: { used_percent: 5 } },
    })).toEqual({
      subscriptionType: 'pro',
      limits: [
        { kind: 'codex_primary', percent: 5, severity: 'normal', resetsAt: null, modelName: null, windowMinutes: null },
      ],
    })
  })

  it('reports no limits and a null plan when the rate_limit object is absent', () => {
    expect(parseCodexPlanUsage({ plan_type: null })).toEqual({ subscriptionType: null, limits: [] })
  })

  it('throws on a body without a recognizable shape', () => {
    expect(() => parseCodexPlanUsage('nope')).toThrow('unrecognized codex usage response shape')
  })
})

describe('queryCodexPlanUsage', () => {
  const fetchMock = vi.fn<typeof fetch>()

  const bundle: CodexOAuthBundle = {
    accessToken: 'ctok-123',
    refreshToken: 'cref-123',
    idTokenRawJwt: 'idtok',
    expiresAt: 1783667619085,
    lastRefresh: '2026-07-09T00:00:00.000Z',
    accountId: 'acc-abc',
  }

  /** A JWT whose payload carries the account id under the OpenAI auth claim,
   *  so the account-id header can be recovered without a stored accountId. */
  function jwtWithAccount(id: string): string {
    const payload = Buffer
      .from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: id } }))
      .toString('base64url')
    return `h.${payload}.s`
  }

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('queries wham/usage with the bearer and ChatGPT-Account-Id header', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(CODEX_BODY), { status: 200 }))

    const result = await queryCodexPlanUsage(bundle)
    expect(result).toMatchObject({ available: true, subscriptionType: 'plus', rateLimitTier: null })
    if (result.available) {
      expect(result.limits).toHaveLength(2)
      expect(result.limits[0]).toMatchObject({ kind: 'codex_primary', percent: 42, windowMinutes: 300 })
    }

    expect(fetchMock.mock.calls[0][0]).toBe(CODEX_USAGE_URL)
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer ctok-123')
    expect(headers['ChatGPT-Account-Id']).toBe('acc-abc')
  })

  it('recovers the account id from the access-token JWT when the bundle omits it', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(CODEX_BODY), { status: 200 }))
    await queryCodexPlanUsage({ ...bundle, accountId: undefined, accessToken: jwtWithAccount('acc-jwt') })
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers['ChatGPT-Account-Id']).toBe('acc-jwt')
  })

  it('omits the account-id header when neither the bundle nor the token carries one', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(CODEX_BODY), { status: 200 }))
    await queryCodexPlanUsage({ ...bundle, accountId: undefined, accessToken: 'not-a-jwt' })
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers['ChatGPT-Account-Id']).toBeUndefined()
    expect(headers['Authorization']).toBe('Bearer not-a-jwt')
  })

  it('maps 401/403 to unauthorized', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }))
    expect(await queryCodexPlanUsage(bundle)).toEqual({ available: false, reason: 'unauthorized' })
    fetchMock.mockResolvedValueOnce(new Response('', { status: 403 }))
    expect(await queryCodexPlanUsage(bundle)).toEqual({ available: false, reason: 'unauthorized' })
  })

  it('maps other upstream failures to an error with the status', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 429 }))
    expect(await queryCodexPlanUsage(bundle)).toEqual({
      available: false,
      reason: 'error',
      message: 'codex usage endpoint returned 429',
    })
  })

  it('maps network failures and unrecognized bodies to an error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND'))
    expect(await queryCodexPlanUsage(bundle)).toEqual({
      available: false,
      reason: 'error',
      message: 'getaddrinfo ENOTFOUND',
    })
    fetchMock.mockResolvedValueOnce(new Response('"nope"', { status: 200 }))
    expect(await queryCodexPlanUsage(bundle)).toEqual({
      available: false,
      reason: 'error',
      message: 'unrecognized codex usage response shape',
    })
  })
})
