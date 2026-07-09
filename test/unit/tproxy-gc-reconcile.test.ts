import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock only the cluster-touching helpers; parsing/arg-building stay real so
// the two-pass keys exercise the same specs production uses.
vi.mock('@/lib/k8s/cilium-tproxy', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  findCiliumAgentPod: vi.fn(),
  listCiliumTproxyRules: vi.fn(),
  deleteCiliumTproxyRule: vi.fn(),
}))
vi.mock('@/lib/k8s/kubectl', () => ({
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn(),
}))
vi.mock('@/daemon/log', () => ({ daemonLog: vi.fn() }))

import {
  type CiliumTproxyRule,
  deleteCiliumTproxyRule,
  findCiliumAgentPod,
  listCiliumTproxyRules,
} from '@/lib/k8s/cilium-tproxy'
import { kubectlGetJson } from '@/lib/k8s/kubectl'
import { daemonLog } from '@/daemon/log'
import {
  reconcileStaleTproxyRules,
  resetTproxyGcState,
  TPROXY_GC_INTERVAL_MS,
} from '@/lib/session/tproxy-gc-reconcile'

const mockFind = vi.mocked(findCiliumAgentPod)
const mockList = vi.mocked(listCiliumTproxyRules)
const mockDelete = vi.mocked(deleteCiliumTproxyRule)
const mockGetJson = vi.mocked(kubectlGetJson)
const mockLog = vi.mocked(daemonLog)

function rule(
  name: string,
  protocol: 'tcp' | 'udp' = 'tcp',
  onPort = '12381',
): CiliumTproxyRule {
  const parts = name.split('/')
  return {
    protocol,
    mark: '0x8470200',
    name,
    ...(parts.length === 3
      ? { ref: { namespace: parts[0], cecName: parts[1], listener: parts[2] } }
      : {}),
    onPort,
    onIp: '127.0.0.1',
    tproxyMark: '0x200/0xffffffff',
  }
}

const STALE_TCP = rule('yaac-vc-dead0001/yaac-inner-egress-redirect/yaac-egress-https')
const STALE_UDP = rule('yaac-vc-dead0001/yaac-inner-egress-redirect/yaac-egress-https', 'udp')
const LIVE_CEC = rule('yaac-vc-a1b2c3d4/yaac-inner-egress-redirect-aaaa000000000001/yaac-egress-https')
const LIVE_CCEC = rule('/yaac-vcluster-fallback-redirect-yaac/yaac-egress-http')
const DNS = rule('cilium-dns-egress')
const FOREIGN = rule('some-ns/istio-egress/listener-a')

/** Wire the live-config listings: namespaced CECs + cluster-scoped CCECs. */
function wireConfigs(cecs: Array<[string, string]>, ccecs: string[] = []): void {
  mockGetJson.mockImplementation((args) => {
    if (args[1] === 'ciliumenvoyconfig') {
      return Promise.resolve({
        items: cecs.map(([namespace, name]) => ({ metadata: { name, namespace } })),
      })
    }
    if (args[1] === 'ciliumclusterwideenvoyconfig') {
      return Promise.resolve({ items: ccecs.map((name) => ({ metadata: { name } })) })
    }
    return Promise.resolve(null)
  })
}

/** Sweep timestamps a full throttle interval apart. */
const at = (n: number): number => 1_000_000 + n * TPROXY_GC_INTERVAL_MS

