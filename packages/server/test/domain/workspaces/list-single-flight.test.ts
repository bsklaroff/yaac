import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { installRealWorkspaceDriver } from '@yaac/test-utils/real-driver'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// Pod listing, tmux liveness and transcript reads are mocked so the
// single-flight wrapper runs without a cluster. Everything else is real.

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

    // All three callers share one in-flight listWorkspacePods.
    expect(mockListPods).toHaveBeenCalledTimes(1)

    resolveList!([])
    const results = await Promise.all([a, b, c])
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
    mockListPods.mockResolvedValueOnce([])
    await listActiveWorkspaces()
    expect(mockListPods).toHaveBeenCalledTimes(2)
  })

  it('keeps different filters on separate in-flight slots', async () => {
    // Record the projects so the filter does not 404.
    await recordProject({ slug: 'proj-a', remoteUrl: 'https://example.com/a.git', addedAt: '2026-01-01T00:00:00.000Z' })
    await recordProject({ slug: 'proj-b', remoteUrl: 'https://example.com/b.git', addedAt: '2026-01-01T00:00:00.000Z' })

    mockListPods.mockResolvedValue([])

    const [a, b] = await Promise.all([
      listActiveWorkspaces('proj-a'),
      listActiveWorkspaces('proj-b'),
    ])

    expect(mockListPods).toHaveBeenCalledTimes(2)
    expect(a).not.toBe(b)
  })
})
