import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('#features/auth/usage', () => ({
  queryClaudePlanUsage: vi.fn(),
  queryClaudeRateLimitTier: vi.fn(),
  queryCodexPlanUsage: vi.fn(),
}))
vi.mock('#features/auth/claude-oauth', () => ({
  refreshClaudeOAuthBundle: vi.fn(),
}))
vi.mock('#features/auth/codex-oauth', () => ({
  refreshCodexOAuthBundle: vi.fn(),
}))
// serverLog writes files — silence it.
vi.mock('#log', () => ({ serverLog: vi.fn() }))
vi.mock('#features/sessions/notify', () => ({ notifySessionListChanged: vi.fn() }))

import { queryClaudePlanUsage, queryClaudeRateLimitTier, queryCodexPlanUsage } from '#features/auth/usage'
import { refreshClaudeOAuthBundle } from '#features/auth/claude-oauth'
import { refreshCodexOAuthBundle } from '#features/auth/codex-oauth'
import { notifySessionListChanged } from '#features/sessions/notify'
import {
  planUsageForSnapshot,
  codexPlanUsageForSnapshot,
  requestPlanUsageRefresh,
  _resetPlanUsageForTests,
} from '#features/auth/plan-usage'
import { setDataDir } from '@yaac/shared/project-paths'
import {
  loadClaudeCredentialsFile,
  saveClaudeCredentialsFile,
  loadCodexCredentialsFile,
  saveCodexCredentialsFile,
} from '@yaac/shared/tool-auth'
import type { ClaudeOAuthBundle, CodexOAuthBundle, PlanUsageResult } from '@yaac/shared/types'

const queryMock = vi.mocked(queryClaudePlanUsage)
const tierMock = vi.mocked(queryClaudeRateLimitTier)
const refreshMock = vi.mocked(refreshClaudeOAuthBundle)
const codexQueryMock = vi.mocked(queryCodexPlanUsage)
const codexRefreshMock = vi.mocked(refreshCodexOAuthBundle)

const GOOD: PlanUsageResult = {
  available: true,
  subscriptionType: 'max',
  rateLimitTier: null,
  limits: [
    { kind: 'session', percent: 19, severity: 'normal', resetsAt: null, modelName: null },
  ],
}

const THROTTLED: PlanUsageResult = {
  available: false,
  reason: 'error',
  message: 'usage endpoint returned 429',
}

const UNAUTHORIZED: PlanUsageResult = { available: false, reason: 'unauthorized' }

/** Unambiguously unexpired (2100-01-01) so the seeded token never trips the
 *  expiry pre-check unless a test overrides it. */
const FAR_FUTURE_MS = 4102444800000

const FRESH_BUNDLE: ClaudeOAuthBundle = {
  accessToken: 'tok-fresh',
  refreshToken: 'ref-fresh',
  expiresAt: FAR_FUTURE_MS,
  scopes: ['user:inference'],
  subscriptionType: 'max',
}

/** Let a detached refresh's .then land (real timers stay active). */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

