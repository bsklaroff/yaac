import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('#drivers/k8s/substrate/pods', async (importOriginal) => ({
  ...(await importOriginal<typeof podsModule>()),
  listWorkspacePods: vi.fn(),
}))

vi.mock('#drivers/k8s/forwarders/port-forwarders', () => ({
  addWorkspaceForwarder: vi.fn(),
  getWorkspacePorts: vi.fn().mockReturnValue([]),
}))

vi.mock('#drivers/k8s/forwarders/port-detector', () => ({
  getUnforwardedPorts: vi.fn().mockReturnValue([]),
  isDetectedPort: vi.fn().mockReturnValue(false),
}))


// The relay is the boundary: a dial should open a `tcp` stream through the
// pod's streamd.
vi.mock('#drivers/k8s/substrate/stream-relay', () => ({
  relayDial: vi.fn(),
}))

import type * as podsModule from '#drivers/k8s/substrate/pods'
import { listWorkspacePods, type PodInfo } from '#drivers/k8s/substrate/pods'
import { addWorkspaceForwarder, getWorkspacePorts } from '#drivers/k8s/forwarders/port-forwarders'
import { getUnforwardedPorts, isDetectedPort } from '#drivers/k8s/forwarders/port-detector'
import { relayDial } from '#drivers/k8s/substrate/stream-relay'
import { dialWorkspacePort, forwardWorkspacePort } from '#drivers/k8s/forwarders/forward-port'

const mockList = vi.mocked(listWorkspacePods)
const mockAdd = vi.mocked(addWorkspaceForwarder)
const mockDetected = vi.mocked(getUnforwardedPorts)
const mockDeclared = vi.mocked(getWorkspacePorts)
const mockIsDetected = vi.mocked(isDetectedPort)
const mockRelayDial = vi.mocked(relayDial)

const target = { workspaceId: 'sess-1', projectId: 'proj', jobName: 'yaac-proj-sess-1' }

function pod(workspaceId: string, over: Partial<PodInfo> = {}): PodInfo {
  return {
    jobName: `yaac-proj-${workspaceId}`,
    podName: `yaac-proj-${workspaceId}-abc`,
    workspaceId,
    projectId: '3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c',
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
  mockList.mockResolvedValue([])
  mockDeclared.mockReturnValue([])
  mockIsDetected.mockReturnValue(false)
})

describe('forwardWorkspacePort', () => {
  it('rejects a port that is not in the surfaced unforwarded set', async () => {
    mockDetected.mockReturnValue([3000])
    await expect(forwardWorkspacePort(target, 8090, { fanOutToProject: false }))
      .rejects.toThrow(/not an unforwarded listener/)
    expect(mockAdd).not.toHaveBeenCalled()
  })

  it('forwards only the target session when no fan-out is asked for', async () => {
    const mapping = await forwardWorkspacePort(target, 8090, { fanOutToProject: false })
    expect(mapping).toEqual({ containerPort: 8090, hostPort: 8090 })
    expect(mockAdd).toHaveBeenCalledExactlyOnceWith('sess-1', 'yaac-proj-sess-1', 8090)
    expect(mockList).not.toHaveBeenCalled()
  })

  it('fans out to running, non-prewarmed siblings', async () => {
    mockList.mockResolvedValue([
      pod('sess-1'),
      pod('sess-2'),
      pod('sess-3', { running: false }),
      pod('sess-4', { labels: { 'yaac.prewarmed': 'true' } }),
    ])

    await forwardWorkspacePort(target, 8090, { fanOutToProject: true })

    expect(mockList).toHaveBeenCalledWith('proj')
    // Target plus the one running, non-prewarmed sibling.
    expect(mockAdd.mock.calls.map((c) => c[0]).sort()).toEqual(['sess-1', 'sess-2'])
  })

  it('tolerates a sibling forward failure', async () => {
    mockList.mockResolvedValue([pod('sess-1'), pod('sess-2')])
    mockAdd.mockImplementation((workspaceId) => {
      if (workspaceId === 'sess-2') return Promise.reject(new Error('sibling down'))
      return Promise.resolve({ containerPort: 8090, hostPort: 8090 })
    })
    const mapping = await forwardWorkspacePort(target, 8090, { fanOutToProject: true })
    expect(mapping).toEqual({ containerPort: 8090, hostPort: 8090 })
  })

  it('surfaces a failure on the directly-targeted session', async () => {
    mockAdd.mockRejectedValue(new Error('no ports available'))
    await expect(forwardWorkspacePort(target, 8090, { fanOutToProject: false }))
      .rejects.toThrow('no ports available')
  })
})

describe('dialWorkspacePort', () => {
  it('opens a tcp stream on a declared port, and hands the caller the stream itself', async () => {
    // One dial per forwarded TCP connection. Only the stream is returned;
    // the caller ends the connection by destroying it.
    mockDeclared.mockReturnValue([{ containerPort: 5173, hostPort: 5173 }])
    const stream = { destroy: vi.fn() }
    mockRelayDial.mockResolvedValue(stream as never)

    await expect(dialWorkspacePort('sess-1', 5173)).resolves.toBe(stream)
    expect(mockRelayDial).toHaveBeenCalledWith('sess-1', { kind: 'tcp', port: 5173 })
  })

  it('dials a detected listener nobody declared, but never an arbitrary port', async () => {
    mockRelayDial.mockResolvedValue({ destroy: vi.fn() } as never)
    mockIsDetected.mockImplementation((_id, port) => port === 3000)
    await expect(dialWorkspacePort('sess-1', 3000)).resolves.toBeDefined()

    // yaac's relay port is refused, so the tunnel cannot reach the pod's
    // control endpoints.
    await expect(dialWorkspacePort('sess-1', 10260)).rejects.toThrow(/neither declared nor a detected/)
    expect(mockRelayDial).toHaveBeenCalledTimes(1)
  })
})
