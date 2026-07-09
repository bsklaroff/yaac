import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/k8s/kubectl', () => ({
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn(),
}))

import {
  CILIUM_TPROXY_CHAIN,
  deleteCiliumTproxyRule,
  findCiliumAgentPod,
  listCiliumTproxyRules,
  parseCiliumTproxyRules,
  tproxyRuleDeleteArgs,
} from '@/lib/k8s/cilium-tproxy'
import { kubectlGetJson, kubectlWithRetry } from '@/lib/k8s/kubectl'

const mockGetJson = vi.mocked(kubectlGetJson)
const mockRetry = vi.mocked(kubectlWithRetry)

// Verbatim lines from a live cluster's CILIUM_PRE_mangle chain.
const CEC_TCP =
  '-A CILIUM_PRE_mangle -p tcp -m mark --mark 0x8470200 -m comment --comment'
  + ' "cilium: TPROXY to host yaac-vc-920eeff1/yaac-inner-egress-redirect/yaac-egress-http proxy"'
  + ' -j TPROXY --on-port 12381 --on-ip 127.0.0.1 --tproxy-mark 0x200/0xffffffff'
const CEC_UDP =
  '-A CILIUM_PRE_mangle -p udp -m mark --mark 0x8470200 -m comment --comment'
  + ' "cilium: TPROXY to host yaac-vc-920eeff1/yaac-inner-egress-redirect/yaac-egress-http proxy"'
  + ' -j TPROXY --on-port 12381 --on-ip 127.0.0.1 --tproxy-mark 0x200/0xffffffff'
const CCEC_TCP =
  '-A CILIUM_PRE_mangle -p tcp -m mark --mark 0xb3b0200 -m comment --comment'
  + ' "cilium: TPROXY to host /yaac-vcluster-fallback-redirect-yaac/yaac-egress-http proxy"'
  + ' -j TPROXY --on-port 15115 --on-ip 127.0.0.1 --tproxy-mark 0x200/0xffffffff'
const DNS_TCP =
  '-A CILIUM_PRE_mangle -p tcp -m mark --mark 0xcd8e0200 -m comment --comment'
  + ' "cilium: TPROXY to host cilium-dns-egress proxy"'
  + ' -j TPROXY --on-port 36557 --on-ip 127.0.0.1 --tproxy-mark 0x200/0xffffffff'
const SOCKET_MARK =
  '-A CILIUM_PRE_mangle ! -o lo -m socket --transparent -m mark ! --mark 0xe00/0xf00'
  + ' -m mark ! --mark 0x800/0xf00 -m comment --comment'
  + ' "cilium: any->pod redirect proxied traffic to host proxy" -j MARK --set-xmark 0x200/0xffffffff'
const CHAIN_HEADER = `-N ${CILIUM_TPROXY_CHAIN}`

describe('parseCiliumTproxyRules', () => {
  it('parses namespaced-CEC, cluster-scoped-CCEC, and non-CEC rules', () => {
    const rules = parseCiliumTproxyRules(
      [CHAIN_HEADER, SOCKET_MARK, CEC_TCP, CEC_UDP, CCEC_TCP, DNS_TCP, ''].join('\n'),
    )
    expect(rules).toEqual([
      {
        protocol: 'tcp',
        mark: '0x8470200',
        name: 'yaac-vc-920eeff1/yaac-inner-egress-redirect/yaac-egress-http',
        ref: {
          namespace: 'yaac-vc-920eeff1',
          cecName: 'yaac-inner-egress-redirect',
          listener: 'yaac-egress-http',
        },
        onPort: '12381',
        onIp: '127.0.0.1',
        tproxyMark: '0x200/0xffffffff',
      },
      {
        protocol: 'udp',
        mark: '0x8470200',
        name: 'yaac-vc-920eeff1/yaac-inner-egress-redirect/yaac-egress-http',
        ref: {
          namespace: 'yaac-vc-920eeff1',
          cecName: 'yaac-inner-egress-redirect',
          listener: 'yaac-egress-http',
        },
        onPort: '12381',
        onIp: '127.0.0.1',
        tproxyMark: '0x200/0xffffffff',
      },
      {
        protocol: 'tcp',
        mark: '0xb3b0200',
        name: '/yaac-vcluster-fallback-redirect-yaac/yaac-egress-http',
        // Empty namespace part = cluster-scoped CCEC.
        ref: {
          namespace: '',
          cecName: 'yaac-vcluster-fallback-redirect-yaac',
          listener: 'yaac-egress-http',
        },
        onPort: '15115',
        onIp: '127.0.0.1',
        tproxyMark: '0x200/0xffffffff',
      },
      {
        protocol: 'tcp',
        mark: '0xcd8e0200',
        name: 'cilium-dns-egress',
        // No slashes — not CEC-backed, so no ref (never a GC candidate).
        onPort: '36557',
        onIp: '127.0.0.1',
        tproxyMark: '0x200/0xffffffff',
      },
    ])
  })

  it('skips TPROXY lines that deviate from the exact known shape', () => {
    // An extra matcher anywhere means the delete-args rebuild would not
    // round-trip, so the rule must be ignored, not partially parsed.
    const extraMatcher = CEC_TCP.replace('-m comment', '-i eth0 -m comment')
    const mangledComment = CEC_TCP.replace('cilium: TPROXY to host', 'TPROXY to host')
    expect(parseCiliumTproxyRules([extraMatcher, mangledComment].join('\n'))).toEqual([])
  })

  it('returns [] for empty output', () => {
    expect(parseCiliumTproxyRules('')).toEqual([])
  })
})

