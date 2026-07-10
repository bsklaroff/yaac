import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/auth/usage', () => ({
  queryClaudePlanUsage: vi.fn(),
  queryClaudeRateLimitTier: vi.fn(),
}))
// daemonLog writes files — silence it.
vi.mock('@/daemon/log', () => ({ daemonLog: vi.fn() }))
vi.mock('@/daemon/sessions-changed', () => ({ notifySessionListChanged: vi.fn() }))

import { queryClaudePlanUsage, queryClaudeRateLimitTier } from '@/lib/auth/usage'
import { notifySessionListChanged } from '@/daemon/sessions-changed'
import {
  planUsageForSnapshot,
  requestPlanUsageRefresh,
  _resetPlanUsageForTests,
} from '@/daemon/plan-usage'
import { setDataDir } from '@/lib/project/paths'
import { saveClaudeCredentialsFile } from '@/lib/project/tool-auth'
import type { PlanUsageResult } from '@/shared/types'

const queryMock = vi.mocked(queryClaudePlanUsage)
const tierMock = vi.mocked(queryClaudeRateLimitTier)

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

/** Let a detached refresh's .then land (real timers stay active). */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

async function seedOAuth(): Promise<void> {
  await saveClaudeCredentialsFile({
    kind: 'oauth',
    savedAt: '2026-07-09T00:00:00.000Z',
    claudeAiOauth: {
      accessToken: 'tok-123',
      refreshToken: 'ref-123',
      expiresAt: 1783667619085,
      scopes: ['user:inference'],
      subscriptionType: 'max',
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
})
