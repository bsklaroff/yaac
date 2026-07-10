import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('#lib/k8s/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return {
    ...actual,
    listSessionPods: vi.fn(),
  }
})

vi.mock('#lib/session/status', () => ({
  getSessionFirstMessage: vi.fn(),
  normalizeTool: vi.fn(() => 'claude'),
}))

vi.mock('#lib/session/cleanup', () => ({
  isTmuxSessionAlive: vi.fn().mockResolvedValue(true),
  cleanupSessionDetached: vi.fn(),
}))

import { getWaitingSessions } from '#lib/session/waiting'
import { listSessionPods, type SessionPod } from '#lib/k8s/pods'
import type * as podsModule from '#lib/k8s/pods'
import { normalizeTool } from '#lib/session/status'
import { setSessionStatus, _resetSessionStatusStoreForTests } from '#lib/session/status-store'
import { isTmuxSessionAlive, cleanupSessionDetached } from '#lib/session/cleanup'

const mockListPods = vi.mocked(listSessionPods)
const mockNormalizeTool = vi.mocked(normalizeTool)
const mockIsTmuxAlive = vi.mocked(isTmuxSessionAlive)
const mockCleanupDetached = vi.mocked(cleanupSessionDetached)

function pod(overrides: Partial<SessionPod> = {}): SessionPod {
  return {
    jobName: 'yaac-proj-s1',
    podName: 'yaac-proj-s1-x1',
    sessionId: 's1',
    projectSlug: 'proj',
    tool: 'claude',
    phase: 'Running',
    running: true,
    createdAtMs: 1_000_000,
    labels: {},
    ...overrides,
  }
}

describe('getWaitingSessions', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    _resetSessionStatusStoreForTests()
    mockNormalizeTool.mockReturnValue('claude')
    mockIsTmuxAlive.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns sessions with status=waiting sorted oldest first', async () => {
    mockListPods.mockResolvedValue([
      pod({ jobName: 'yaac-proj-newer', sessionId: 'newer', createdAtMs: 2_000_000 }),
      pod({ jobName: 'yaac-proj-older', sessionId: 'older', createdAtMs: 1_000_000 }),
    ])
    // No store entry → 'waiting' (the watcher hasn't classified yet).

    const result = await getWaitingSessions()
    expect(result.map((s) => s.sessionId)).toEqual(['older', 'newer'])
    expect(result[0]).toEqual({
      jobName: 'yaac-proj-older',
      sessionId: 'older',
      projectSlug: 'proj',
      createdAtMs: 1_000_000,
      tool: 'claude',
    })
  })

  it('excludes running sessions from the waiting list', async () => {
    mockListPods.mockResolvedValue([pod()])
    setSessionStatus('proj', 's1', 'running')

    const result = await getWaitingSessions()
    expect(result).toEqual([])
    expect(mockCleanupDetached).not.toHaveBeenCalled()
  })

  it('excludes prewarmed spares (never offered to the stream picker)', async () => {
    mockListPods.mockResolvedValue([pod({ labels: { 'yaac.prewarmed': 'true' } })])

    const result = await getWaitingSessions()
    expect(result).toEqual([])
    // A stuck spare is reaped by reconcileStaleSessions, not here.
    expect(mockCleanupDetached).not.toHaveBeenCalled()
  })

  it('triggers detached cleanup for stale (non-running/zombie) pods', async () => {
    mockListPods.mockResolvedValue([
      pod({ jobName: 'yaac-proj-dead', sessionId: 'dead', running: false, phase: 'Failed' }),
    ])

    const result = await getWaitingSessions()
    expect(result).toEqual([])
    expect(mockCleanupDetached).toHaveBeenCalledWith({
      jobName: 'yaac-proj-dead',
      projectSlug: 'proj',
      sessionId: 'dead',
    })
  })

  it('skips sessions in alreadyCleaning without triggering cleanup', async () => {
    mockListPods.mockResolvedValue([
      pod({ jobName: 'yaac-proj-cleaning', sessionId: 'cleaning' }),
    ])

    const result = await getWaitingSessions(undefined, new Set(['cleaning']))
    expect(result).toEqual([])
    expect(mockCleanupDetached).not.toHaveBeenCalled()
  })

  it('passes the project filter through to listSessionPods', async () => {
    mockListPods.mockResolvedValue([])

    await getWaitingSessions('proj-a')
    expect(mockListPods).toHaveBeenCalledWith('proj-a')
  })

  it('protects young pods from cleanup via the grace window', async () => {
    mockListPods.mockResolvedValue([
      pod({
        jobName: 'yaac-proj-young',
        sessionId: 'young',
        running: false,
        phase: 'Pending',
        createdAtMs: Date.now() - 5_000,
      }),
    ])

    const result = await getWaitingSessions()
    expect(result).toEqual([])
    expect(mockCleanupDetached).not.toHaveBeenCalled()
  })

  it('cleans up young stale pods when YAAC_STARTING_GRACE_MS=0', async () => {
    vi.stubEnv('YAAC_STARTING_GRACE_MS', '0')
    mockListPods.mockResolvedValue([
      pod({
        jobName: 'yaac-proj-young-stale',
        sessionId: 'young-stale',
        running: false,
        phase: 'Failed',
        createdAtMs: Date.now() - 5_000,
      }),
    ])

    const result = await getWaitingSessions()
    expect(result).toEqual([])
    expect(mockCleanupDetached).toHaveBeenCalledWith({
      jobName: 'yaac-proj-young-stale',
      projectSlug: 'proj',
      sessionId: 'young-stale',
    })
  })
})
