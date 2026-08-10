import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as podsModule from '#platform/k8s/pods'

vi.mock('#runtime/k8s/egress/proxy-client', () => ({
  proxyClient: {
    attachIfRunning: vi.fn(() => Promise.resolve(true)),
    allowHost: vi.fn(() => Promise.resolve(true)),
  },
}))
vi.mock('#features/projects/local-config', () => ({
  addAllowedHostToProjectConfig: vi.fn(() => Promise.resolve({})),
}))
vi.mock('#platform/k8s/pods', async (importOriginal) => ({
  ...(await importOriginal<typeof podsModule>()),
  listWorktreePods: vi.fn(() => Promise.resolve([])),
}))

import { proxyClient } from '#runtime/k8s/egress/proxy-client'
import { addAllowedHostToProjectConfig } from '#features/projects/local-config'
import { listWorktreePods, LABEL_PREWARMED, type PodInfo } from '#platform/k8s/pods'
import { allowWorktreeHost } from '#runtime/k8s/egress/allow-host'

function pod(over: Partial<PodInfo>): PodInfo {
  return {
    jobName: 'yaac-proj-x', podName: 'yaac-proj-x-abc', worktreeId: 'sid',
    projectSlug: 'proj', tool: 'claude', phase: 'Running', running: true,
    terminating: false, createdAtMs: 0, labels: {}, ...over,
  }
}

const TARGET = { worktreeId: 'sid-1', projectSlug: 'proj' }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('allowWorktreeHost', () => {
  it('persist:false widens only the target session, touching neither config nor pods', async () => {
    await allowWorktreeHost(TARGET, 'h.com', { persist: false })

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(proxyClient.allowHost).toHaveBeenCalledExactlyOnceWith('sid-1', 'h.com')
    expect(addAllowedHostToProjectConfig).not.toHaveBeenCalled()
    expect(listWorktreePods).not.toHaveBeenCalled()
  })

  it('persist:false surfaces a proxy miss on the target session as an error', async () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(proxyClient.allowHost).mockResolvedValueOnce(false)

    await expect(allowWorktreeHost(TARGET, 'h.com', { persist: false }))
      .rejects.toThrow('not registered with the egress proxy')
  })

  it('persist:true writes config and fans out to running, non-prewarmed project sessions', async () => {
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

    await allowWorktreeHost(TARGET, 'h.com', { persist: true })

    expect(addAllowedHostToProjectConfig).toHaveBeenCalledExactlyOnceWith('proj', 'h.com')
    expect(listWorktreePods).toHaveBeenCalledWith('proj')
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(proxyClient.allowHost).mock.calls)
      .toEqual([['sid-1', 'h.com'], ['sid-2', 'h.com']])
  })
})
