import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { installRealWorkspaceDriver } from '@yaac/test-utils/real-driver'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// listActiveWorkspaces fans out into many other helpers. We mock the leaves
// (pod listing, fs-backed helpers) so the single-flight wrapper can be
// exercised without a cluster or server.

vi.mock('#drivers/k8s/substrate/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return {
    ...actual,
    listWorkspacePods: vi.fn(),
    listWorkspaceJobs: vi.fn().mockResolvedValue([]),
  }
})

vi.mock('#runtime/status/liveness', () => ({
  isTmuxSessionAlive: vi.fn().mockResolvedValue(true),
  probeTmuxLiveness: vi.fn().mockResolvedValue('alive'),
}))

vi.mock('#runtime/agents/agent-tools', async (importOriginal) => ({
  ...(await importOriginal<typeof agentToolsModule>()),
  getAgentSessionFirstMessage: vi.fn().mockResolvedValue(undefined),
  normalizeTool: vi.fn().mockReturnValue('claude'),
}))

// The join under test reads the recorded rows alongside the real
// observation half, so the leaf mocks above drive it end to end — only the
// substrate is stubbed.
import { listWorkspacePods } from '#drivers/k8s/substrate/pods'
import type * as podsModule from '#drivers/k8s/substrate/pods'
import type * as agentToolsModule from '#runtime/agents/agent-tools'
import {
  listActiveWorkspaces,
  _clearListActiveInflightForTests,
} from '#domain/workspaces/list'
import { setDataDir } from '@yaac/shared/project-paths'
import { recordProject } from '#db/project-store'

const mockListPods = vi.mocked(listWorkspacePods)

describe('listActiveWorkspaces single-flight', () => {
  let tmpDir: string

  beforeEach(async () => {
    installRealWorkspaceDriver()
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

    const a = listActiveWorkspaces()
    const b = listActiveWorkspaces()
    const c = listActiveWorkspaces()

    // All three callers should be waiting on the single in-flight
    // listWorkspacePods; verify by checking the mock call count before
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
    await listActiveWorkspaces()
    await listActiveWorkspaces()
    expect(mockListPods).toHaveBeenCalledTimes(2)
  })

  it('clears the in-flight slot even when the underlying call rejects', async () => {
    mockListPods.mockRejectedValueOnce(new Error('cluster down'))
    await expect(listActiveWorkspaces()).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    // Slot must be released — a follow-up call should attempt again.
    mockListPods.mockResolvedValueOnce([])
    await listActiveWorkspaces()
    expect(mockListPods).toHaveBeenCalledTimes(2)
  })

  it('keeps different filters on separate in-flight slots', async () => {
    // The projects must be recorded so ensureProjectExists doesn't 404.
    await recordProject({ slug: 'proj-a', remoteUrl: 'https://example.com/a.git', addedAt: '2026-01-01T00:00:00.000Z' })
    await recordProject({ slug: 'proj-b', remoteUrl: 'https://example.com/b.git', addedAt: '2026-01-01T00:00:00.000Z' })

    mockListPods.mockResolvedValue([])

    const [a, b] = await Promise.all([
      listActiveWorkspaces('proj-a'),
      listActiveWorkspaces('proj-b'),
    ])

    // Two distinct executions (one per filter), so listWorkspacePods ran
    // twice and the result objects are not the same reference.
    expect(mockListPods).toHaveBeenCalledTimes(2)
    expect(a).not.toBe(b)
  })
})
