import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as podsModule from '#drivers/k8s/substrate/pods'

vi.mock('#drivers/k8s/egress/proxy-client', () => ({
  proxyClient: {
    attachIfRunning: vi.fn(() => Promise.resolve(true)),
    allowHost: vi.fn(() => Promise.resolve(true)),
  },
}))
vi.mock('#drivers/k8s/substrate/pods', async (importOriginal) => ({
  ...(await importOriginal<typeof podsModule>()),
  listWorktreePods: vi.fn(() => Promise.resolve([])),
}))

import { proxyClient } from '#drivers/k8s/egress/proxy-client'
import { listWorktreePods, LABEL_PREWARMED, type PodInfo } from '#drivers/k8s/substrate/pods'
import { allowWorktreeHost } from '#drivers/k8s/egress/allow-host'

function pod(over: Partial<PodInfo>): PodInfo {
  return {
    jobName: 'yaac-proj-x', podName: 'yaac-proj-x-abc', worktreeId: 'sid',
    projectSlug: 'proj', tool: 'claude', phase: 'Running', running: true,
    terminating: false, createdAtMs: 0, labels: {}, ...over,
  }
}

const TARGET = { workspaceId: 'sid-1', projectSlug: 'proj' }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('allowWorktreeHost', () => {
  it('widens only the target session when no fan-out is asked for', async () => {
    await allowWorktreeHost(TARGET, 'h.com', { fanOutToProject: false })

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(proxyClient.allowHost).toHaveBeenCalledExactlyOnceWith('sid-1', 'h.com')
    expect(listWorktreePods).not.toHaveBeenCalled()
  })

  it('surfaces a proxy miss on the named target as an error', async () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(proxyClient.allowHost).mockResolvedValueOnce(false)

    await expect(allowWorktreeHost(TARGET, 'h.com', { fanOutToProject: false }))
      .rejects.toThrow('not registered with the egress proxy')
  })

  it('fans out to running, non-prewarmed project sessions, target included', async () => {
    vi.mocked(listWorktreePods).mockResolvedValue([
      pod({ worktreeId: 'sid-1' }),
      pod({ worktreeId: 'sid-2' }),
      pod({ worktreeId: 'sid-stopped', running: false }),
      pod({ worktreeId: 'sid-spare', labels: { [LABEL_PREWARMED]: 'true' } }),
      pod({ worktreeId: '' }),
    ])
    // One sibling unknown to the proxy — tolerated, not an error.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(proxyClient.allowHost).mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    await allowWorktreeHost(TARGET, 'h.com', { fanOutToProject: true })

    expect(listWorktreePods).toHaveBeenCalledWith('proj')
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(proxyClient.allowHost).mock.calls)
      .toEqual([['sid-1', 'h.com'], ['sid-2', 'h.com']])
  })
})
