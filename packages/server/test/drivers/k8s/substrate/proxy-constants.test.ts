import { describe, it, expect } from 'vitest'
import { PROXY_PORT, RELAY_PORT, proxyServiceHost } from '#drivers/k8s/substrate'

describe('proxyServiceHost', () => {
  it('names the proxy Service by its full cluster-DNS name and port', () => {
    // Must be the FQDN: the proxy's DNS forwards only `.cluster.local`
    // names to CoreDNS.
    expect(proxyServiceHost('yaac', PROXY_PORT))
      .toBe(`yaac-proxy.yaac.svc.cluster.local:${String(PROXY_PORT)}`)
  })

  it('follows the install namespace, so two installs never name each other', () => {
    // Each e2e file has its own namespace and must reach its own proxy.
    expect(proxyServiceHost('yaac-test-ab12cd34', RELAY_PORT))
      .toBe(`yaac-proxy.yaac-test-ab12cd34.svc.cluster.local:${String(RELAY_PORT)}`)
  })
})
