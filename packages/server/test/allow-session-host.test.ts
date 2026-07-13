import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as podsModule from '#lib/k8s/pods'

vi.mock('#lib/container/proxy-client', () => ({
  proxyClient: {
    attachIfRunning: vi.fn(() => Promise.resolve(true)),
    allowHost: vi.fn(() => Promise.resolve(true)),
  },
}))
vi.mock('#lib/project/local-config', () => ({
  addAllowedHostToProjectConfig: vi.fn(() => Promise.resolve({})),
}))
vi.mock('#lib/k8s/pods', async (importOriginal) => ({
  ...(await importOriginal<typeof podsModule>()),
  listSessionPods: vi.fn(() => Promise.resolve([])),
}))

import { proxyClient } from '#lib/container/proxy-client'
import { addAllowedHostToProjectConfig } from '#lib/project/local-config'
import { listSessionPods, LABEL_PREWARMED, type SessionPod } from '#lib/k8s/pods'
import { allowSessionHost } from '#lib/session/allow-host'

function pod(over: Partial<SessionPod>): SessionPod {
  return {
    jobName: 'yaac-proj-x', podName: 'yaac-proj-x-abc', sessionId: 'sid',
    projectSlug: 'proj', tool: 'claude', phase: 'Running', running: true,
    terminating: false, createdAtMs: 0, labels: {}, ...over,
  }
}

const TARGET = { sessionId: 'sid-1', projectSlug: 'proj' }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('allowSessionHost', () => {
  it('persist:false widens only the target session, touching neither config nor pods', async () => {
    await allowSessionHost(TARGET, 'h.com', { persist: false })

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(proxyClient.allowHost).toHaveBeenCalledExactlyOnceWith('sid-1', 'h.com')
    expect(addAllowedHostToProjectConfig).not.toHaveBeenCalled()
    expect(listSessionPods).not.toHaveBeenCalled()
  })

  it('persist:false surfaces a proxy miss on the target session as an error', async () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(proxyClient.allowHost).mockResolvedValueOnce(false)

    await expect(allowSessionHost(TARGET, 'h.com', { persist: false }))
      .rejects.toThrow('not registered with the egress proxy')
  })

  it('persist:true writes config and fans out to running, non-prewarmed project sessions', async () => {
    vi.mocked(listSessionPods).mockResolvedValue([
      pod({ sessionId: 'sid-1' }),
      pod({ sessionId: 'sid-2' }),
      pod({ sessionId: 'sid-stopped', running: false }),
      pod({ sessionId: 'sid-spare', labels: { [LABEL_PREWARMED]: 'true' } }),
      pod({ sessionId: '' }),
    ])
    // One sibling unknown to the proxy — tolerated, not an error.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(proxyClient.allowHost).mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    await allowSessionHost(TARGET, 'h.com', { persist: true })

    expect(addAllowedHostToProjectConfig).toHaveBeenCalledExactlyOnceWith('proj', 'h.com')
    expect(listSessionPods).toHaveBeenCalledWith('proj')
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(proxyClient.allowHost).mock.calls)
      .toEqual([['sid-1', 'h.com'], ['sid-2', 'h.com']])
  })
})
