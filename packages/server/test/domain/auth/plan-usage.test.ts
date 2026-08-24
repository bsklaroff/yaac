import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// serverLog writes files — silence it.
vi.mock('#log', () => ({ serverLog: vi.fn() }))
vi.mock('#notify', () => ({ notifyWorktreeListChanged: vi.fn() }))

import { notifyWorktreeListChanged } from '#notify'
import {
  planUsageForSnapshot,
  codexPlanUsageForSnapshot,
  refreshPlanUsage,
  requestPlanUsageRefresh,
} from '#domain/auth'
import { _resetPlanUsageForTests } from '#domain/auth/plan-usage'
import { CLAUDE_PROFILE_URL, CLAUDE_USAGE_URL, CODEX_USAGE_URL } from '#domain/auth/usage'
import { CLAUDE_OAUTH_CLIENT_ID, CLAUDE_TOKEN_URL } from '#domain/auth/claude-oauth'
import { CODEX_OAUTH_CLIENT_ID, CODEX_TOKEN_URL } from '#domain/auth/codex-oauth'
import { credentialsDir, setDataDir } from '@yaac/shared/project-paths'
import {
  loadClaudeCredentialsFile,
  saveClaudeCredentialsFile,
  loadCodexCredentialsFile,
  saveCodexCredentialsFile,
  writeProjectClaudeCredentials,
  PLACEHOLDER_ACCESS_TOKEN,
  PLACEHOLDER_REFRESH_TOKEN,
} from '@yaac/shared/tool-auth'
import { installFakeWorktreeDriver, handleFixture, snapshotFixture } from '@yaac/test-utils/fake-driver'
import type { ClaudeOAuthBundle, CodexOAuthBundle } from '@yaac/shared/types'

/**
 * Every upstream call this feature makes — the two usage endpoints, Claude's
 * profile endpoint, and both OAuth token grants — is a `fetch`, so faking
 * fetch is the one boundary these tests stub. Behind it the whole feature
 * runs for real: the query wrappers, their zod normalization, the two
 * refresh grants and their JWT decoding, and the credentials-file writes.
 *
 * The endpoint URLs and client ids are imported from the modules that own
 * them so a routing typo can't silently make a test assert nothing.
 */
type Reply = () => Promise<Response>

const json = (body: unknown, init: ResponseInit = {}): Reply =>
  () => Promise.resolve(new Response(JSON.stringify(body), { status: 200, ...init }))
const text = (body: string, init: ResponseInit = {}): Reply =>
  () => Promise.resolve(new Response(body, { status: 200, ...init }))
const httpStatus = (status: number): Reply =>
  () => Promise.resolve(new Response('', { status }))
/** A fetch that rejects. `err` is deliberately `unknown` and reaches
 *  Promise.reject unwrapped: fetch can reject with a non-Error (an
 *  AbortSignal reason, say) and the engine has to surface that too, which is
 *  exactly what the lint rule below exists to prevent expressing. */
// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
const throws = (err: unknown): Reply => () => Promise.reject(err)

function fakeUpstream(): {
  install(): void
  /** Queue one-shot replies for a URL, consumed in order. */
  reply(url: string, ...replies: Reply[]): void
  /** A reply served for every call to a URL once its queue drains. */
  always(url: string, reply: Reply): void
  requestsTo(url: string): RequestInit[]
  countTo(url: string): number
  reset(): void
} {
  const seen: { url: string; init: RequestInit }[] = []
  const queued = new Map<string, Reply[]>()
  const standing = new Map<string, Reply>()
  return {
    install() {
      vi.stubGlobal('fetch', vi.fn<typeof fetch>((input, init) => {
        // `Request` stringifies to '[object Object]'; the rest (string, URL)
        // carry their own href.
        const url = input instanceof Request ? input.url : String(input)
        seen.push({ url, init: init ?? {} })
        const next = queued.get(url)?.shift() ?? standing.get(url)
        if (!next) throw new Error(`no upstream reply queued for ${url}`)
        return next()
      }))
    },
    reply(url, ...replies) {
      queued.set(url, [...(queued.get(url) ?? []), ...replies])
    },
    always(url, reply) {
      standing.set(url, reply)
    },
    requestsTo: (url) => seen.filter((c) => c.url === url).map((c) => c.init),
    countTo: (url) => seen.filter((c) => c.url === url).length,
    reset() {
      seen.length = 0
      queued.clear()
      standing.clear()
    },
  }
}

/** A reply the test resolves by hand, for asserting in-flight behavior. */
function deferredReply(): { reply: Reply; resolve: (r: Response) => void } {
  let resolve!: (r: Response) => void
  const promise = new Promise<Response>((r) => { resolve = r })
  return { reply: () => promise, resolve }
}

/** A JWT whose payload is `claims` — only the payload segment is ever read
 *  (neither module verifies these tokens). */
function jwt(claims: unknown): string {
  return `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`
}

/** Trimmed copy of a real api/oauth/usage payload; the fields we don't read
 *  are kept where they exercise the ignore-the-rest behavior. */
