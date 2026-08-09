import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'

vi.mock('#platform/k8s/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return {
    ...actual,
    listSessionPods: vi.fn().mockResolvedValue([]),
    listSessionJobs: vi.fn().mockResolvedValue([]),
  }
})

vi.mock('#features/agents/agent-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof agentToolsModule>()
  return {
    ...actual,
    getAgentSessionFirstMessage: vi.fn().mockResolvedValue(undefined),
  }
})

// The join under test reads the server's rows alongside a herd's report.
// The herd here is the real observation half, so the leaf mocks above still
// drive it end to end — only the boundary between them is stubbed.
import { observeWorkspaces } from '#features/sessions/observe'
import { _resetHerdForTests, _setHerdForTests } from '#herd'
import { listSessionPods, type SessionPod } from '#platform/k8s/pods'
import type * as podsModule from '#platform/k8s/pods'
import type * as agentToolsModule from '#features/agents/agent-tools'
import {
  setAgentStatus,
  _resetSessionStatusStoreForTests,
} from '#features/status/status-store'
import { listActiveSessions, _clearListActiveInflightForTests } from '#features/sessions/list'

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
    terminating: false,
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
    _setHerdForTests({ workspaces: { observe: observeWorkspaces } })
    mockListPods.mockReset()
    mockListPods.mockResolvedValue([pod('s1')])
  })

  afterEach(async () => {
    _resetHerdForTests()
    vi.useRealTimers()
    await cleanupTempDir(tmpDir)
  })

  it('projects the store spell into the entry, stable across listings', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    setAgentStatus('demo', 's1', '%0', 'waiting')
    const first = await listFresh()
    expect(first.worktrees[0].status).toBe('waiting')
    expect(first.worktrees[0].waitingSinceMs).toBe(1_000)

    // Time moves on; the spell (and the projected stamp) does not.
    vi.setSystemTime(60_000)
    const second = await listFresh()
    expect(second.worktrees[0].waitingSinceMs).toBe(1_000)
  })

  it('running is unstamped; a fresh wait restamps', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    setAgentStatus('demo', 's1', '%0', 'waiting')
    setAgentStatus('demo', 's1', '%0', 'running')
    const running = await listFresh()
    expect(running.worktrees[0].status).toBe('running')
    expect(running.worktrees[0].waitingSinceMs).toBeUndefined()

    vi.setSystemTime(2_000)
    setAgentStatus('demo', 's1', '%0', 'waiting')
    const waiting = await listFresh()
    expect(waiting.worktrees[0].status).toBe('waiting')
    expect(waiting.worktrees[0].waitingSinceMs).toBe(2_000)
  })

  it('a booting session (no store entry) lists as waiting with no stamp', async () => {
    const result = await listFresh()
    expect(result.worktrees[0].status).toBe('waiting')
    expect(result.worktrees[0].waitingSinceMs).toBeUndefined()
  })
})