async function seedOAuth(overrides: Partial<ClaudeOAuthBundle> = {}): Promise<void> {
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

async function seedApiKey(): Promise<void> {
  await saveClaudeCredentialsFile({
    kind: 'api-key',
    savedAt: '2026-07-09T00:00:00.000Z',
    apiKey: 'sk-ant-api03-xyz',
  })
}

describe('planUsageForSnapshot', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-plan-usage-'))
    setDataDir(tmpDir)
    _resetPlanUsageForTests()
    queryMock.mockReset()
    tierMock.mockReset()
    tierMock.mockResolvedValue(null)
    refreshMock.mockReset()
    refreshMock.mockResolvedValue(null)
    vi.mocked(notifySessionListChanged).mockReset()
    // Fake only Date so cadence assertions can travel in time while real
    // timers keep the flush() helper working.
    vi.useFakeTimers({ toFake: ['Date'] })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('reports no-credentials without touching upstream', async () => {
    expect(await planUsageForSnapshot()).toEqual({ available: false, reason: 'no-credentials' })
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('reports api-key auth without touching upstream', async () => {
    await seedApiKey()
    expect(await planUsageForSnapshot()).toEqual({ available: false, reason: 'api-key' })
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('returns null while the first refresh is in flight, then the result', async () => {
    await seedOAuth()
    queryMock.mockResolvedValue(GOOD)

    expect(await planUsageForSnapshot()).toBeNull()
    expect(notifySessionListChanged).not.toHaveBeenCalled()
    await flush()
    expect(await planUsageForSnapshot()).toEqual(GOOD)
    // The bundle from the credentials file was handed to the query.
    expect(queryMock).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'tok-123' }))
    // A landed refresh pushes a snapshot instead of waiting for the tick.
    expect(notifySessionListChanged).toHaveBeenCalledTimes(1)
  })

  it('refreshes at most once per interval', async () => {
    await seedOAuth()
    queryMock.mockResolvedValue(GOOD)

    await planUsageForSnapshot()
    await flush()
    // Repeated snapshot builds inside the interval reuse the value.
    await planUsageForSnapshot()
    await planUsageForSnapshot()
    expect(queryMock).toHaveBeenCalledTimes(1)

    vi.setSystemTime(Date.now() + 5 * 60_000 + 1000)
    await planUsageForSnapshot()
    expect(queryMock).toHaveBeenCalledTimes(2)
  })

  it('bridges a transient upstream failure with the last good result', async () => {
    await seedOAuth()
    queryMock.mockResolvedValueOnce(GOOD)
    await planUsageForSnapshot()
    await flush()

    vi.setSystemTime(Date.now() + 6 * 60_000)
    queryMock.mockResolvedValueOnce(THROTTLED)
    await planUsageForSnapshot() // kicks the failing refresh
    await flush()
    expect(await planUsageForSnapshot()).toEqual(GOOD)
  })

  it('surfaces the failure once the stale grace window has passed', async () => {
    await seedOAuth()
    queryMock.mockResolvedValueOnce(GOOD)
    await planUsageForSnapshot()
    await flush()

    queryMock.mockResolvedValue(THROTTLED)
    vi.setSystemTime(Date.now() + 6 * 60_000)
    await planUsageForSnapshot() // fails inside grace — still bridged
    await flush()

    vi.setSystemTime(Date.now() + 10 * 60_000) // 16min past the good fetch
    await planUsageForSnapshot() // fails outside grace
    await flush()
    expect(await planUsageForSnapshot()).toEqual(THROTTLED)
  })

  it('embeds the org rate-limit tier, fetching it once per credential', async () => {
    await seedOAuth()
    queryMock.mockResolvedValue(GOOD)
    tierMock.mockResolvedValue('default_claude_max_20x')

    await planUsageForSnapshot()
    await flush()
    expect(await planUsageForSnapshot()).toEqual({ ...GOOD, rateLimitTier: 'default_claude_max_20x' })

    // A later usage refresh reuses the tier instead of re-querying.
    vi.setSystemTime(Date.now() + 6 * 60_000)
    await planUsageForSnapshot()
    await flush()
    expect(tierMock).toHaveBeenCalledTimes(1)
    expect(queryMock).toHaveBeenCalledTimes(2)
  })

  it('retries the tier fetch on the next cycle while it comes back null', async () => {
    await seedOAuth()
    queryMock.mockResolvedValue(GOOD)
    tierMock.mockResolvedValueOnce(null)
    await planUsageForSnapshot()
    await flush()

    tierMock.mockResolvedValueOnce('default_claude_max_20x')
    vi.setSystemTime(Date.now() + 6 * 60_000)
    await planUsageForSnapshot()
    await flush()
    expect(tierMock).toHaveBeenCalledTimes(2)
    expect(await planUsageForSnapshot()).toEqual({ ...GOOD, rateLimitTier: 'default_claude_max_20x' })
  })

  it('honors an on-demand nudge past the one-minute floor, inside the 5min cadence', async () => {
    await seedOAuth()
    queryMock.mockResolvedValue(GOOD)
    await planUsageForSnapshot()
    await flush()
    expect(queryMock).toHaveBeenCalledTimes(1)

    // 2 minutes later: the passive cadence wouldn't refresh yet, a nudge does.
    vi.setSystemTime(Date.now() + 2 * 60_000)
    await planUsageForSnapshot()
    expect(queryMock).toHaveBeenCalledTimes(1)
    await requestPlanUsageRefresh()
    await flush()
    expect(queryMock).toHaveBeenCalledTimes(2)
  })

  it('ignores a nudge within a minute of the last attempt', async () => {
    await seedOAuth()
    queryMock.mockResolvedValue(GOOD)
    await planUsageForSnapshot()
    await flush()

    vi.setSystemTime(Date.now() + 30_000)
    await requestPlanUsageRefresh()
    await flush()
    expect(queryMock).toHaveBeenCalledTimes(1)
  })

  it('nudges are a no-op without OAuth credentials', async () => {
    await seedApiKey()
    await requestPlanUsageRefresh()
    await flush()
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('drops state on credential change, discarding an in-flight refresh', async () => {
    await seedOAuth()
    let resolveQuery: ((r: PlanUsageResult) => void) | undefined
    queryMock.mockReturnValueOnce(new Promise((r) => { resolveQuery = r }))
    expect(await planUsageForSnapshot()).toBeNull() // refresh now in flight

    // Credential flips to api-key while the query is still pending.
    await seedApiKey()
    expect(await planUsageForSnapshot()).toEqual({ available: false, reason: 'api-key' })

    // The stale in-flight result must not resurface after switching back.
    resolveQuery!(GOOD)
    await flush()
    await seedOAuth()
    queryMock.mockResolvedValue(GOOD)
    expect(await planUsageForSnapshot()).toBeNull()
    await flush()
    expect(await planUsageForSnapshot()).toEqual(GOOD)
  })

  // The refresh chain does real credentials-file I/O, so these tests wait
  // on the outcome instead of a single flush() tick.

  it('refreshes an expired token before querying and persists the result', async () => {
    await seedOAuth({ expiresAt: Date.now() - 1000 })
    refreshMock.mockResolvedValue(FRESH_BUNDLE)
    queryMock.mockResolvedValue(GOOD)

    await planUsageForSnapshot()
    await vi.waitFor(async () => expect(await planUsageForSnapshot()).toEqual(GOOD))

    expect(refreshMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ accessToken: 'tok-123' }))
    expect(queryMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ accessToken: 'tok-fresh' }))
    // The fresh bundle reached the credentials file, so sessions and the
    // next server start pick it up too.
    const stored = await loadClaudeCredentialsFile()
    expect(stored?.kind === 'oauth' ? stored.claudeAiOauth : null).toEqual(FRESH_BUNDLE)
  })

  it('still queries with the stale token when the refresh fails, without a second attempt', async () => {
    await seedOAuth({ expiresAt: Date.now() - 1000 })
    queryMock.mockResolvedValue(UNAUTHORIZED)

    await planUsageForSnapshot()
    await vi.waitFor(async () => expect(await planUsageForSnapshot()).toEqual(UNAUTHORIZED))

    expect(refreshMock).toHaveBeenCalledTimes(1)
    expect(queryMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ accessToken: 'tok-123' }))
  })

  it('refreshes and retries once when an unexpired token comes back unauthorized', async () => {
    await seedOAuth()
    refreshMock.mockResolvedValue(FRESH_BUNDLE)
    queryMock.mockResolvedValueOnce(UNAUTHORIZED)
    queryMock.mockResolvedValueOnce(GOOD)

    await planUsageForSnapshot()
    await vi.waitFor(async () => expect(await planUsageForSnapshot()).toEqual(GOOD))

    expect(refreshMock).toHaveBeenCalledTimes(1)
    expect(queryMock).toHaveBeenCalledTimes(2)
    expect(queryMock).toHaveBeenLastCalledWith(expect.objectContaining({ accessToken: 'tok-fresh' }))
    const stored = await loadClaudeCredentialsFile()
    expect(stored?.kind === 'oauth' ? stored.claudeAiOauth : null).toEqual(FRESH_BUNDLE)
  })

  it('does not clobber a credential replaced while the refresh was in flight', async () => {
    await seedOAuth({ expiresAt: Date.now() - 1000 })
    refreshMock.mockImplementation(async () => {
      // Another writer lands first (a session refresh through the proxy,
      // `yaac auth update`).
      await seedOAuth({ accessToken: 'tok-other', refreshToken: 'ref-other' })
      return FRESH_BUNDLE
    })
    queryMock.mockResolvedValue(GOOD)

    await planUsageForSnapshot()
    await vi.waitFor(async () => expect(await planUsageForSnapshot()).toEqual(GOOD))

    // The query still used the fresh token, but the other writer's
    // credential stayed on disk.
    expect(queryMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ accessToken: 'tok-fresh' }))
    const stored = await loadClaudeCredentialsFile()
    expect(stored?.kind === 'oauth' ? stored.claudeAiOauth.accessToken : null).toBe('tok-other')
  })
})