const CLAUDE_BODY = {
  five_hour: { utilization: 19.0, resets_at: '2026-07-10T03:49:59.538046+00:00' },
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

const CLAUDE_LIMITS = [
  {
    kind: 'session',
    percent: 19,
    severity: 'normal',
    resetsAt: '2026-07-10T03:49:59.538046+00:00',
    modelName: null,
  },
  {
    kind: 'weekly_scoped',
    percent: 11,
    severity: 'normal',
    resetsAt: '2026-07-15T21:59:59.538322+00:00',
    modelName: 'Fable',
  },
]

/** Unambiguously unexpired (2100-01-01) so a seeded token never trips the
 *  expiry pre-check unless a test overrides it. */
const FAR_FUTURE_MS = 4102444800000

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const upstream = fakeUpstream()

async function seedClaude(overrides: Partial<ClaudeOAuthBundle> = {}): Promise<void> {
  await saveClaudeCredentialsFile({
    kind: 'oauth',
    savedAt: '2026-07-09T00:00:00.000Z',
    claudeAiOauth: {
      accessToken: 'tok-123',
      refreshToken: 'ref-123',
      expiresAt: FAR_FUTURE_MS,
      scopes: ['user:inference'],
      subscriptionType: 'max',
      ...overrides,
    },
  })
}

async function seedClaudeApiKey(): Promise<void> {
  await saveClaudeCredentialsFile({
    kind: 'api-key',
    savedAt: '2026-07-09T00:00:00.000Z',
    apiKey: 'sk-ant-api03-xyz',
  })
}

async function seedCodex(overrides: Partial<CodexOAuthBundle> = {}): Promise<void> {
  await saveCodexCredentialsFile({
    kind: 'oauth',
    savedAt: '2026-07-09T00:00:00.000Z',
    codexOauth: {
      accessToken: 'ctok-123',
      refreshToken: 'cref-123',
      idTokenRawJwt: 'id-123',
      expiresAt: FAR_FUTURE_MS,
      lastRefresh: '2026-07-09T00:00:00.000Z',
      accountId: 'acc-123',
      ...overrides,
    },
  })
}

async function seedCodexApiKey(): Promise<void> {
  await saveCodexCredentialsFile({
    kind: 'api-key',
    savedAt: '2026-07-09T00:00:00.000Z',
    apiKey: 'sk-openai-xyz',
  })
}

/** Fresh data dir + engine state + upstream for each test. Date is faked so
 *  cadence assertions can travel in time while real timers keep flush()
 *  working. */
function useAuthFixture(prefix: string): () => string {
  let tmpDir = ''
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
    setDataDir(tmpDir)
    _resetPlanUsageForTests()
    upstream.reset()
    upstream.install()
    vi.mocked(notifyWorktreeListChanged).mockReset()
    vi.useFakeTimers({ toFake: ['Date'] })
    // The suite forbids refresh grants outright (vitest-setup says why: from
    // behind a worktree's proxy, any POST to a token endpoint rotates the
    // hosting install's real credential). This file is where refresh BEHAVIOR
    // is asserted, so it opts back in — safely, because `upstream.install()`
    // above has replaced `fetch` with a stub that throws on any URL it has no
    // reply queued for. Nothing here can leave the process.
    vi.stubEnv('YAAC_E2E_NO_TOKEN_REFRESH', '')
  })
  afterEach(async () => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    await fs.chmod(credentialsDir(), 0o700).catch(() => { /* dir may be gone */ })
    await fs.rm(tmpDir, { recursive: true, force: true })
  })
  return () => tmpDir
}

/** Read back what the engine actually persisted. */
async function storedClaude(): Promise<ClaudeOAuthBundle | null> {
  const f = await loadClaudeCredentialsFile()
  return f?.kind === 'oauth' ? f.claudeAiOauth : null
}

async function storedCodex(): Promise<CodexOAuthBundle | null> {
  const f = await loadCodexCredentialsFile()
  return f?.kind === 'oauth' ? f.codexOauth : null
}

