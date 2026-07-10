import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'

vi.mock('@yaac/server/lib/k8s/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return {
    ...actual,
    listSessionPods: vi.fn().mockResolvedValue([]),
    listSessionJobs: vi.fn().mockResolvedValue([]),
  }
})

vi.mock('@yaac/server/lib/session/status', async (importOriginal) => {
  const actual = await importOriginal<typeof statusModule>()
  return {
    ...actual,
    getSessionFirstMessage: vi.fn().mockResolvedValue(undefined),
  }
})

import { listSessionPods, type SessionPod } from '@yaac/server/lib/k8s/pods'
import type * as podsModule from '@yaac/server/lib/k8s/pods'
import type * as statusModule from '@yaac/server/lib/session/status'
import {
  setSessionStatus,
  _resetSessionStatusStoreForTests,
} from '@yaac/server/lib/session/status-store'
import { listActiveSessions, _clearListActiveInflightForTests } from '@yaac/server/lib/session/list'

const mockListPods = vi.mocked(listSessionPods)

function pod(sessionId: string): SessionPod {
  return {
    jobName: `yaac-demo-${sessionId}`,
    podName: `yaac-demo-${sessionId}-x1`,
    sessionId,
    projectSlug: 'demo',
    tool: 'claude',
    phase: 'Running',
    running: true,
    createdAtMs: 1_000,
    labels: {},
  }
}

/** listActiveSessions with the single-flight cache cleared between calls,
 *  so each call in a test observes fresh store state. */
async function listFresh(): Promise<Awaited<ReturnType<typeof listActiveSessions>>> {
  _clearListActiveInflightForTests()
  return listActiveSessions()
}

describe('listActiveSessions waitingSinceMs (store projection)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    _resetSessionStatusStoreForTests()
    mockListPods.mockReset()
    mockListPods.mockResolvedValue([pod('s1')])
  })

  afterEach(async () => {
    vi.useRealTimers()
    await cleanupTempDir(tmpDir)
  })

  it('projects the store spell into the entry, stable across listings', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    setSessionStatus('demo', 's1', 'waiting')
    const first = await listFresh()
    expect(first.sessions[0].status).toBe('waiting')
    expect(first.sessions[0].waitingSinceMs).toBe(1_000)

    // Time moves on; the spell (and the projected stamp) does not.
    vi.setSystemTime(60_000)
    const second = await listFresh()
    expect(second.sessions[0].waitingSinceMs).toBe(1_000)
  })

  it('running is unstamped; a fresh wait restamps', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    setSessionStatus('demo', 's1', 'waiting')
    setSessionStatus('demo', 's1', 'running')
    const running = await listFresh()
    expect(running.sessions[0].status).toBe('running')
    expect(running.sessions[0].waitingSinceMs).toBeUndefined()

    vi.setSystemTime(2_000)
    setSessionStatus('demo', 's1', 'waiting')
    const waiting = await listFresh()
    expect(waiting.sessions[0].status).toBe('waiting')
    expect(waiting.sessions[0].waitingSinceMs).toBe(2_000)
  })

  it('a booting session (no store entry) lists as waiting with no stamp', async () => {
    const result = await listFresh()
    expect(result.sessions[0].status).toBe('waiting')
    expect(result.sessions[0].waitingSinceMs).toBeUndefined()
  })
})
