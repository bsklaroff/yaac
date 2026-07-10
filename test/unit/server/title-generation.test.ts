import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/session/list', () => ({ listActiveSessions: vi.fn() }))
vi.mock('@/lib/session/titles', () => ({ setSessionTitle: vi.fn() }))
vi.mock('@/server/title-summarizer', () => ({
  shouldGenerateTitle: vi.fn(),
  summarizeTitle: vi.fn(),
}))
vi.mock('@/server/sessions-changed', () => ({ notifySessionListChanged: vi.fn() }))
vi.mock('@/server/log', () => ({ serverLog: vi.fn() }))

import {
  reconcileGeneratedTitles,
  _resetTitleGenerationForTests,
} from '@/server/title-generation'
import { listActiveSessions } from '@/lib/session/list'
import { setSessionTitle } from '@/lib/session/titles'
import { shouldGenerateTitle, summarizeTitle } from '@/server/title-summarizer'
import { notifySessionListChanged } from '@/server/sessions-changed'
import { serverLog } from '@/server/log'
import type { SessionListEntry } from '@/shared/types'

const mockList = vi.mocked(listActiveSessions)
const mockSetTitle = vi.mocked(setSessionTitle)
const mockShould = vi.mocked(shouldGenerateTitle)
const mockSummarize = vi.mocked(summarizeTitle)
const mockNotify = vi.mocked(notifySessionListChanged)
const mockLog = vi.mocked(serverLog)

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function session(overrides: Partial<SessionListEntry> = {}): SessionListEntry {
  return {
    sessionId: 's1',
    projectSlug: 'p',
    tool: 'claude',
    status: 'waiting',
    createdAt: '2026-01-01 00:00:00',
    prompt: 'please refactor the widget factory into a proper plugin system',
    blockedHosts: [],
    forwardedPorts: [],
    ...overrides,
  }
}

function listOf(...sessions: SessionListEntry[]): void {
  mockList.mockResolvedValue({ sessions, stale: [], gitAuthFailures: {} })
}

describe('title generation', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    _resetTitleGenerationForTests()
    vi.stubEnv('YAAC_AUTO_TITLES', undefined)
    mockShould.mockReturnValue(true)
    mockSummarize.mockResolvedValue('Refactor widget factory into plugins')
    mockSetTitle.mockResolvedValue(undefined)
  })
  afterEach(() => vi.unstubAllEnvs())

  it('generates, persists, and notifies for an untitled session', async () => {
    listOf(session())
    await reconcileGeneratedTitles()
    await flush()

    expect(mockSummarize).toHaveBeenCalledWith(
      'please refactor the widget factory into a proper plugin system')
    expect(mockSetTitle).toHaveBeenCalledWith(
      'p', 's1', 'Refactor widget factory into plugins')
    expect(mockNotify).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when YAAC_AUTO_TITLES=0', async () => {
    vi.stubEnv('YAAC_AUTO_TITLES', '0')
    await reconcileGeneratedTitles()
    expect(mockList).not.toHaveBeenCalled()
  })

  it('skips sessions that already have a title', async () => {
    listOf(session({ title: 'My session' }))
    await reconcileGeneratedTitles()
    await flush()
    expect(mockSummarize).not.toHaveBeenCalled()
  })

  it('skips sessions without a prompt or below the summarize threshold', async () => {
    mockShould.mockReturnValue(false)
    listOf(session({ sessionId: 'no-prompt', prompt: undefined }), session({ sessionId: 'short' }))
    await reconcileGeneratedTitles()
    await flush()
    expect(mockSummarize).not.toHaveBeenCalled()
  })

  it('attempts each session once per server run (in flight, done, or cleared)', async () => {
    listOf(session())
    await reconcileGeneratedTitles()
    await flush()
    expect(mockSummarize).toHaveBeenCalledTimes(1)

    // Still untitled on a later tick (e.g. the user cleared the generated
    // title, or generation failed) — no second attempt.
    await reconcileGeneratedTitles()
    await flush()
    expect(mockSummarize).toHaveBeenCalledTimes(1)
  })

  it('does not double-fire while a generation is still in flight', async () => {
    listOf(session())
    let release!: (title: string | undefined) => void
    mockSummarize.mockImplementation(() => new Promise((r) => { release = r }))

    await reconcileGeneratedTitles()
    await reconcileGeneratedTitles()
    expect(mockSummarize).toHaveBeenCalledTimes(1)

    release('A Title')
    await flush()
    expect(mockSetTitle).toHaveBeenCalledWith('p', 's1', 'A Title')
  })

  it('keeps the prompt fallback when the summarizer returns undefined', async () => {
    listOf(session())
    mockSummarize.mockResolvedValue(undefined)
    await reconcileGeneratedTitles()
    await flush()
    expect(mockSetTitle).not.toHaveBeenCalled()
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it('logs a persist failure without unhandled rejection', async () => {
    listOf(session())
    mockSetTitle.mockRejectedValue(new Error('EACCES'))
    await reconcileGeneratedTitles()
    await flush()
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('[titles] p/s1:'))
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it('swallows a session-list failure', async () => {
    mockList.mockRejectedValue(new Error('server starting'))
    await expect(reconcileGeneratedTitles()).resolves.toBeUndefined()
  })

  it('handles each eligible session independently', async () => {
    listOf(session(), session({ sessionId: 's2', projectSlug: 'q', prompt: 'another long prompt about fixing the release pipeline' }))
    await reconcileGeneratedTitles()
    await flush()
    expect(mockSummarize).toHaveBeenCalledTimes(2)
    expect(mockSetTitle).toHaveBeenCalledWith('p', 's1', 'Refactor widget factory into plugins')
    expect(mockSetTitle).toHaveBeenCalledWith('q', 's2', 'Refactor widget factory into plugins')
  })
})