describe('planUsageForSnapshot', () => {
  useAuthFixture('yaac-plan-usage-')

  it('reports the credential kind without touching upstream when it is not OAuth', async () => {
    expect(await planUsageForSnapshot()).toEqual({ available: false, reason: 'no-credentials' })
    await seedClaudeApiKey()
    expect(await planUsageForSnapshot()).toEqual({ available: false, reason: 'api-key' })
    expect(upstream.countTo(CLAUDE_USAGE_URL)).toBe(0)
  })

  it('serves the normalized upstream readout, tier included, once the first refresh lands', async () => {
    await seedClaude()
    upstream.always(CLAUDE_USAGE_URL, json(CLAUDE_BODY))
    upstream.always(CLAUDE_PROFILE_URL, json({
      account: { has_claude_max: true },
      organization: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' },
    }))

    // Nothing to show until the detached refresh completes.
    expect(await planUsageForSnapshot()).toBeNull()
    expect(notifyWorktreeListChanged).not.toHaveBeenCalled()
    await flush()

    expect(await planUsageForSnapshot()).toEqual({
      available: true,
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
      limits: CLAUDE_LIMITS,
    })
    // A landed refresh pushes a snapshot rather than waiting for the tick.
    expect(notifyWorktreeListChanged).toHaveBeenCalledTimes(1)

    // Both endpoints got the stored token as an OAuth bearer.
    for (const url of [CLAUDE_USAGE_URL, CLAUDE_PROFILE_URL]) {
      expect(upstream.requestsTo(url)[0].headers).toEqual({
        'Authorization': 'Bearer tok-123',
        'anthropic-beta': 'oauth-2025-04-20',
      })
    }

    // A later cycle re-queries usage but reuses the cached tier.
    vi.setSystemTime(Date.now() + 6 * 60_000)
    await planUsageForSnapshot()
    await flush()
    expect(upstream.countTo(CLAUDE_USAGE_URL)).toBe(2)
    expect(upstream.countTo(CLAUDE_PROFILE_URL)).toBe(1)
  })

  it('tolerates a bundle without a subscription type and limits without optional fields', async () => {
    await seedClaude({ subscriptionType: undefined })
    upstream.always(CLAUDE_PROFILE_URL, json({}))
    upstream.always(CLAUDE_USAGE_URL, json({
      limits: [
        { kind: 'session', percent: 0, severity: 'normal' },
        { kind: 'weekly_scoped', percent: 1, severity: 'normal', scope: { model: null } },
      ],
    }))

    await planUsageForSnapshot()
    await flush()
    expect(await planUsageForSnapshot()).toEqual({
      available: true,
      subscriptionType: null,
      rateLimitTier: null,
      limits: [
        { kind: 'session', percent: 0, severity: 'normal', resetsAt: null, modelName: null },
        { kind: 'weekly_scoped', percent: 1, severity: 'normal', resetsAt: null, modelName: null },
      ],
    })
  })

  it('refreshes at most once per interval', async () => {
    await seedClaude()
    upstream.always(CLAUDE_USAGE_URL, json(CLAUDE_BODY))
    upstream.always(CLAUDE_PROFILE_URL, json({}))

    await planUsageForSnapshot()
    await flush()
    // Repeated snapshot builds inside the interval reuse the value.
    await planUsageForSnapshot()
    await planUsageForSnapshot()
    expect(upstream.countTo(CLAUDE_USAGE_URL)).toBe(1)

    vi.setSystemTime(Date.now() + 5 * 60_000 + 1000)
    await planUsageForSnapshot()
    expect(upstream.countTo(CLAUDE_USAGE_URL)).toBe(2)
  })

  it('bridges transient upstream trouble with the last good result, then surfaces it', async () => {
    await seedClaude()
    upstream.always(CLAUDE_PROFILE_URL, json({}))
    upstream.reply(CLAUDE_USAGE_URL, json(CLAUDE_BODY))
    await planUsageForSnapshot()
    await flush()
    const good = await planUsageForSnapshot()

    // A rate-limited cycle inside the grace window keeps showing the readout.
    upstream.reply(CLAUDE_USAGE_URL, httpStatus(429))
    vi.setSystemTime(Date.now() + 6 * 60_000)
    await planUsageForSnapshot()
    await flush()
    expect(await planUsageForSnapshot()).toEqual(good)

    // Past the grace window the failure itself surfaces, carrying the status.
    upstream.reply(CLAUDE_USAGE_URL, httpStatus(429))
    vi.setSystemTime(Date.now() + 10 * 60_000)
    await planUsageForSnapshot()
    await flush()
    expect(await planUsageForSnapshot()).toEqual({
      available: false,
      reason: 'error',
      message: 'usage endpoint returned 429',
    })
  })

  it('reports network failures and unreadable bodies as errors', async () => {
    await seedClaude()
    upstream.always(CLAUDE_PROFILE_URL, json({}))
    const cases: [Reply, string][] = [
      [throws(new Error('getaddrinfo ENOTFOUND')), 'getaddrinfo ENOTFOUND'],
      // fetch can reject with a non-Error (an AbortSignal reason, say).
      [throws('aborted'), 'aborted'],
      [json({ surprise: true }), 'unrecognized usage response shape'],
      [text('not json'), 'Unexpected token \'o\', "not json" is not valid JSON'],
    ]
    for (const [reply, message] of cases) {
      _resetPlanUsageForTests()
      upstream.reply(CLAUDE_USAGE_URL, reply)
      await planUsageForSnapshot()
      await flush()
      expect(await planUsageForSnapshot()).toMatchObject({ available: false, reason: 'error', message })
    }
  })

  it('re-queries the org tier every cycle until the profile endpoint yields one', async () => {
    await seedClaude()
    upstream.always(CLAUDE_USAGE_URL, json(CLAUDE_BODY))
    // Each of these leaves the tier unknown, so the next cycle tries again.
    upstream.reply(
      CLAUDE_PROFILE_URL,
      json({ organization: {} }),          // no tier field
      json({}),                            // no organization at all
      json('a scalar body'),               // 200, but not the profile shape
      httpStatus(401),                     // not ok
      text('not json'),                    // unparseable body
      throws(new Error('ENOTFOUND')),      // network error
      json({ organization: { rate_limit_tier: 'default_claude_max_20x' } }),
    )

    for (let cycle = 0; cycle < 7; cycle++) {
      vi.setSystemTime(Date.now() + 6 * 60_000)
      await planUsageForSnapshot()
      await flush()
      expect(await planUsageForSnapshot()).toMatchObject({
        rateLimitTier: cycle < 6 ? null : 'default_claude_max_20x',
      })
    }
    expect(upstream.countTo(CLAUDE_PROFILE_URL)).toBe(7)

    // Once known, the tier is kept for the credential's lifetime.
    vi.setSystemTime(Date.now() + 6 * 60_000)
    await planUsageForSnapshot()
    await flush()
    expect(upstream.countTo(CLAUDE_PROFILE_URL)).toBe(7)
  })

  it('refreshes an expired token before querying, and persists the fresh bundle', async () => {
    await seedClaude({ expiresAt: Date.now() - 1000 })
    upstream.always(CLAUDE_PROFILE_URL, json({}))
    upstream.always(CLAUDE_USAGE_URL, json(CLAUDE_BODY))
    upstream.reply(CLAUDE_TOKEN_URL, json({
      access_token: 'tok-fresh',
      refresh_token: 'ref-fresh',
      expires_in: 28800,
      scope: 'user:inference user:profile',
      token_type: 'Bearer',
    }))

    const before = Date.now()
    await planUsageForSnapshot()
    await vi.waitFor(async () => expect(await planUsageForSnapshot()).toMatchObject({ available: true }))

    const [grant] = upstream.requestsTo(CLAUDE_TOKEN_URL)
    expect(grant.method).toBe('POST')
    expect(grant.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(grant.body as string)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'ref-123',
      client_id: CLAUDE_OAUTH_CLIENT_ID,
    })
    // The query used the refreshed token…
    expect(upstream.requestsTo(CLAUDE_USAGE_URL)[0].headers)
      .toMatchObject({ Authorization: 'Bearer tok-fresh' })
    // …and the bundle reached the credentials file, so sessions and the next
    // server start pick it up too.
    const stored = await storedClaude()
    expect(stored).toEqual({
      accessToken: 'tok-fresh',
      refreshToken: 'ref-fresh',
      expiresAt: expect.any(Number) as number,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
    })
    // The expiry is stamped from the grant's own lifetime when it landed.
    expect(stored?.expiresAt).toBeGreaterThanOrEqual(before + 28800 * 1000)
    expect(stored?.expiresAt).toBeLessThan(before + 28800 * 1000 + 60_000)
  })

  it('adopts a live worktree\'s refreshed token instead of rotating it out from under one', async () => {
    // The containerless case, and the whole reason credential-sync exists.
    // The agent in a running worktree refreshed its own OAuth token: the live
    // credential is in the project's tool home and the host store holds the
    // spent one. Spending it would fail, and refreshing it would rotate the
    // token the running agent is using — so the cycle must do neither.
    installFakeWorktreeDriver({
      kind: 'containerless',
      snapshot: () => snapshotFixture([handleFixture({ running: true, terminating: false })]),
    })
    await seedClaude({ expiresAt: Date.now() - 1000 })
    await writeProjectClaudeCredentials('demo', {
      accessToken: 'tok-from-worktree',
      refreshToken: 'ref-from-worktree',
      expiresAt: FAR_FUTURE_MS,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    })
    upstream.always(CLAUDE_PROFILE_URL, json({}))
    upstream.always(CLAUDE_USAGE_URL, json(CLAUDE_BODY))

    await planUsageForSnapshot()
    await vi.waitFor(async () => expect(await planUsageForSnapshot()).toMatchObject({ available: true }))

    // No grant was spent: the harvested token was already good.
    expect(upstream.countTo(CLAUDE_TOKEN_URL)).toBe(0)
    expect(upstream.requestsTo(CLAUDE_USAGE_URL).at(-1)?.headers)
      .toMatchObject({ Authorization: 'Bearer tok-from-worktree' })
    // …and the host store caught up, so the next reader is not stale either.
    expect(await storedClaude()).toMatchObject({
      accessToken: 'tok-from-worktree',
      refreshToken: 'ref-from-worktree',
    })
  })

  it('holds off refreshing entirely while an unmediated workspace is live', async () => {
    // Same posture, but nothing has been refreshed anywhere: the stored token
    // is expired and there is no fresher one to adopt. The host STILL must not
    // refresh, because the rotation would invalidate the copy the running
    // agent holds — it refreshes on its own schedule, and that is the one that
    // counts. A missing usage readout is the acceptable cost.
    installFakeWorktreeDriver({
      kind: 'containerless',
      snapshot: () => snapshotFixture([handleFixture({ running: true })]),
    })
    await seedClaude({ expiresAt: Date.now() - 1000 })
    upstream.always(CLAUDE_PROFILE_URL, json({}))
    upstream.always(CLAUDE_USAGE_URL, httpStatus(401))

    await planUsageForSnapshot()
    await vi.waitFor(async () => expect(await planUsageForSnapshot()).toMatchObject({ available: false }))

    expect(upstream.countTo(CLAUDE_TOKEN_URL)).toBe(0)
    expect(await storedClaude()).toMatchObject({ accessToken: 'tok-123', refreshToken: 'ref-123' })
  })

  it('never spends a placeholder refresh token, however expired the bundle looks', async () => {
    // The chained yaac-in-yaac shape: this install's stored credential IS the
    // sentinel an outer install swaps on the way out, so the real token
    // belongs to that install. Presenting it would make the outer proxy
    // substitute the real refresh token and rotate it — while this server
    // gets sentinels back and stores nothing, leaving the outer holding a
    // spent token and every worktree on it signed out.
    await seedClaude({
      accessToken: PLACEHOLDER_ACCESS_TOKEN,
      refreshToken: PLACEHOLDER_REFRESH_TOKEN,
      expiresAt: Date.now() - 1000,
    })
    upstream.always(CLAUDE_PROFILE_URL, json({}))
    upstream.always(CLAUDE_USAGE_URL, json(CLAUDE_BODY))

    await planUsageForSnapshot()
    await vi.waitFor(async () => expect(await planUsageForSnapshot()).toMatchObject({ available: true }))

    // No grant left this process, and the stored sentinel is untouched.
    expect(upstream.countTo(CLAUDE_TOKEN_URL)).toBe(0)
    expect(await storedClaude()).toMatchObject({
      accessToken: PLACEHOLDER_ACCESS_TOKEN,
      refreshToken: PLACEHOLDER_REFRESH_TOKEN,
    })
  })

  it('makes every grant a no-op while the suite-wide refresh block is set', async () => {
    // The blanket guard the whole suite runs under, asserted rather than
    // assumed: with it set, an expired bundle holding a perfectly real-looking
    // refresh token still sends nothing. This is what stops a future fixture
    // from rotating the credential of whatever install hosts the test run.
    vi.stubEnv('YAAC_E2E_NO_TOKEN_REFRESH', '1')
    await seedClaude({ expiresAt: Date.now() - 1000 })
    upstream.always(CLAUDE_PROFILE_URL, json({}))
    upstream.always(CLAUDE_USAGE_URL, json(CLAUDE_BODY))

    await planUsageForSnapshot()
    await vi.waitFor(async () => expect(await planUsageForSnapshot()).toMatchObject({ available: true }))

    expect(upstream.countTo(CLAUDE_TOKEN_URL)).toBe(0)
    expect(await storedClaude()).toMatchObject({ accessToken: 'tok-123', refreshToken: 'ref-123' })
  })

  it('keeps a rotation it won even when another writer moved the file mid-flight', async () => {
    // Losing the compare-and-set must not mean dropping the rotation. The
    // grant already SPENT the token we started from, so discarding its
    // replacement because the file moved leaves the install holding something
    // nothing can refresh — a permanent logout rather than a lost cycle.
    await seedClaude({ expiresAt: Date.now() - 1000 })
    upstream.always(CLAUDE_PROFILE_URL, json({}))
    upstream.always(CLAUDE_USAGE_URL, json(CLAUDE_BODY))
    upstream.reply(CLAUDE_TOKEN_URL, async () => {
      // Another writer lands while the grant is in flight, holding an OLDER
      // credential than the one we are about to receive.
      await saveClaudeCredentialsFile({
        kind: 'oauth',
        savedAt: '2026-07-09T00:00:00.000Z',
        claudeAiOauth: {
          accessToken: 'tok-other', refreshToken: 'ref-other',
          expiresAt: Date.now() - 500, scopes: ['user:inference'], subscriptionType: 'max',
        },
      })
      return new Response(JSON.stringify({
        access_token: 'tok-fresh', refresh_token: 'ref-fresh', expires_in: 28800,
      }), { status: 200 })
    })

    await planUsageForSnapshot()
    await vi.waitFor(async () => expect(await planUsageForSnapshot()).toMatchObject({ available: true }))

    expect(await storedClaude()).toMatchObject({
      accessToken: 'tok-fresh', refreshToken: 'ref-fresh',
    })
  })

  it('yields to a writer that stored something genuinely newer', async () => {
    // The other half of the tie-break: a fresh login (or a session's later
    // rotation) landing mid-flight outranks ours and is not clobbered.
    await seedClaude({ expiresAt: Date.now() - 1000 })
    upstream.always(CLAUDE_PROFILE_URL, json({}))
    upstream.always(CLAUDE_USAGE_URL, json(CLAUDE_BODY))
    upstream.reply(CLAUDE_TOKEN_URL, async () => {
      await saveClaudeCredentialsFile({
        kind: 'oauth',
        savedAt: '2026-07-09T00:00:00.000Z',
        claudeAiOauth: {
          accessToken: 'tok-newer-login', refreshToken: 'ref-newer-login',
          expiresAt: FAR_FUTURE_MS, scopes: ['user:inference'], subscriptionType: 'max',
        },
      })
      return new Response(JSON.stringify({
        access_token: 'tok-fresh', refresh_token: 'ref-fresh', expires_in: 28800,
      }), { status: 200 })
    })

    await planUsageForSnapshot()
    await vi.waitFor(async () => expect(await planUsageForSnapshot()).toMatchObject({ available: true }))

    expect(await storedClaude()).toMatchObject({ accessToken: 'tok-newer-login' })
  })

  it('keeps the stored fields a grant response omits', async () => {
    const expiredAt = Date.now() - 1000
    await seedClaude({ expiresAt: expiredAt })
    upstream.always(CLAUDE_PROFILE_URL, json({}))
    upstream.always(CLAUDE_USAGE_URL, json(CLAUDE_BODY))
    upstream.reply(CLAUDE_TOKEN_URL, json({ access_token: 'tok-fresh' }))

    await planUsageForSnapshot()
    await vi.waitFor(async () => expect(await planUsageForSnapshot()).toMatchObject({ available: true }))

    expect(await storedClaude()).toEqual({
      accessToken: 'tok-fresh',
      refreshToken: 'ref-123',
      expiresAt: expiredAt,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    })
  })

  it('queries with the stored token when the proactive refresh cannot produce one', async () => {
    upstream.always(CLAUDE_PROFILE_URL, json({}))
    upstream.always(CLAUDE_USAGE_URL, json(CLAUDE_BODY))

    // A bundle saved from a bare access token has nothing to present.
    await seedClaude({ expiresAt: Date.now() - 1000, refreshToken: '' })
    await planUsageForSnapshot()
    await vi.waitFor(async () => expect(await planUsageForSnapshot()).toMatchObject({ available: true }))
    expect(upstream.countTo(CLAUDE_TOKEN_URL)).toBe(0)

    // Every way a grant can fail is one refresh attempt and no more.
    const failures: Reply[] = [
      httpStatus(400),                              // rejected grant
      json({ error: 'invalid_grant' }),             // 200 without an access token
      text('not json'),                             // unreadable body
      throws(new Error('getaddrinfo ENOTFOUND')),   // network error
    ]
    for (const failure of failures) {
      _resetPlanUsageForTests()
      await seedClaude({ expiresAt: Date.now() - 1000 })
      upstream.reply(CLAUDE_TOKEN_URL, failure)
      const before = upstream.countTo(CLAUDE_TOKEN_URL)
      await planUsageForSnapshot()
      await vi.waitFor(async () => expect(await planUsageForSnapshot()).toMatchObject({ available: true }))
      expect(upstream.countTo(CLAUDE_TOKEN_URL)).toBe(before + 1)
      // The stale token still served the query, and stayed on disk.
      expect(upstream.requestsTo(CLAUDE_USAGE_URL).at(-1)?.headers)
        .toMatchObject({ Authorization: 'Bearer tok-123' })
      expect(await storedClaude()).toMatchObject({ accessToken: 'tok-123' })
    }
  })

  it('refreshes and retries once when an unexpired token comes back unauthorized', async () => {
    await seedClaude()
    upstream.always(CLAUDE_USAGE_URL, json(CLAUDE_BODY))
    upstream.always(CLAUDE_TOKEN_URL, json({ access_token: 'tok-fresh' }))

    // The tier landed on the first attempt, so the retry reuses it.
    upstream.reply(CLAUDE_USAGE_URL, httpStatus(401))
    upstream.reply(CLAUDE_PROFILE_URL, json({ organization: { rate_limit_tier: 'default_claude_max_5x' } }))
    await planUsageForSnapshot()
    await vi.waitFor(async () => expect(await planUsageForSnapshot()).toMatchObject({
      available: true,
      rateLimitTier: 'default_claude_max_5x',
    }))
    expect(upstream.countTo(CLAUDE_PROFILE_URL)).toBe(1)
    expect(upstream.countTo(CLAUDE_TOKEN_URL)).toBe(1)
    expect(await storedClaude()).toMatchObject({ accessToken: 'tok-fresh' })

    // With no tier yet, the retry re-queries the profile alongside usage.
    _resetPlanUsageForTests()
    await seedClaude()
    upstream.reply(CLAUDE_USAGE_URL, httpStatus(403))
    upstream.reply(CLAUDE_PROFILE_URL, json({}), json({ organization: { rate_limit_tier: 'default_claude_max_20x' } }))
    await planUsageForSnapshot()
    await vi.waitFor(async () => expect(await planUsageForSnapshot()).toMatchObject({
      available: true,
      rateLimitTier: 'default_claude_max_20x',
    }))
    expect(upstream.countTo(CLAUDE_PROFILE_URL)).toBe(3)
  })

  it('surfaces the unauthorized result when the reactive refresh fails', async () => {
    await seedClaude()
    upstream.always(CLAUDE_PROFILE_URL, json({}))
    upstream.reply(CLAUDE_USAGE_URL, httpStatus(401))
    upstream.reply(CLAUDE_TOKEN_URL, httpStatus(400))

    await planUsageForSnapshot()
    await vi.waitFor(async () => expect(await planUsageForSnapshot())
      .toEqual({ available: false, reason: 'unauthorized' }))
    // One grant attempt, one usage query — no retry without a fresh bundle.
    expect(upstream.countTo(CLAUDE_TOKEN_URL)).toBe(1)
    expect(upstream.countTo(CLAUDE_USAGE_URL)).toBe(1)
  })

  it('does not clobber a credential replaced while the refresh was in flight', async () => {
    await seedClaude({ expiresAt: Date.now() - 1000 })
    upstream.always(CLAUDE_PROFILE_URL, json({}))
    upstream.always(CLAUDE_USAGE_URL, json(CLAUDE_BODY))
    upstream.reply(CLAUDE_TOKEN_URL, async () => {
      // Another writer lands first (a session refresh captured by the proxy,
      // or `yaac auth update`).
      await seedClaude({ accessToken: 'tok-other', refreshToken: 'ref-other' })
      return new Response(JSON.stringify({ access_token: 'tok-fresh' }), { status: 200 })
    })

    await planUsageForSnapshot()
    await vi.waitFor(async () => expect(await planUsageForSnapshot()).toMatchObject({ available: true }))

    // The query still used our fresh token, but the other writer's credential
    // stayed on disk.
    expect(upstream.requestsTo(CLAUDE_USAGE_URL)[0].headers)
      .toMatchObject({ Authorization: 'Bearer tok-fresh' })
    expect(await storedClaude()).toMatchObject({ accessToken: 'tok-other' })
  })

  it('keeps serving usage when the refreshed bundle cannot be persisted', async () => {
    await seedClaude({ expiresAt: Date.now() - 1000 })
    upstream.always(CLAUDE_PROFILE_URL, json({}))
    upstream.always(CLAUDE_USAGE_URL, json(CLAUDE_BODY))
    upstream.reply(CLAUDE_TOKEN_URL, json({ access_token: 'tok-fresh' }))
    // Read-only credentials dir: the load still works, the atomic write does
    // not. A lost persist must not wedge the refresh loop.
    await fs.chmod(credentialsDir(), 0o500)

    await planUsageForSnapshot()
    await vi.waitFor(async () => expect(await planUsageForSnapshot()).toMatchObject({ available: true }))

    expect(upstream.requestsTo(CLAUDE_USAGE_URL)[0].headers)
      .toMatchObject({ Authorization: 'Bearer tok-fresh' })
    expect(await storedClaude()).toMatchObject({ accessToken: 'tok-123' })
  })

  it('drops state on credential change, discarding an in-flight refresh', async () => {
    await seedClaude()
    upstream.always(CLAUDE_PROFILE_URL, json({}))
    const pending = deferredReply()
    upstream.reply(CLAUDE_USAGE_URL, pending.reply)
    expect(await planUsageForSnapshot()).toBeNull() // refresh now in flight

    // The credential flips to api-key while the query is still pending.
    await seedClaudeApiKey()
    expect(await planUsageForSnapshot()).toEqual({ available: false, reason: 'api-key' })

    // The stale in-flight result must not resurface after switching back.
    pending.resolve(new Response(JSON.stringify(CLAUDE_BODY), { status: 200 }))
    await flush()
    await seedClaude()
    upstream.reply(CLAUDE_USAGE_URL, json(CLAUDE_BODY))
    expect(await planUsageForSnapshot()).toBeNull()
    await flush()
    expect(await planUsageForSnapshot()).toMatchObject({ available: true, limits: CLAUDE_LIMITS })
  })
})

