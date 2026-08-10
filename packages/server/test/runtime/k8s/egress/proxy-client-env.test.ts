import { describe, it, expect } from 'vitest'
import { ProxyClient, PROXY_CA_PATH, PROXY_CA_BUNDLE_PATH } from '#runtime/k8s/egress/proxy-client'

describe('ProxyClient.getCaTrustEnv', () => {
  const env = new ProxyClient({ image: 'yaac-test-proxy' }).getCaTrustEnv()
  const names = env.map((e) => e.split('=')[0])

  it('points the additive vars at the bare proxy CA', () => {
    expect(env).toContain(`NODE_EXTRA_CA_CERTS=${PROXY_CA_PATH}`)
    expect(env).toContain(`SSL_CERT_FILE=${PROXY_CA_PATH}`)
    expect(env).toContain('GIT_TERMINAL_PROMPT=0')
  })

  it('points the own-bundle (replace-semantics) vars at the combined bundle', () => {
    // curl / requests / cargo / git-libcurl ignore SSL_CERT_FILE and REPLACE
    // their trust set with this single file — so it must be the superset
    // {public roots} ∪ {proxy CA}, never the bare CA.
    expect(env).toContain(`CURL_CA_BUNDLE=${PROXY_CA_BUNDLE_PATH}`)
    expect(env).toContain(`REQUESTS_CA_BUNDLE=${PROXY_CA_BUNDLE_PATH}`)
    expect(env).toContain(`CARGO_HTTP_CAINFO=${PROXY_CA_BUNDLE_PATH}`)
    expect(env).toContain(`GIT_SSL_CAINFO=${PROXY_CA_BUNDLE_PATH}`)
    expect(PROXY_CA_BUNDLE_PATH).not.toBe(PROXY_CA_PATH)
  })

  it('carries no routing vars — interception is transparent at the network layer', () => {
    for (const gone of [
      'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy',
      'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY', 'NODE_OPTIONS',
      'GIT_HTTP_PROXY_AUTHMETHOD',
    ]) {
      expect(names).not.toContain(gone)
    }
  })
})

describe('ProxyClient.getCaBundle', () => {
  it('rejects before the proxy is started (no port-forward yet)', async () => {
    await expect(new ProxyClient({ image: 'yaac-test-proxy' }).getCaBundle())
      .rejects.toThrow('Proxy not started')
  })
})
