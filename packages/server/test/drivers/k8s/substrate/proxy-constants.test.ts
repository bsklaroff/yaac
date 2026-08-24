import { describe, it, expect } from 'vitest'
import { PROXY_PORT, RELAY_PORT, proxyServiceHost } from '#drivers/k8s/substrate'

/**
 * The datapath's zero-import vocabulary is constants, with one function in
 * it: the name everything in the cluster reaches the proxy by.
 */
describe('proxyServiceHost', () => {
  it('names the proxy Service by its full cluster-DNS name and port', () => {
    // The FQDN is load-bearing, not stylistic: a worktree resolves this
    // through the proxy's split-horizon DNS, which forwards only
    // `.cluster.local` to CoreDNS — a short name would go unanswered.
    expect(proxyServiceHost('yaac', PROXY_PORT))
      .toBe(`yaac-proxy.yaac.svc.cluster.local:${String(PROXY_PORT)}`)
  })

  it('follows the install namespace, so two installs never name each other', () => {
    // e2e files each get their own namespace; the server they deploy has to
    // reach ITS proxy, not the developer's.
    expect(proxyServiceHost('yaac-test-ab12cd34', RELAY_PORT))
      .toBe(`yaac-proxy.yaac-test-ab12cd34.svc.cluster.local:${String(RELAY_PORT)}`)
  })
})