/** Trimmed copy of a real wham/usage payload; the flattened
 *  RateLimitStatusPayload shape is plan_type + the two rate_limit windows. */
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

const CODEX_LIMITS = [
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
]

describe('codexPlanUsageForSnapshot', () => {
  useAuthFixture('yaac-codex-usage-')

  it('omits Codex entirely without ChatGPT credentials, never touching upstream', async () => {
    expect(await codexPlanUsageForSnapshot()).toBeNull()
    await seedCodexApiKey()
    expect(await codexPlanUsageForSnapshot()).toBeNull()
    expect(upstream.countTo(CODEX_USAGE_URL)).toBe(0)
  })

  it('serves the normalized wham/usage readout with the account-id header', async () => {
    await seedCodex()
    upstream.always(CODEX_USAGE_URL, json(CODEX_BODY))

    expect(await codexPlanUsageForSnapshot()).toBeNull()
    await flush()
    expect(await codexPlanUsageForSnapshot()).toEqual({
      available: true,
      subscriptionType: 'plus',
      rateLimitTier: null,
      limits: CODEX_LIMITS,
    })
    expect(notifyWorktreeListChanged).toHaveBeenCalledTimes(1)
    expect(upstream.requestsTo(CODEX_USAGE_URL)[0].headers).toEqual({
      'Authorization': 'Bearer ctok-123',
      'User-Agent': 'codex-cli',
      'ChatGPT-Account-Id': 'acc-123',
    })
  })

  it('recovers the account id from the access-token JWT, and omits the header without one', async () => {
    upstream.always(CODEX_USAGE_URL, json(CODEX_BODY))
    const cases: [string, string | undefined][] = [
      [jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-jwt' } }), 'acc-jwt'],
      [jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 42 } }), undefined],
      [jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: '' } }), undefined],
      [jwt({ 'https://api.openai.com/auth': 'not-an-object' }), undefined],
      [jwt({ sub: 'no-auth-claim' }), undefined],
      [jwt('a bare string payload'), undefined],
      ['not-a-jwt', undefined],                 // no payload segment at all
      ['h.@@not-base64@@.s', undefined],        // payload segment is garbage
    ]
    for (const [accessToken, expected] of cases) {
      _resetPlanUsageForTests()
      await seedCodex({ accessToken, accountId: undefined })
      await codexPlanUsageForSnapshot()
      await flush()
      const headers = upstream.requestsTo(CODEX_USAGE_URL).at(-1)?.headers as Record<string, string>
      expect(headers['Authorization']).toBe(`Bearer ${accessToken}`)
      expect(headers['ChatGPT-Account-Id']).toBe(expected)
    }
  })

  it('tolerates a missing secondary window, missing sub-fields, and no rate_limit at all', async () => {
    await seedCodex()
    upstream.reply(CODEX_USAGE_URL, json({
      plan_type: 'pro',
      rate_limit: { primary_window: { used_percent: 5 } },
    }))
    await codexPlanUsageForSnapshot()
    await flush()
    expect(await codexPlanUsageForSnapshot()).toEqual({
      available: true,
      subscriptionType: 'pro',
      rateLimitTier: null,
      limits: [
        { kind: 'codex_primary', percent: 5, severity: 'normal', resetsAt: null, modelName: null, windowMinutes: null },
      ],
    })

    _resetPlanUsageForTests()
    upstream.reply(CODEX_USAGE_URL, json({ plan_type: null }))
    await codexPlanUsageForSnapshot()
    await flush()
    expect(await codexPlanUsageForSnapshot()).toEqual({
      available: true,
      subscriptionType: null,
      rateLimitTier: null,
      limits: [],
    })
  })

  it('reports upstream failures as errors, keeping the shape Claude uses', async () => {
    await seedCodex()
    const cases: [Reply, string][] = [
      [httpStatus(429), 'codex usage endpoint returned 429'],
      [throws(new Error('getaddrinfo ENOTFOUND')), 'getaddrinfo ENOTFOUND'],
      [throws('aborted'), 'aborted'],
      [text('"nope"'), 'unrecognized codex usage response shape'],
    ]
    for (const [reply, message] of cases) {
      _resetPlanUsageForTests()
      upstream.reply(CODEX_USAGE_URL, reply)
      await codexPlanUsageForSnapshot()
      await flush()
      expect(await codexPlanUsageForSnapshot())
        .toMatchObject({ available: false, reason: 'error', message })
    }
  })

  it('never refreshes proactively, only reactively on an unauthorized query', async () => {
    // Unlike Claude, Codex queries with the stored token even when it looks
    // expired — its refresh tokens rotate, so a speculative grant would race
    // a running session's own refresh.
    await seedCodex({ expiresAt: Date.now() - 1000 })
    upstream.reply(CODEX_USAGE_URL, json(CODEX_BODY))
    await codexPlanUsageForSnapshot()
    await vi.waitFor(async () => expect(await codexPlanUsageForSnapshot()).toMatchObject({ available: true }))
    expect(upstream.countTo(CODEX_TOKEN_URL)).toBe(0)
    expect(upstream.requestsTo(CODEX_USAGE_URL)[0].headers)
      .toMatchObject({ Authorization: 'Bearer ctok-123' })
  })

  it('refreshes on a 401, retries once, and persists the rotated bundle', async () => {
    await seedCodex()
    const exp = Math.floor(Date.now() / 1000) + 3600
    upstream.reply(CODEX_USAGE_URL, httpStatus(401), json(CODEX_BODY))
    upstream.reply(CODEX_TOKEN_URL, json({
      access_token: jwt({ exp }),
      refresh_token: 'cref-fresh',
      id_token: 'id-fresh',
    }))

    await codexPlanUsageForSnapshot()
    await vi.waitFor(async () => expect(await codexPlanUsageForSnapshot()).toMatchObject({ available: true }))

    const [grant] = upstream.requestsTo(CODEX_TOKEN_URL)
    expect(grant.method).toBe('POST')
    expect(JSON.parse(grant.body as string)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'cref-123',
      client_id: CODEX_OAUTH_CLIENT_ID,
    })
    expect(upstream.requestsTo(CODEX_USAGE_URL).at(-1)?.headers)
      .toMatchObject({ Authorization: `Bearer ${jwt({ exp })}` })
    // Expiry comes from the new token's own `exp` claim.
    expect(await storedCodex()).toMatchObject({
      accessToken: jwt({ exp }),
      refreshToken: 'cref-fresh',
      idTokenRawJwt: 'id-fresh',
      expiresAt: exp * 1000,
      accountId: 'acc-123',
    })
  })

  it('keeps stored tokens the grant omits and falls back to the 28-day window', async () => {
    upstream.always(CODEX_USAGE_URL, json(CODEX_BODY))
    // Every access token here lacks a decodable `exp`, so the bundle takes
    // Codex's own proactive-refresh window instead.
    for (const accessToken of [
      'not-a-jwt',                    // no payload segment
      'h.@@not-base64@@.s',           // payload segment is garbage
      jwt(123),                       // payload is not an object
      jwt({ exp: 'soon' }),           // exp is not a number
      jwt({ exp: Infinity }),         // exp is not finite
    ]) {
      _resetPlanUsageForTests()
      await seedCodex()
      upstream.reply(CODEX_USAGE_URL, httpStatus(401))
      upstream.reply(CODEX_TOKEN_URL, json({ access_token: accessToken }))
      const before = Date.now()

      await codexPlanUsageForSnapshot()
      await vi.waitFor(async () => expect(await codexPlanUsageForSnapshot()).toMatchObject({ available: true }))

      const stored = await storedCodex()
      expect(stored).toMatchObject({
        accessToken,
        refreshToken: 'cref-123',     // grant omitted it: stored value kept
        idTokenRawJwt: 'id-123',      // ditto
      })
      expect(stored?.expiresAt).toBeGreaterThan(before + 27 * 24 * 60 * 60 * 1000)
      expect(new Date(stored?.lastRefresh ?? 0).getTime()).toBeGreaterThanOrEqual(before)
    }
  })

  it('surfaces the unauthorized result when the reactive grant fails', async () => {
    for (const failure of [
      httpStatus(400),                              // rejected grant
      text('"nope"'),                               // 200 with a scalar body
      json({ refresh_token: 'x' }),                 // 200 without an access token
      throws(new Error('getaddrinfo ENOTFOUND')),   // network error
    ]) {
      _resetPlanUsageForTests()
      await seedCodex()
      upstream.reply(CODEX_USAGE_URL, httpStatus(403))
      upstream.reply(CODEX_TOKEN_URL, failure)
      const before = upstream.countTo(CODEX_USAGE_URL)

      await codexPlanUsageForSnapshot()
      await vi.waitFor(async () => expect(await codexPlanUsageForSnapshot())
        .toEqual({ available: false, reason: 'unauthorized' }))
      // No fresh bundle, so no retry — and the stored one is untouched.
      expect(upstream.countTo(CODEX_USAGE_URL)).toBe(before + 1)
      expect(await storedCodex()).toMatchObject({ accessToken: 'ctok-123' })
    }
  })

  it('resolves a codex credential replaced mid-flight by which rotation is newer', async () => {
    // Codex refresh tokens are single-use, so this tie-break is load-bearing:
    // the grant below already spent the stored token, and dropping the
    // replacement because the file moved would leave the install holding
    // something nothing can refresh. `lastRefresh` is the discriminator, and
    // ours is stamped now — later than the writer that landed mid-flight.
    await seedCodex()
    upstream.reply(CODEX_USAGE_URL, httpStatus(401), json(CODEX_BODY))
    upstream.reply(CODEX_TOKEN_URL, async () => {
      await seedCodex({ accessToken: 'ctok-other', refreshToken: 'cref-other' })
      return new Response(JSON.stringify({ access_token: 'ctok-fresh' }), { status: 200 })
    })

    await codexPlanUsageForSnapshot()
    await vi.waitFor(async () => expect(await codexPlanUsageForSnapshot()).toMatchObject({ available: true }))

    expect(upstream.requestsTo(CODEX_USAGE_URL).at(-1)?.headers)
      .toMatchObject({ Authorization: 'Bearer ctok-fresh' })
    expect(await storedCodex()).toMatchObject({ accessToken: 'ctok-fresh' })
  })

  it('yields the codex slot to a writer whose rotation is later than ours', async () => {
    _resetPlanUsageForTests()
    await seedCodex()
    upstream.reply(CODEX_USAGE_URL, httpStatus(401), json(CODEX_BODY))
    upstream.reply(CODEX_TOKEN_URL, async () => {
      // Stamped in the future: a rotation that demonstrably happened after
      // the one this grant is producing.
      await seedCodex({
        accessToken: 'ctok-later', refreshToken: 'cref-later',
        lastRefresh: '2099-01-01T00:00:00.000Z',
      })
      return new Response(JSON.stringify({ access_token: 'ctok-fresh' }), { status: 200 })
    })

    await codexPlanUsageForSnapshot()
    await vi.waitFor(async () => expect(await codexPlanUsageForSnapshot()).toMatchObject({ available: true }))

    expect(await storedCodex()).toMatchObject({ accessToken: 'ctok-later' })
  })

  it('keeps serving usage when the rotated codex bundle cannot be persisted', async () => {
    await seedCodex()
    upstream.reply(CODEX_USAGE_URL, httpStatus(401), json(CODEX_BODY))
    upstream.reply(CODEX_TOKEN_URL, json({ access_token: 'ctok-fresh' }))
    await fs.chmod(credentialsDir(), 0o500)

    await codexPlanUsageForSnapshot()
    await vi.waitFor(async () => expect(await codexPlanUsageForSnapshot()).toMatchObject({ available: true }))

    expect(upstream.requestsTo(CODEX_USAGE_URL).at(-1)?.headers)
      .toMatchObject({ Authorization: 'Bearer ctok-fresh' })
    expect(await storedCodex()).toMatchObject({ accessToken: 'ctok-123' })
  })
})

