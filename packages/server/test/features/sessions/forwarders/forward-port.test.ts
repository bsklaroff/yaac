import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('#platform/k8s/pods', async (importOriginal) => ({
  ...(await importOriginal<typeof podsModule>()),
  listSessionPods: vi.fn(),
}))

vi.mock('#features/sessions/forwarders/port-forwarders', () => ({
  addSessionForwarder: vi.fn(),
}))

vi.mock('#features/sessions/forwarders/port-detector', () => ({
  getUnforwardedPorts: vi.fn().mockReturnValue([]),
}))

vi.mock('#features/projects/local-config', () => ({
  addPortForwardToProjectConfig: vi.fn().mockResolvedValue({}),
}))

vi.mock('#log', () => ({ serverLog: vi.fn() }))

import type * as podsModule from '#platform/k8s/pods'
import { listSessionPods, type SessionPod } from '#platform/k8s/pods'
import { addSessionForwarder } from '#features/sessions/forwarders/port-forwarders'
import { getUnforwardedPorts } from '#features/sessions/forwarders/port-detector'
import { addPortForwardToProjectConfig } from '#features/projects/local-config'
import { forwardSessionPort } from '#features/sessions/forwarders/forward-port'

const mockList = vi.mocked(listSessionPods)
const mockAdd = vi.mocked(addSessionForwarder)
const mockDetected = vi.mocked(getUnforwardedPorts)
const mockPersist = vi.mocked(addPortForwardToProjectConfig)

const target = { sessionId: 'sess-1', projectSlug: 'proj', jobName: 'yaac-proj-sess-1' }

function pod(sessionId: string, over: Partial<SessionPod> = {}): SessionPod {
  return {
    jobName: `yaac-proj-${sessionId}`,
    podName: `yaac-proj-${sessionId}-abc`,
    sessionId,
    projectSlug: 'proj',
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 0,
    labels: {},
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDetected.mockReturnValue([8090])
  mockAdd.mockResolvedValue({ containerPort: 8090, hostPort: 8090 })
  mockPersist.mockResolvedValue({})
  mockList.mockResolvedValue([])
})

describe('forwardSessionPort', () => {
  it('rejects a port that is not in the surfaced unforwarded set', async () => {
    mockDetected.mockReturnValue([3000])
    await expect(forwardSessionPort(target, 8090, { persist: false }))
      .rejects.toThrow(/not an unforwarded listener/)
    expect(mockAdd).not.toHaveBeenCalled()
    expect(mockPersist).not.toHaveBeenCalled()
  })

  it('persist:false forwards only the target session, no config write', async () => {
    const mapping = await forwardSessionPort(target, 8090, { persist: false })
    expect(mapping).toEqual({ containerPort: 8090, hostPort: 8090 })
    expect(mockAdd).toHaveBeenCalledExactlyOnceWith('proj', 'sess-1', 'yaac-proj-sess-1', 8090)
    expect(mockPersist).not.toHaveBeenCalled()
    expect(mockList).not.toHaveBeenCalled()
  })

  it('persist:true writes the config first, then fans out to running siblings', async () => {
    mockList.mockResolvedValue([
      pod('sess-1'),
      pod('sess-2'),
      pod('sess-3', { running: false }),
      pod('sess-4', { labels: { 'yaac.prewarmed': 'true' } }),
    ])

    await forwardSessionPort(target, 8090, { persist: true })

    expect(mockPersist).toHaveBeenCalledExactlyOnceWith('proj', 8090)
    expect(mockList).toHaveBeenCalledWith('proj')
    // Target plus the one running, non-prewarmed sibling.
    expect(mockAdd.mock.calls.map((c) => c[1]).sort()).toEqual(['sess-1', 'sess-2'])
  })

  it('persist:true tolerates a sibling forward failure', async () => {
    mockList.mockResolvedValue([pod('sess-1'), pod('sess-2')])
    mockAdd.mockImplementation((_slug, sessionId) => {
      if (sessionId === 'sess-2') return Promise.reject(new Error('sibling down'))
      return Promise.resolve({ containerPort: 8090, hostPort: 8090 })
    })
    const mapping = await forwardSessionPort(target, 8090, { persist: true })
    expect(mapping).toEqual({ containerPort: 8090, hostPort: 8090 })
  })

  it('surfaces a failure on the directly-targeted session', async () => {
    mockAdd.mockRejectedValue(new Error('no ports available'))
    await expect(forwardSessionPort(target, 8090, { persist: false }))
      .rejects.toThrow('no ports available')
  })
})
