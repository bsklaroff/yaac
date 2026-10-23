import { describe, it, expect } from 'vitest'
import { isInternalUpstream, isPublicAddress, upstreamHost } from 'yaac-proxy-sidecar/upstream'

describe('upstreamHost', () => {
  it('reads a destination as a URL parser does, so odd spellings match their dotted quad', () => {
    expect(upstreamHost('Git.Corp.Example')).toBe('git.corp.example')
    for (const odd of ['0x7f.1', '2130706433', '017700000001', '127.1']) expect(upstreamHost(odd)).toBe('127.0.0.1')
    expect(upstreamHost('0x0a.20.0.5')).toBe('10.20.0.5')
  })

  it('refuses IPv6, and anything that is not a host', () => {
    for (const v6 of ['::1', '[::1]', 'fd00:ec2::254', '[::ffff:127.0.0.1]']) {
      expect(() => upstreamHost(v6), v6).toThrow('IPv4 only')
    }
    for (const bad of ['', 'a b', 'a/b', 'user@host', 'foo.123']) {
      expect(() => upstreamHost(bad), bad).toThrow('not a valid host')
    }
  })
})

describe('isPublicAddress', () => {
  it.each([
    // Private, CGNAT (Alibaba's metadata), loopback, link-local (most
    // clouds' metadata), unspecified, documentation, benchmarking,
    // multicast, reserved, broadcast, and Azure's WireServer.
    '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '100.100.100.200',
    '127.0.0.1', '169.254.169.254', '169.254.170.2', '0.0.0.0', '192.0.2.1', '198.18.0.1',
    '224.0.0.1', '240.0.0.1', '255.255.255.255', '168.63.129.16',
    // Not an IPv4 address: the proxy dials IPv4 only.
    '2606:4700::1111', '::ffff:8.8.8.8', 'example.com',
  ])('treats %s as non-public', (address) => {
    expect(isPublicAddress(address)).toBe(false)
  })

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '169.255.0.1', '168.63.129.17'])(
    'treats %s as public', (address) => {
      expect(isPublicAddress(address)).toBe(true)
    },
  )
})

describe('isInternalUpstream', () => {
  it.each([
    'localhost', 'foo.localhost', '127.0.0.1', '127.1.2.3', '0.0.0.0',
    '10.96.227.19', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.1.1', '100.64.0.1', '100.127.255.255',
    'yaac-proxy.yaac.svc', 'echo.yaac-test.svc.cluster.local', 'foo.cluster.local.',
  ])('treats %s as internal', (host) => {
    expect(isInternalUpstream(host)).toBe(true)
  })

  it.each([
    'example.com', 'api.anthropic.com', 'github.com',
    '8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '169.255.0.1', 'svc.example.com',
  ])('treats %s as external', (host) => {
    expect(isInternalUpstream(host)).toBe(false)
  })
})