describe('requestPlanUsageRefresh', () => {
  useAuthFixture('yaac-usage-nudge-')

  it('is a no-op for every tool that is not signed in with OAuth', async () => {
    await requestPlanUsageRefresh()
    await seedClaudeApiKey()
    await seedCodexApiKey()
    await requestPlanUsageRefresh()
    await flush()
    expect(upstream.countTo(CLAUDE_USAGE_URL)).toBe(0)
    expect(upstream.countTo(CODEX_USAGE_URL)).toBe(0)
  })

  it('nudges both tools past the one-minute floor, inside the 5-minute cadence', async () => {
    await seedClaude()
    await seedCodex()
    upstream.always(CLAUDE_PROFILE_URL, json({}))
    upstream.always(CLAUDE_USAGE_URL, json(CLAUDE_BODY))
    upstream.always(CODEX_USAGE_URL, json(CODEX_BODY))

    await planUsageForSnapshot()
    await codexPlanUsageForSnapshot()
    await flush()
    expect(upstream.countTo(CLAUDE_USAGE_URL)).toBe(1)
    expect(upstream.countTo(CODEX_USAGE_URL)).toBe(1)

    // 2 minutes on: the passive cadence would not refresh yet, a nudge does.
    vi.setSystemTime(Date.now() + 2 * 60_000)
    await planUsageForSnapshot()
    expect(upstream.countTo(CLAUDE_USAGE_URL)).toBe(1)
    await requestPlanUsageRefresh()
    await flush()
    expect(upstream.countTo(CLAUDE_USAGE_URL)).toBe(2)
    expect(upstream.countTo(CODEX_USAGE_URL)).toBe(2)
  })

  it('ignores a nudge within a minute of the last attempt', async () => {
    await seedClaude()
    await seedCodex()
    upstream.always(CLAUDE_PROFILE_URL, json({}))
    upstream.always(CLAUDE_USAGE_URL, json(CLAUDE_BODY))
    upstream.always(CODEX_USAGE_URL, json(CODEX_BODY))

    await planUsageForSnapshot()
    await codexPlanUsageForSnapshot()
    await flush()

    vi.setSystemTime(Date.now() + 30_000)
    await requestPlanUsageRefresh()
    await flush()
    expect(upstream.countTo(CLAUDE_USAGE_URL)).toBe(1)
    expect(upstream.countTo(CODEX_USAGE_URL)).toBe(1)
  })
})

