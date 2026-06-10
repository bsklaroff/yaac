import { describe, it, expect, afterEach } from 'vitest'
import { isTailnetIPv4, findTailnetIPv4, detectTailnet } from '@/daemon/tailscale'
import { isAllowedHost } from '@/daemon/web-auth'

afterEach(() => {
  delete process.env.YAAC_SHARE_ADDR
})

describe('isTailnetIPv4', () => {
  it('accepts the CGNAT range 100.64.0.0/10 only', () => {
    expect(isTailnetIPv4('100.64.0.1')).toBe(true)
    expect(isTailnetIPv4('100.79.250.68')).toBe(true)
    expect(isTailnetIPv4('100.127.255.255')).toBe(true)
    expect(isTailnetIPv4('100.63.0.1')).toBe(false)
    expect(isTailnetIPv4('100.128.0.1')).toBe(false)
    expect(isTailnetIPv4('192.168.0.58')).toBe(false)
    expect(isTailnetIPv4('not-an-ip')).toBe(false)
  })
})

describe('findTailnetIPv4', () => {
  it('picks the tailnet address out of mixed interfaces', () => {
    expect(findTailnetIPv4({
      lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
      en0: [{ family: 'IPv4', address: '192.168.0.58', internal: false }],
      utun4: [
        { family: 'IPv6', address: 'fd7a::1', internal: false },
        { family: 'IPv4', address: '100.79.250.68', internal: false },
      ],
    })).toBe('100.79.250.68')
  })

  it('returns null when no tailnet interface exists', () => {
    expect(findTailnetIPv4({
      en0: [{ family: 'IPv4', address: '192.168.0.58', internal: false }],
    })).toBeNull()
  })
})

describe('detectTailnet', () => {
  it('honors the YAAC_SHARE_ADDR override without probing', async () => {
    process.env.YAAC_SHARE_ADDR = '192.168.0.58'
    expect(await detectTailnet()).toEqual({ ip: '192.168.0.58' })
  })
})

describe('isAllowedHost with extra hostnames', () => {
  it('still accepts loopback and rejects strangers', () => {
    expect(isAllowedHost('127.0.0.1:5000', 5000, ['100.79.250.68'])).toBe(true)
    expect(isAllowedHost('evil.com:5000', 5000, ['100.79.250.68'])).toBe(false)
  })

  it('accepts the tailnet ip and dns name on the bound port only', () => {
    const extras = ['100.79.250.68', 'mymac.tail1234.ts.net']
    expect(isAllowedHost('100.79.250.68:5000', 5000, extras)).toBe(true)
    expect(isAllowedHost('mymac.tail1234.ts.net:5000', 5000, extras)).toBe(true)
    expect(isAllowedHost('100.79.250.68:9999', 5000, extras)).toBe(false)
    expect(isAllowedHost('100.99.99.99:5000', 5000, extras)).toBe(false)
  })
})
