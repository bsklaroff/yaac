import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockAttach = vi.hoisted(() => vi.fn())
const mockRegister = vi.hoisted(() => vi.fn())
vi.mock('@/lib/container/proxy-client', () => ({
  proxyClient: { attachIfRunning: mockAttach, registerVclusterAttribution: mockRegister },
}))
vi.mock('@/lib/k8s/kubectl', () => ({ kubectlGetJson: vi.fn() }))
vi.mock('@/lib/k8s/vcluster', () => ({ listVclusterNamespaces: vi.fn().mockResolvedValue([]) }))
vi.mock('@/daemon/log', () => ({ daemonLog: vi.fn() }))

import {
  buildVclusterAttribution,
  reconcileVclusterAttribution,
} from '@/lib/session/vcluster-attribution-reconcile'
import { kubectlGetJson } from '@/lib/k8s/kubectl'
import { listVclusterNamespaces } from '@/lib/k8s/vcluster'

const mockGetJson = vi.mocked(kubectlGetJson)
const mockList = vi.mocked(listVclusterNamespaces)

const vc = (sid: string, ns: string): {
  name: string; sessionId: string; namespace: string; creationTimestamp: string
} => ({ name: `yvc-${sid}`, sessionId: sid, namespace: ns, creationTimestamp: '' })

beforeEach(() => {
  vi.clearAllMocks()
  mockAttach.mockResolvedValue(true)
  mockRegister.mockResolvedValue(undefined)
})

describe('buildVclusterAttribution', () => {
  it('maps every vcluster pod IP to its owning outer session', async () => {
    mockList.mockResolvedValue([vc('s1', 'yaac-vc-1'), vc('s2', 'yaac-vc-2')])
    mockGetJson.mockImplementation((args: string[]) => {
      const ns = args[args.indexOf('-n') + 1]
      if (ns === 'yaac-vc-1') {
        return Promise.resolve({ items: [{ status: { podIP: '10.0.0.1' } }, { status: { podIP: '10.0.0.2' } }] })
      }
      if (ns === 'yaac-vc-2') return Promise.resolve({ items: [{ status: { podIP: '10.0.0.3' } }] })
      return Promise.resolve({ items: [] })
    })
    expect(await buildVclusterAttribution()).toEqual({
      '10.0.0.1': 's1', '10.0.0.2': 's1', '10.0.0.3': 's2',
    })
  })

  it('skips pods with no IP and is empty with no vclusters', async () => {
    mockList.mockResolvedValue([vc('s1', 'yaac-vc-1')])
    mockGetJson.mockResolvedValue({ items: [{ status: {} }, {}] })
    expect(await buildVclusterAttribution()).toEqual({})

    mockList.mockResolvedValue([])
    expect(await buildVclusterAttribution()).toEqual({})
  })
})

describe('reconcileVclusterAttribution', () => {
  it('pushes the attribution map to the proxy when it is attachable', async () => {
    mockList.mockResolvedValue([vc('s1', 'yaac-vc-1')])
    mockGetJson.mockResolvedValue({ items: [{ status: { podIP: '10.0.0.1' } }] })
    await reconcileVclusterAttribution()
    expect(mockRegister).toHaveBeenCalledWith({ '10.0.0.1': 's1' })
  })

  it('never bootstraps the proxy: no push when it is not running', async () => {
    mockAttach.mockResolvedValue(false)
    mockList.mockResolvedValue([vc('s1', 'yaac-vc-1')])
    mockGetJson.mockResolvedValue({ items: [{ status: { podIP: '10.0.0.9' } }] })
    await reconcileVclusterAttribution()
    expect(mockRegister).not.toHaveBeenCalled()
  })
})