describe('refreshPlanUsage', () => {
  useAuthFixture('yaac-usage-cycle-')

  it('is a no-op for every tool that is not signed in with OAuth', async () => {
    await refreshPlanUsage()
    await seedClaudeApiKey()
    await seedCodexApiKey()
    await refreshPlanUsage()
    await flush()
    expect(upstream.countTo(CLAUDE_USAGE_URL)).toBe(0)
    expect(upstream.countTo(CODEX_USAGE_URL)).toBe(0)
  })

  // The background cycle, which the server ticks on its own clock while a
  // client is connected. This is the one irreducible poll in the server —
  // the usage endpoints have no push — and it used to free-ride on a
  // snapshot being rebuilt after every reconcile pass. It keeps the passive
  // 5-minute cadence rather than the nudge's one-minute floor, so an idle
  // dashboard cannot burn a rate-limited endpoint's budget.
  it('refreshes both tools on the 5-minute cadence, not the nudge floor', async () => {
    await seedClaude()
    await seedCodex()
    upstream.always(CLAUDE_PROFILE_URL, json({}))
    upstream.always(CLAUDE_USAGE_URL, json(CLAUDE_BODY))
    upstream.always(CODEX_USAGE_URL, json(CODEX_BODY))

    await refreshPlanUsage()
    await flush()
    expect(upstream.countTo(CLAUDE_USAGE_URL)).toBe(1)
    expect(upstream.countTo(CODEX_USAGE_URL)).toBe(1)

    // Two minutes on — past the nudge floor, inside the cadence.
    vi.setSystemTime(Date.now() + 2 * 60_000)
    await refreshPlanUsage()
    await flush()
    expect(upstream.countTo(CLAUDE_USAGE_URL)).toBe(1)
    expect(upstream.countTo(CODEX_USAGE_URL)).toBe(1)

    vi.setSystemTime(Date.now() + 4 * 60_000)
    await refreshPlanUsage()
    await flush()
    expect(upstream.countTo(CLAUDE_USAGE_URL)).toBe(2)
    expect(upstream.countTo(CODEX_USAGE_URL)).toBe(2)
  })

  // A landed result notifies on its own, which is what pushes it — the
  // caller neither builds nor publishes a snapshot.
  it('pushes the fresh readout without the caller publishing anything', async () => {
    await seedClaude()
    upstream.always(CLAUDE_PROFILE_URL, json({}))
    upstream.always(CLAUDE_USAGE_URL, json(CLAUDE_BODY))

    await refreshPlanUsage()
    await flush()
    expect(notifyWorktreeListChanged).toHaveBeenCalled()
  })
})
