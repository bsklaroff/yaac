import { describe, expect, it } from 'vitest'
import { redirectChainName, renderNatRestore, renderRedirectRules } from 'yaac-netd/rules'
import type { ListenerTrio } from 'yaac-netd/ports'

const TRIO: ListenerTrio = { https: 15100, http: 15101, tunnel: 15102 }
const CHAIN = redirectChainName('yaac')

function input(overrides: Partial<Parameters<typeof renderRedirectRules>[0]> = {}) {
  return {
    pods: [{ name: 'sess-1', namespace: 'yaac', podIp: '10.244.0.9' }],
    vethByPodIp: new Map([['10.244.0.9', 'calia132c78e002']]),
    trio: TRIO,
    nodeIp: '10.89.0.7',
    podCidrs: ['10.244.0.0/16'],
    sshSentinelIp: '198.18.0.2',
    sshSentinelPort: 10259,
    ...overrides,
  }
}

/** The DNAT rules, i.e. everything after the leading pod-CIDR RETURNs. */
function dnatRules(overrides: Partial<Parameters<typeof renderRedirectRules>[0]> = {}): string[][] {
  return renderRedirectRules(input(overrides)).filter((r) => r.includes('DNAT'))
}

describe('renderRedirectRules', () => {
  it('renders the https/http/tunnel trio for a pod, keyed on its veth', () => {
    const rules = dnatRules()
    expect(rules).toHaveLength(3)
    for (const rule of rules) {
      expect(rule.slice(0, 4)).toEqual(['-i', 'calia132c78e002', '-p', 'tcp'])
      expect(rule).toContain('DNAT')
    }
    expect(rules[0]).toContain('10.89.0.7:15100')
    expect(rules[1]).toContain('10.89.0.7:15101')
    expect(rules[2]).toContain('10.89.0.7:15102')
  })

  it('scopes the redirect to world with a leading RETURN per pod CIDR', () => {
    // iptables allows one `-d` per rule, so the exclusions lead the chain
    // instead of riding each DNAT rule as `! -d`.
    const rules = renderRedirectRules(input({ podCidrs: ['10.244.0.0/16', '192.168.0.0/16'] }))
    expect(rules.slice(0, 2)).toEqual([
      ['-d', '10.244.0.0/16', '-j', 'RETURN'],
      ['-d', '192.168.0.0/16', '-j', 'RETURN'],
    ])
    expect(rules.slice(2).every((r) => r.includes('DNAT'))).toBe(true)
  })

  it('matches the ssh sentinel exactly, outside every pod CIDR', () => {
    const tunnel = dnatRules()[2]
    expect(tunnel).toContain('198.18.0.2')
    expect(tunnel).toContain('10259')
  })

  it('emits nothing for a pod whose veth Calico has not programmed yet', () => {
    // Without a rule, NetworkPolicy denies the pod's world egress.
    expect(dnatRules({ vethByPodIp: new Map() })).toEqual([])
  })

  it('tags each rule with its owning pod for triage', () => {
    const [rule] = dnatRules()
    expect(rule).toContain('--comment')
    expect(rule).toContain('yaac:yaac/sess-1')
  })

  it('truncates the tag under xt_comment\'s 256-byte cap', () => {
    // One over-long comment would make iptables-restore reject the whole
    // document.
    const pods = [{
      name: `${'p'.repeat(240)}-x-yaac-x-vc-alpha`,
      namespace: 'n'.repeat(63),
      podIp: '10.244.0.9',
    }]
    for (const rule of dnatRules({ pods })) {
      const comment = rule[rule.indexOf('--comment') + 1]
      expect(comment.length).toBeLessThan(256)
      expect(comment.startsWith(`yaac:${'n'.repeat(63)}/`)).toBe(true)
    }
  })

  it('aims every pod at the SAME trio — Envoy matches the source', () => {
    const rules = dnatRules({
      pods: [
        { name: 'a', namespace: 'yaac', podIp: '10.244.0.9' },
        { name: 'b', namespace: 'yaac', podIp: '10.244.0.10' },
      ],
      vethByPodIp: new Map([['10.244.0.9', 'caliA'], ['10.244.0.10', 'caliB']]),
    })
    expect(rules).toHaveLength(6)
    expect(rules[0]).toContain('caliA')
    expect(rules[3]).toContain('caliB')
    expect(rules.filter((r) => r.includes('10.89.0.7:15100'))).toHaveLength(2)
  })
})

describe('redirectChainName', () => {
  it('gives each install its own chain', () => {
    // Each netd flushes and refills its chain, so installs sharing a node
    // need separate chains.
    expect(redirectChainName('yaac')).not.toBe(redirectChainName('yaac-test-abc'))
  })

  it('is stable and fits the 28-char iptables limit for any namespace', () => {
    expect(redirectChainName('yaac')).toBe(redirectChainName('yaac'))
    const long = redirectChainName('a-really-long-install-namespace-name-that-keeps-going')
    expect(long.length).toBeLessThanOrEqual(28)
    expect(long).toMatch(/^YAAC_RDR_[0-9a-f]{8}$/)
  })
})

describe('renderNatRestore', () => {
  it('declares, flushes and refills only netd\'s own chain', () => {
    const doc = renderNatRestore(CHAIN, renderRedirectRules(input()))
    const lines = doc.split('\n')
    expect(lines[0]).toBe('*nat')
    expect(lines[1]).toBe(`:${CHAIN} - [0:0]`)
    expect(lines[2]).toBe(`-F ${CHAIN}`)
    expect(lines.filter((l) => l.startsWith(`-A ${CHAIN}`))).toHaveLength(4)
    expect(lines.at(-2)).toBe('COMMIT')
    // --noflush keeps Calico's and kube-proxy's chains intact.
    expect(doc).not.toMatch(new RegExp(`^-[AFX] (?!${CHAIN})`, 'm'))
  })

  it('quotes the comment so iptables-restore parses it as one token', () => {
    expect(renderNatRestore(CHAIN, [['-m', 'comment', '--comment', 'yaac:ns/pod name']]))
      .toContain('"yaac:ns/pod name"')
  })

  it('produces a valid empty document when nothing is selected', () => {
    expect(renderNatRestore(CHAIN, [])).toBe(
      `*nat\n:${CHAIN} - [0:0]\n-F ${CHAIN}\nCOMMIT\n`,
    )
  })

  it('is byte-stable for identical input, so an unchanged pass writes nothing', () => {
    expect(renderNatRestore(CHAIN, renderRedirectRules(input())))
      .toBe(renderNatRestore(CHAIN, renderRedirectRules(input())))
  })
})
