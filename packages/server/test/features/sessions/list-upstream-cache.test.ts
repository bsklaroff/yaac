import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import type * as podsModule from '#platform/k8s/pods'
import type * as gitModule from '#platform/git'

vi.mock('#platform/k8s/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return {
    ...actual,
    listSessionPods: vi.fn().mockResolvedValue([]),
    listSessionJobs: vi.fn().mockResolvedValue([]),
  }
})

vi.mock('#platform/git', async (importOriginal) => {
  const actual = await importOriginal<typeof gitModule>()
  return { ...actual, worktreeUpstreamBranch: vi.fn() }
})

import { listSessionPods, type SessionPod } from '#platform/k8s/pods'
import { worktreeUpstreamBranch } from '#platform/git'
import { closeDb } from '#platform/db/client'
import {
  listActiveSessions,
  _clearListActiveInflightForTests,
  _clearUpstreamBranchCacheForTests,
} from '#features/sessions/list'

const mockListPods = vi.mocked(listSessionPods)
const mockUpstream = vi.mocked(worktreeUpstreamBranch)

function runningPod(sessionId: string): SessionPod {
  return {
    jobName: `yaac-proj-${sessionId}`,
    podName: `yaac-proj-${sessionId}-x1`,
    sessionId,
    projectSlug: 'proj',
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 1_000,
    labels: {},
  }
}

describe('listActiveSessions upstream-branch cache', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    _clearListActiveInflightForTests()
    _clearUpstreamBranchCacheForTests()
    mockListPods.mockReset().mockResolvedValue([runningPod('s1')])
    mockUpstream.mockReset().mockResolvedValue('main')
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('reads the upstream once per session within the TTL', async () => {
    const first = await listActiveSessions()
    expect(first.sessions[0]?.baseBranch).toBe('main')
    const second = await listActiveSessions()
    expect(second.sessions[0]?.baseBranch).toBe('main')
    expect(mockUpstream).toHaveBeenCalledTimes(1)
    expect(mockUpstream).toHaveBeenCalledWith(expect.stringContaining('proj'), 'agent/s1')
  })

  it('re-reads after the cache is cleared', async () => {
    await listActiveSessions()
    _clearUpstreamBranchCacheForTests()
    await listActiveSessions()
    expect(mockUpstream).toHaveBeenCalledTimes(2)
  })

  it('caches per session id', async () => {
    mockListPods.mockResolvedValue([runningPod('s1'), runningPod('s2')])
    await listActiveSessions()
    await listActiveSessions()
    expect(mockUpstream).toHaveBeenCalledTimes(2)
    expect(mockUpstream).toHaveBeenCalledWith(expect.any(String), 'agent/s1')
    expect(mockUpstream).toHaveBeenCalledWith(expect.any(String), 'agent/s2')
  })

  it('does not cache a failed read — the next rebuild retries', async () => {
    mockUpstream.mockRejectedValueOnce(new Error('git wedged'))
    const first = await listActiveSessions()
    expect(first.sessions[0]?.baseBranch).toBeUndefined()
    const second = await listActiveSessions()
    expect(second.sessions[0]?.baseBranch).toBe('main')
    expect(mockUpstream).toHaveBeenCalledTimes(2)
  })

  it('caches a null (unset upstream) result', async () => {
    mockUpstream.mockResolvedValue(null)
    await listActiveSessions()
    await listActiveSessions()
    expect(mockUpstream).toHaveBeenCalledTimes(1)
  })
})