describe('reconcileStaleTproxyRules', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetTproxyGcState()
    mockFind.mockResolvedValue('cilium-x7k2p')
    mockList.mockResolvedValue([])
    mockDelete.mockResolvedValue(undefined)
    wireConfigs([])
  })

  it('throttles: at most one sweep per interval', async () => {
    await reconcileStaleTproxyRules(at(0))
    await reconcileStaleTproxyRules(at(0) + TPROXY_GC_INTERVAL_MS - 1)
    expect(mockFind).toHaveBeenCalledTimes(1)
    await reconcileStaleTproxyRules(at(1))
    expect(mockFind).toHaveBeenCalledTimes(2)
  })

  it('resetTproxyGcState clears the throttle', async () => {
    await reconcileStaleTproxyRules(at(0))
    resetTproxyGcState()
    await reconcileStaleTproxyRules(at(0))
    expect(mockFind).toHaveBeenCalledTimes(2)
  })

  it('no-ops without a running cilium agent (nested daemon)', async () => {
    mockFind.mockResolvedValue(null)
    await reconcileStaleTproxyRules(at(0))
    expect(mockList).not.toHaveBeenCalled()
  })

  it('never lists configs when only non-yaac rules exist', async () => {
    mockList.mockResolvedValue([DNS, FOREIGN])
    await reconcileStaleTproxyRules(at(0))
    expect(mockGetJson).not.toHaveBeenCalled()
    expect(mockDelete).not.toHaveBeenCalled()
  })

  it('deletes a stale rule only on the second consecutive stale sweep', async () => {
    mockList.mockResolvedValue([STALE_TCP, STALE_UDP, LIVE_CEC, LIVE_CCEC])
    wireConfigs(
      [['yaac-vc-a1b2c3d4', 'yaac-inner-egress-redirect-aaaa000000000001']],
      ['yaac-vcluster-fallback-redirect-yaac'],
    )

    await reconcileStaleTproxyRules(at(0))
    expect(mockDelete).not.toHaveBeenCalled() // first sighting — candidates only

    await reconcileStaleTproxyRules(at(1))
    expect(mockDelete.mock.calls.map(([, r]) => [r.name, r.protocol])).toEqual([
      [STALE_TCP.name, 'tcp'],
      [STALE_UDP.name, 'udp'],
    ])
    // Rules whose CEC/CCEC still exists are never touched.
    expect(mockDelete.mock.calls.some(([, r]) => r === LIVE_CEC || r === LIVE_CCEC)).toBe(false)
    expect(String(mockLog.mock.calls.at(-1)?.[0])).toContain('deleted 2 stale')
  })

  it('drops a candidate whose config reappears, requiring re-confirmation', async () => {
    mockList.mockResolvedValue([STALE_TCP])

    await reconcileStaleTproxyRules(at(0)) // stale — candidate
    wireConfigs([['yaac-vc-dead0001', 'yaac-inner-egress-redirect']])
    await reconcileStaleTproxyRules(at(1)) // config is back — candidate dropped
    wireConfigs([])
    await reconcileStaleTproxyRules(at(2)) // stale again — must re-confirm
    expect(mockDelete).not.toHaveBeenCalled()

    await reconcileStaleTproxyRules(at(3))
    expect(mockDelete).toHaveBeenCalledTimes(1)
  })

  it('keeps a rule as a candidate and logs when its delete fails', async () => {
    mockList.mockResolvedValue([STALE_TCP])
    mockDelete.mockRejectedValueOnce(new Error('exec timeout'))

    await reconcileStaleTproxyRules(at(0))
    await reconcileStaleTproxyRules(at(1))
    expect(mockDelete).toHaveBeenCalledTimes(1)
    expect(String(mockLog.mock.calls[0][0])).toContain('delete failed')

    await reconcileStaleTproxyRules(at(2)) // still a candidate — retried
    expect(mockDelete).toHaveBeenCalledTimes(2)
  })

  it('a config-listing failure aborts the sweep without marking candidates', async () => {
    mockList.mockResolvedValue([STALE_TCP])
    mockGetJson.mockRejectedValue(new Error('apiserver hiccup'))
    await expect(reconcileStaleTproxyRules(at(0))).rejects.toThrow('apiserver hiccup')

    wireConfigs([])
    await reconcileStaleTproxyRules(at(1))
    // The failed sweep contributed no candidates: this is a first sighting.
    expect(mockDelete).not.toHaveBeenCalled()
  })
})
