import { describe, it, expect } from 'vitest'
import { PROXY_PORT, SOCKET_EGRESS_PORT, proxyServiceHost } from '#drivers/k8s/substrate'

describe('proxyServiceHost', () => {
  it('names the proxy Service by its full cluster-DNS name and port', () => {
    // The FQDN, so it resolves whatever the dialing pod's search path.
    expect(proxyServiceHost('yaac', PROXY_PORT))
      .toBe(`yaac-proxy.yaac.svc.cluster.local:${String(PROXY_PORT)}`)
  })

  it('follows the install namespace, so two installs never name each other', () => {
    // Each e2e file has its own namespace and must reach its own proxy.
    expect(proxyServiceHost('yaac-test-ab12cd34', SOCKET_EGRESS_PORT))
      .toBe(`yaac-proxy.yaac-test-ab12cd34.svc.cluster.local:${String(SOCKET_EGRESS_PORT)}`)
  })
})