describe('tproxyRuleDeleteArgs', () => {
  it('rebuilds the exact rule spec as argv with the comment as one element', () => {
    const [rule] = parseCiliumTproxyRules(CEC_TCP)
    expect(tproxyRuleDeleteArgs(rule)).toEqual([
      '-t', 'mangle', '-D', CILIUM_TPROXY_CHAIN,
      '-p', 'tcp',
      '-m', 'mark', '--mark', '0x8470200',
      '-m', 'comment', '--comment',
      'cilium: TPROXY to host yaac-vc-920eeff1/yaac-inner-egress-redirect/yaac-egress-http proxy',
      '-j', 'TPROXY',
      '--on-port', '12381',
      '--on-ip', '127.0.0.1',
      '--tproxy-mark', '0x200/0xffffffff',
    ])
  })
})

describe('findCiliumAgentPod', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the first Running agent pod', async () => {
    mockGetJson.mockResolvedValue({
      items: [
        { metadata: { name: 'cilium-pending' }, status: { phase: 'Pending' } },
        { metadata: { name: 'cilium-x7k2p' }, status: { phase: 'Running' } },
      ],
    })
    await expect(findCiliumAgentPod()).resolves.toBe('cilium-x7k2p')
    expect(mockGetJson).toHaveBeenCalledWith(
      ['get', 'pods', '-n', 'kube-system', '-l', 'k8s-app=cilium'],
    )
  })

  it('returns null when no agent is Running (or the list is absent)', async () => {
    mockGetJson.mockResolvedValue({
      items: [{ metadata: { name: 'cilium-crash' }, status: { phase: 'CrashLoopBackOff' } }],
    })
    await expect(findCiliumAgentPod()).resolves.toBeNull()
    mockGetJson.mockResolvedValue(null)
    await expect(findCiliumAgentPod()).resolves.toBeNull()
  })
})

describe('listCiliumTproxyRules', () => {
  beforeEach(() => vi.clearAllMocks())

  it('execs iptables -S in the cilium-agent container and parses the output', async () => {
    mockRetry.mockResolvedValue({ stdout: [CHAIN_HEADER, CEC_TCP].join('\n'), stderr: '' })
    const rules = await listCiliumTproxyRules('cilium-x7k2p')
    expect(rules).toHaveLength(1)
    expect(rules[0].name).toBe('yaac-vc-920eeff1/yaac-inner-egress-redirect/yaac-egress-http')
    expect(mockRetry).toHaveBeenCalledWith(
      [
        'exec', '-n', 'kube-system', 'cilium-x7k2p', '-c', 'cilium-agent', '--',
        'iptables', '-t', 'mangle', '-S', CILIUM_TPROXY_CHAIN,
      ],
      { timeout: 30_000 },
    )
  })

  it('returns [] when the chain does not exist, rethrows anything else', async () => {
    mockRetry.mockRejectedValueOnce(
      Object.assign(new Error('exit 1'), {
        stderr: 'iptables: No chain/target/match by that name.\n',
      }),
    )
    await expect(listCiliumTproxyRules('cilium-x7k2p')).resolves.toEqual([])

    mockRetry.mockRejectedValueOnce(Object.assign(new Error('boom'), { stderr: 'other' }))
    await expect(listCiliumTproxyRules('cilium-x7k2p')).rejects.toThrow('boom')
  })
})

describe('deleteCiliumTproxyRule', () => {
  beforeEach(() => vi.clearAllMocks())

  it('execs the rebuilt exact-spec delete in the agent container', async () => {
    mockRetry.mockResolvedValue({ stdout: '', stderr: '' })
    const [rule] = parseCiliumTproxyRules(CEC_UDP)
    await deleteCiliumTproxyRule('cilium-x7k2p', rule)
    expect(mockRetry).toHaveBeenCalledWith(
      [
        'exec', '-n', 'kube-system', 'cilium-x7k2p', '-c', 'cilium-agent', '--',
        'iptables', ...tproxyRuleDeleteArgs(rule),
      ],
      { timeout: 30_000, maxAttempts: 2 },
    )
  })
})