const GOOD_CODEX: PlanUsageResult = {
  available: true,
  subscriptionType: 'plus',
  rateLimitTier: null,
  limits: [
    { kind: 'codex_primary', percent: 42, severity: 'normal', resetsAt: null, modelName: null, windowMinutes: 300 },
  ],
}

const CODEX_UNAUTHORIZED: PlanUsageResult = { available: false, reason: 'unauthorized' }

const FRESH_CODEX: CodexOAuthBundle = {
  accessToken: 'ctok-fresh',
  refreshToken: 'cref-fresh',
  idTokenRawJwt: 'id-fresh',
  expiresAt: FAR_FUTURE_MS,
  lastRefresh: '2026-07-09T00:00:00.000Z',
  accountId: 'acc-123',
}

describe('codexPlanUsageForSnapshot', () => {
  let tmpDir: string

  async function seedCodexOAuth(overrides: Partial<CodexOAuthBundle> = {}): Promise<void> {
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

  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-codex-usage-'))
    setDataDir(tmpDir)
    _resetPlanUsageForTests()
    codexQueryMock.mockReset()
    codexRefreshMock.mockReset()
    codexRefreshMock.mockResolvedValue(null)
    vi.mocked(notifySessionListChanged).mockReset()
    vi.useFakeTimers({ toFake: ['Date'] })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('omits Codex (null) without ChatGPT credentials, never touching upstream', async () => {
    expect(await codexPlanUsageForSnapshot()).toBeNull()
    await seedCodexApiKey()
    expect(await codexPlanUsageForSnapshot()).toBeNull()
    expect(codexQueryMock).not.toHaveBeenCalled()
  })

  it('returns null while the first refresh is in flight, then the result', async () => {
    await seedCodexOAuth()
    codexQueryMock.mockResolvedValue(GOOD_CODEX)

    expect(await codexPlanUsageForSnapshot()).toBeNull()
    await flush()
    expect(await codexPlanUsageForSnapshot()).toEqual(GOOD_CODEX)
    expect(codexQueryMock).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'ctok-123' }))
    expect(notifySessionListChanged).toHaveBeenCalledTimes(1)
  })

  it('does not refresh proactively for a merely-expired but authorized token', async () => {
    await seedCodexOAuth({ expiresAt: Date.now() - 1000 })
    codexQueryMock.mockResolvedValue(GOOD_CODEX)

    await codexPlanUsageForSnapshot()
    await vi.waitFor(async () => expect(await codexPlanUsageForSnapshot()).toEqual(GOOD_CODEX))

    // Unlike Claude, Codex queries with the stored token and never refreshes
    // ahead of a 401 (its refresh tokens rotate).
    expect(codexRefreshMock).not.toHaveBeenCalled()
    expect(codexQueryMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ accessToken: 'ctok-123' }))
  })

  it('refreshes reactively and retries once when the query is unauthorized, then persists', async () => {
    await seedCodexOAuth({ expiresAt: Date.now() - 1000 })
    codexRefreshMock.mockResolvedValue(FRESH_CODEX)
    codexQueryMock.mockResolvedValueOnce(CODEX_UNAUTHORIZED)
    codexQueryMock.mockResolvedValueOnce(GOOD_CODEX)

    await codexPlanUsageForSnapshot()
    await vi.waitFor(async () => expect(await codexPlanUsageForSnapshot()).toEqual(GOOD_CODEX))

    expect(codexRefreshMock).toHaveBeenCalledTimes(1)
    expect(codexQueryMock).toHaveBeenCalledTimes(2)
    expect(codexQueryMock).toHaveBeenLastCalledWith(expect.objectContaining({ accessToken: 'ctok-fresh' }))
    // The fresh bundle reached the credentials file.
    const stored = await loadCodexCredentialsFile()
    expect(stored?.kind === 'oauth' ? stored.codexOauth : null).toEqual(FRESH_CODEX)
  })

  it('an on-demand nudge refreshes Codex too', async () => {
    await seedCodexOAuth()
    codexQueryMock.mockResolvedValue(GOOD_CODEX)
    await codexPlanUsageForSnapshot()
    await flush()
    expect(codexQueryMock).toHaveBeenCalledTimes(1)

    vi.setSystemTime(Date.now() + 2 * 60_000)
    await requestPlanUsageRefresh()
    await flush()
    expect(codexQueryMock).toHaveBeenCalledTimes(2)
  })
})
