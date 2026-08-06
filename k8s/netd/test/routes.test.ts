import { describe, expect, it } from 'vitest'
import { normalizeVethPrefix, parsePodVeths, podVethList } from 'yaac-netd/routes'

// Real `ip route show` output from a kind node running Calico, including
// the shapes that MUST NOT be treated as workload routes.
const NODE_ROUTES = `
default via 10.89.0.1 dev eth0
10.89.0.0/24 dev eth0 proto kernel scope link src 10.89.0.7
blackhole 10.244.169.192/26 proto 80
10.244.169.193 dev calibb6b64b7901 scope link
10.244.169.194 dev calif5d21a71440 scope link
10.244.169.197 dev calia132c78e002 scope link
`

describe('parsePodVeths', () => {
  it('maps each pod IP to its Calico veth', () => {
    const map = parsePodVeths(NODE_ROUTES)
    expect(map.get('10.244.169.197')).toBe('calia132c78e002')
    expect(map.get('10.244.169.193')).toBe('calibb6b64b7901')
    expect(map.size).toBe(3)
  })

  it('ignores the node routes that are not workloads', () => {
    const map = parsePodVeths(NODE_ROUTES)
    // A blackhole aggregate for the node's IPAM block, the default route,
    // and the eth0 subnet route must never become redirect targets.
    expect([...map.keys()]).not.toContain('10.244.169.192')
    expect([...map.keys()]).not.toContain('10.89.0.0')
    expect([...map.values()]).not.toContain('eth0')
  })

  it('ignores non-cali devices and via-routes even on 32-bit destinations', () => {
    const map = parsePodVeths([
      '10.0.0.5 dev eth0 scope link',
      '10.0.0.6 via 10.89.0.1 dev calia1 ',
      '10.0.0.7 dev tunl0 scope link',
    ].join('\n'))
    expect(map.size).toBe(0)
  })

  it('lets a later route win, matching a pod replaced on the same IP', () => {
    const map = parsePodVeths([
      '10.244.0.5 dev caliOLD scope link',
      '10.244.0.5 dev caliNEW scope link',
    ].join('\n'))
    expect(map.get('10.244.0.5')).toBe('caliNEW')
  })

  it('rejects malformed dotted quads', () => {
    const map = parsePodVeths([
      '10.244.0.999 dev calia1 scope link',
      '10.244.0 dev calia2 scope link',
    ].join('\n'))
    expect(map.size).toBe(0)
  })

  it('tolerates empty input', () => {
    expect(parsePodVeths('').size).toBe(0)
  })

  it('matches an adopted CNI\'s veth naming when given its prefix', () => {
    // Policy-only Calico over the AWS VPC CNI writes the same per-workload
    // route shape under `eni*`. Nothing about the parse changes but the
    // prefix — which is why this is configuration and not a relaxed parser.
    const routes = [
      'default via 10.0.0.1 dev eth0',
      '10.0.3.41 dev enia7b3c9d1e2f4 scope link',
      '10.0.3.42 dev calibb6b64b7901 scope link',
    ].join('\n')
    expect([...parsePodVeths(routes, 'eni').entries()])
      .toEqual([['10.0.3.41', 'enia7b3c9d1e2f4']])
    // The default keeps seeing only Calico's, so a cluster with both
    // families never has one silently stand in for the other.
    expect([...parsePodVeths(routes).keys()]).toEqual(['10.0.3.42'])
  })

  it('never widens to every device when handed a prefix it cannot use', () => {
    // The prefix is the guarantee that a malformed routing table cannot make
    // netd redirect a node interface, so an empty or nonsense one must fall
    // back to `cali` rather than matching everything.
    const routes = [
      '10.89.0.4 dev eth0 scope link',
      '10.244.0.5 dev calia1b2c3 scope link',
    ].join('\n')
    for (const bad of ['', '  ', 'cali *']) {
      expect([...parsePodVeths(routes, bad).values()]).toEqual(['calia1b2c3'])
    }
  })
})

describe('normalizeVethPrefix', () => {
  it('keeps a plausible interface-name fragment and rejects the rest', () => {
    expect(normalizeVethPrefix('eni')).toBe('eni')
    expect(normalizeVethPrefix('  lxc  ')).toBe('lxc')
    expect(normalizeVethPrefix('veth-x_1.0@')).toBe('veth-x_1.0@')
    // Anything that could not name an interface — including nothing at all
    // — falls back to Calico's rather than becoming a wildcard.
    for (const bad of [undefined, '', '   ', 'a b', 'a/b', 'a*']) {
      expect(normalizeVethPrefix(bad)).toBe('cali')
    }
  })
})

describe('podVethList', () => {
  it('returns entries sorted by pod IP', () => {
    const list = podVethList(parsePodVeths(NODE_ROUTES))
    expect(list.map((e) => e.podIp)).toEqual([
      '10.244.169.193', '10.244.169.194', '10.244.169.197',
    ])
    expect(list[2]).toEqual({ podIp: '10.244.169.197', iface: 'calia132c78e002' })
  })
})
