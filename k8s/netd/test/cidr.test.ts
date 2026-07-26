import { describe, expect, it } from 'vitest'
import { ipInAnyCidr, ipInCidr, parseIpv4, parseIpv4Cidr } from 'yaac-netd/cidr'

describe('parseIpv4', () => {
  it('parses a dotted quad to host order', () => {
    expect(parseIpv4('0.0.0.0')).toBe(0)
    expect(parseIpv4('10.244.0.9')).toBe(((10 * 256 + 244) * 256 + 0) * 256 + 9)
    expect(parseIpv4('255.255.255.255')).toBe(0xffffffff)
  })

  it('rejects anything that is not a dotted quad', () => {
    for (const bad of ['', '10.244.0', '10.244.0.9.1', '10.244.0.256', '10.244.0.-1',
      '10.244.0.0/16', 'fd00::1', '10.244.0.0a', ' 10.244.0.9']) {
      expect(parseIpv4(bad)).toBeNull()
    }
  })
})

describe('parseIpv4Cidr', () => {
  it('parses base + prefix length', () => {
    expect(parseIpv4Cidr('10.244.0.0/16')).toEqual({ base: parseIpv4('10.244.0.0'), bits: 16 })
    expect(parseIpv4Cidr('0.0.0.0/0')).toEqual({ base: 0, bits: 0 })
  })

  it('rejects malformed CIDRs', () => {
    for (const bad of ['10.244.0.0', '10.244.0.0/', '10.244.0.0/33', '10.244.0.0/x',
      '/16', 'fd00::/64']) {
      expect(parseIpv4Cidr(bad)).toBeNull()
    }
  })
})

describe('ipInCidr', () => {
  it('matches inside and rejects outside', () => {
    expect(ipInCidr('10.244.0.9', '10.244.0.0/16')).toBe(true)
    expect(ipInCidr('10.244.255.255', '10.244.0.0/16')).toBe(true)
    expect(ipInCidr('10.245.0.1', '10.244.0.0/16')).toBe(false)
    expect(ipInCidr('203.0.113.7', '10.244.0.0/16')).toBe(false)
  })

  it('handles the edge prefixes', () => {
    // /32 is one address; /0 is everything — and a 32-bit shift is a no-op
    // in JS, so /0 needs its own branch or it silently matches nothing.
    expect(ipInCidr('10.244.0.9', '10.244.0.9/32')).toBe(true)
    expect(ipInCidr('10.244.0.10', '10.244.0.9/32')).toBe(false)
    expect(ipInCidr('203.0.113.7', '0.0.0.0/0')).toBe(true)
  })

  it('is false for anything unparseable — the safe direction', () => {
    expect(ipInCidr('nonsense', '10.244.0.0/16')).toBe(false)
    expect(ipInCidr('10.244.0.9', 'nonsense')).toBe(false)
    expect(ipInCidr('fd00::1', 'fd00::/64')).toBe(false)
  })
})

describe('ipInAnyCidr', () => {
  it('matches when any CIDR contains the address', () => {
    expect(ipInAnyCidr('192.168.5.4', ['10.244.0.0/16', '192.168.0.0/16'])).toBe(true)
    expect(ipInAnyCidr('172.16.0.1', ['10.244.0.0/16', '192.168.0.0/16'])).toBe(false)
  })

  it('matches nothing against an empty list', () => {
    expect(ipInAnyCidr('10.244.0.9', [])).toBe(false)
  })
})
