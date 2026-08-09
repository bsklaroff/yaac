import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// listActiveSessions fans out into many other helpers. We mock the leaves
// (pod listing, fs-backed helpers) so the single-flight wrapper can be
// exercised without a cluster or server.

vi.mock('#platform/k8s/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return {
    ...actual,
    listSessionPods: vi.fn(),
    listSessionJobs: vi.fn().mockResolvedValue([]),
  }
})

vi.mock('#features/status/liveness', () => ({
  isTmuxSessionAlive: vi.fn().mockResolvedValue(true),
  probeTmuxLiveness: vi.fn().mockResolvedValue('alive'),
}))

vi.mock('#features/egress/blocked-hosts', () => ({
  readBlockedHosts: vi.fn().mockResolvedValue([]),
}))

vi.mock('#features/agents/agent-tools', async (importOriginal) => ({
  ...(await importOriginal<typeof agentToolsModule>()),
  getAgentSessionFirstMessage: vi.fn().mockResolvedValue(undefined),
  normalizeTool: vi.fn().mockReturnValue('claude'),
}))

import { listSessionPods } from '#platform/k8s/pods'
import type * as podsModule from '#platform/k8s/pods'
import type * as agentToolsModule from '#features/agents/agent-tools'
import {
  listActiveSessions,
  _clearListActiveInflightForTests,
} from '#features/sessions/list'
import { setDataDir } from '@yaac/shared/project-paths'

const mockListPods = vi.mocked(listSessionPods)

describe('listActiveSessions single-flight', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-single-flight-list-'))
    setDataDir(tmpDir)
    _clearListActiveInflightForTests()
    mockListPods.mockReset()
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('coalesces overlapping calls with the same filter onto one execution', async () => {
    let resolveList: ((value: never[]) => void) | undefined
    mockListPods.mockReturnValue(new Promise<never[]>((res) => {
      resolveList = res
    }))

    const a = listActiveSessions()
    const b = listActiveSessions()
    const c = listActiveSessions()

    // All three callers should be waiting on the single in-flight
    // listSessionPods; verify by checking the mock call count before
    // we let it resolve.
    expect(mockListPods).toHaveBeenCalledTimes(1)

    resolveList!([])
    const results = await Promise.all([a, b, c])
    // Same Promise resolution — all three see the same result object.
    expect(results[0]).toBe(results[1])
    expect(results[1]).toBe(results[2])
  })

  it('runs again after the prior call settles', async () => {
    mockListPods.mockResolvedValue([])
    await listActiveSessions()
    await listActiveSessions()
    expect(mockListPods).toHaveBeenCalledTimes(2)
  })

  it('clears the in-flight slot even when the underlying call rejects', async () => {
    mockListPods.mockRejectedValueOnce(new Error('cluster down'))
    await expect(listActiveSessions()).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    // Slot must be released — a follow-up call should attempt again.
    mockListPods.mockResolvedValueOnce([])
    await listActiveSessions()
    expect(mockListPods).toHaveBeenCalledTimes(2)
  })

  it('keeps different filters on separate in-flight slots', async () => {
    // Project dirs must exist so ensureProjectExists doesn't 404.
    await fs.mkdir(path.join(tmpDir, 'projects', 'proj-a'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'projects', 'proj-a', 'project.json'), JSON.stringify({
      slug: 'proj-a', remoteUrl: 'https://example.com/a.git', addedAt: '2026-01-01T00:00:00.000Z',
    }))
    await fs.mkdir(path.join(tmpDir, 'projects', 'proj-b'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'projects', 'proj-b', 'project.json'), JSON.stringify({
      slug: 'proj-b', remoteUrl: 'https://example.com/b.git', addedAt: '2026-01-01T00:00:00.000Z',
    }))

    mockListPods.mockResolvedValue([])

    const [a, b] = await Promise.all([
      listActiveSessions('proj-a'),
      listActiveSessions('proj-b'),
    ])

    // Two distinct executions (one per filter), so listSessionPods ran
    // twice and the result objects are not the same reference.
    expect(mockListPods).toHaveBeenCalledTimes(2)
    expect(a).not.toBe(b)
  })
})
