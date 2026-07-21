import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('#platform/k8s/pods', () => ({
  listSessionPods: vi.fn(),
  listSessionJobs: vi.fn(),
}))
vi.mock('#features/cluster/vcluster', () => ({
  listVclusterNamespaces: vi.fn(),
}))

import { createTickSnapshot } from '#platform/k8s/tick-snapshot'
import { listSessionPods, listSessionJobs, type SessionPod } from '#platform/k8s/pods'
import { listVclusterNamespaces } from '#features/cluster/vcluster'

const mockPods = vi.mocked(listSessionPods)
const mockJobs = vi.mocked(listSessionJobs)
const mockVclusters = vi.mocked(listVclusterNamespaces)

const POD = { podName: 'p1' } as SessionPod

beforeEach(() => {
  vi.resetAllMocks()
  mockPods.mockResolvedValue([POD])
  mockJobs.mockResolvedValue([])
  mockVclusters.mockResolvedValue([])
})

describe('createTickSnapshot', () => {
  it('is lazy — creating a snapshot fetches nothing', () => {
    createTickSnapshot()
    expect(mockPods).not.toHaveBeenCalled()
    expect(mockJobs).not.toHaveBeenCalled()
    expect(mockVclusters).not.toHaveBeenCalled()
  })

  it('fetches each listing at most once and shares the result', async () => {
    const snap = createTickSnapshot()
    expect(await snap.pods()).toEqual([POD])
    expect(await snap.pods()).toEqual([POD])
    await snap.jobs()
    await snap.jobs()
    await snap.vclusters()
    await snap.vclusters()
    expect(mockPods).toHaveBeenCalledTimes(1)
    expect(mockJobs).toHaveBeenCalledTimes(1)
    expect(mockVclusters).toHaveBeenCalledTimes(1)
  })

  it('separate snapshots fetch independently', async () => {
    await createTickSnapshot().pods()
    await createTickSnapshot().pods()
    expect(mockPods).toHaveBeenCalledTimes(2)
  })

  it('a failed listing stays failed for the whole snapshot (no per-consumer retry)', async () => {
    mockPods.mockRejectedValue(new Error('apiserver down'))
    const snap = createTickSnapshot()
    await expect(snap.pods()).rejects.toThrow('apiserver down')
    await expect(snap.pods()).rejects.toThrow('apiserver down')
    expect(mockPods).toHaveBeenCalledTimes(1)
  })
})
