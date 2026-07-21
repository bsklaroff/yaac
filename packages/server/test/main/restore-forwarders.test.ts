import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('#platform/k8s/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return {
    ...actual,
    listSessionPods: vi.fn(),
  }
})

vi.mock('#features/projects/config', () => ({
  resolveProjectConfig: vi.fn(),
}))

vi.mock('#features/sessions/cleanup', () => ({
  isTmuxSessionAlive: vi.fn(),
}))

vi.mock('#features/sessions/forwarders/port-forwarders', () => ({
  hasSessionForwarders: vi.fn(),
  provisionSessionForwarders: vi.fn(),
}))

import { listSessionPods, type SessionPod } from '#platform/k8s/pods'
import type * as podsModule from '#platform/k8s/pods'
import { resolveProjectConfig } from '#features/projects/config'
import { isTmuxSessionAlive } from '#features/sessions/cleanup'
import { hasSessionForwarders, provisionSessionForwarders } from '#features/sessions/forwarders/port-forwarders'
import { restoreAllSessionForwarders } from '#main/server-run'

const mockListPods = vi.mocked(listSessionPods)
const mockResolveConfig = vi.mocked(resolveProjectConfig)
const mockTmuxAlive = vi.mocked(isTmuxSessionAlive)
const mockHasForwarders = vi.mocked(hasSessionForwarders)
const mockProvision = vi.mocked(provisionSessionForwarders)

function pod(overrides: Partial<SessionPod> = {}): SessionPod {
  return {
    jobName: 'yaac-proj-sess',
    podName: 'yaac-proj-sess-x1y2z',
    sessionId: 'sess-1',
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

describe('restoreAllSessionForwarders', () => {
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
      pod({ jobName: 'yaac-proj-sess1', sessionId: 'sess1' }),
      pod({ jobName: 'yaac-proj-sess2', sessionId: 'sess2' }),
    ])

    await restoreAllSessionForwarders()

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
    await restoreAllSessionForwarders()
    expect(mockProvision).not.toHaveBeenCalled()
  })

  it('skips pods missing session/project/job metadata', async () => {
    mockListPods.mockResolvedValue([
      pod({ sessionId: '' }),
      pod({ projectSlug: '' }),
      pod({ jobName: '' }),
    ])
    await restoreAllSessionForwarders()
    expect(mockProvision).not.toHaveBeenCalled()
  })

  it('skips pods with a dead tmux session', async () => {
    mockTmuxAlive.mockResolvedValue(false)
    mockListPods.mockResolvedValue([pod()])
    await restoreAllSessionForwarders()
    expect(mockProvision).not.toHaveBeenCalled()
  })

  it('skips pods whose forwarders are already registered', async () => {
    mockHasForwarders.mockReturnValue(true)
    mockListPods.mockResolvedValue([pod()])
    await restoreAllSessionForwarders()
    expect(mockProvision).not.toHaveBeenCalled()
  })

  it('continues when listSessionPods throws', async () => {
    mockListPods.mockRejectedValue(new Error('cluster offline'))
    await expect(restoreAllSessionForwarders()).resolves.toBeUndefined()
    expect(mockProvision).not.toHaveBeenCalled()
  })

  it('swallows per-session provision errors so one failure does not block the rest', async () => {
    mockListPods.mockResolvedValue([
      pod({ jobName: 'yaac-proj-a', sessionId: 'a' }),
      pod({ jobName: 'yaac-proj-b', sessionId: 'b' }),
    ])
    mockProvision
      .mockRejectedValueOnce(new Error('first failed'))
      .mockResolvedValueOnce([])

    await expect(restoreAllSessionForwarders()).resolves.toBeUndefined()
    expect(mockProvision).toHaveBeenCalledTimes(2)
  })
})
