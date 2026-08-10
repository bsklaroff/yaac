import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('#platform/k8s/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return {
    ...actual,
    listWorktreePods: vi.fn(),
  }
})

vi.mock('#features/projects/config', () => ({
  resolveProjectConfig: vi.fn(),
}))

vi.mock('#runtime/status/liveness', () => ({
  isTmuxSessionAlive: vi.fn(),
}))

vi.mock('#runtime/k8s/forwarders/port-forwarders', () => ({
  hasWorktreeForwarders: vi.fn(),
  provisionWorktreeForwarders: vi.fn(),
}))

import { listWorktreePods, type PodInfo } from '#platform/k8s/pods'
import type * as podsModule from '#platform/k8s/pods'
import { resolveProjectConfig } from '#features/projects/config'
import { isTmuxSessionAlive } from '#runtime/status/liveness'
import { hasWorktreeForwarders, provisionWorktreeForwarders } from '#runtime/k8s/forwarders/port-forwarders'
import { restoreAllWorktreeForwarders } from '#runtime/k8s/forwarders/restore'

const mockListPods = vi.mocked(listWorktreePods)
const mockResolveConfig = vi.mocked(resolveProjectConfig)
const mockTmuxAlive = vi.mocked(isTmuxSessionAlive)
const mockHasForwarders = vi.mocked(hasWorktreeForwarders)
const mockProvision = vi.mocked(provisionWorktreeForwarders)

function pod(overrides: Partial<PodInfo> = {}): PodInfo {
  return {
    jobName: 'yaac-proj-sess',
    podName: 'yaac-proj-sess-x1y2z',
    worktreeId: 'sess-1',
    projectSlug: 'proj',
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 1_700_000_000_000,
    labels: {},
    ...overrides,
  }
}

describe('restoreAllWorktreeForwarders', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockTmuxAlive.mockResolvedValue(true)
    mockHasForwarders.mockReturnValue(false)
    mockResolveConfig.mockResolvedValue({
      portForward: [{ containerPort: 3000, hostPortStart: 3000 }],
    })
    mockProvision.mockResolvedValue([{ containerPort: 3000, hostPort: 3000 }])
  })

  it('provisions forwarders for each running session pod', async () => {
    mockListPods.mockResolvedValue([
      pod({ jobName: 'yaac-proj-sess1', worktreeId: 'sess1' }),
      pod({ jobName: 'yaac-proj-sess2', worktreeId: 'sess2' }),
    ])

    await restoreAllWorktreeForwarders()

    expect(mockProvision).toHaveBeenCalledTimes(2)
    expect(mockProvision).toHaveBeenCalledWith(
      'proj', 'sess1', 'yaac-proj-sess1', [{ containerPort: 3000, hostPortStart: 3000 }],
    )
    expect(mockProvision).toHaveBeenCalledWith(
      'proj', 'sess2', 'yaac-proj-sess2', [{ containerPort: 3000, hostPortStart: 3000 }],
    )
  })

  it('skips pods that are not running', async () => {
    mockListPods.mockResolvedValue([
      pod({ running: false, phase: 'Failed' }),
    ])
    await restoreAllWorktreeForwarders()
    expect(mockProvision).not.toHaveBeenCalled()
  })

  it('skips pods missing session/project/job metadata', async () => {
    mockListPods.mockResolvedValue([
      pod({ worktreeId: '' }),
      pod({ projectSlug: '' }),
      pod({ jobName: '' }),
    ])
    await restoreAllWorktreeForwarders()
    expect(mockProvision).not.toHaveBeenCalled()
  })

  it('skips pods with a dead tmux session', async () => {
    mockTmuxAlive.mockResolvedValue(false)
    mockListPods.mockResolvedValue([pod()])
    await restoreAllWorktreeForwarders()
    expect(mockProvision).not.toHaveBeenCalled()
  })

  it('skips pods whose forwarders are already registered', async () => {
    mockHasForwarders.mockReturnValue(true)
    mockListPods.mockResolvedValue([pod()])
    await restoreAllWorktreeForwarders()
    expect(mockProvision).not.toHaveBeenCalled()
  })

  it('continues when listWorktreePods throws', async () => {
    mockListPods.mockRejectedValue(new Error('cluster offline'))
    await expect(restoreAllWorktreeForwarders()).resolves.toBeUndefined()
    expect(mockProvision).not.toHaveBeenCalled()
  })

  it('swallows per-session provision errors so one failure does not block the rest', async () => {
    mockListPods.mockResolvedValue([
      pod({ jobName: 'yaac-proj-a', worktreeId: 'a' }),
      pod({ jobName: 'yaac-proj-b', worktreeId: 'b' }),
    ])
    mockProvision
      .mockRejectedValueOnce(new Error('first failed'))
      .mockResolvedValueOnce([])

    await expect(restoreAllWorktreeForwarders()).resolves.toBeUndefined()
    expect(mockProvision).toHaveBeenCalledTimes(2)
  })
})
