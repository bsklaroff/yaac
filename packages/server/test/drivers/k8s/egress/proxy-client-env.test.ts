import { describe, it, expect, vi, afterEach } from 'vitest'
import type * as kubectlModule from '#drivers/k8s/substrate/kubectl'

// The auth secret is read off the cluster; kubectl is the boundary.
const mockKubectlGetJson = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/substrate/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  k8sNamespace: () => 'yaac',
  kubectlGetJson: mockKubectlGetJson,
}))

import { ProxyClient, PROXY_CA_PATH, PROXY_CA_BUNDLE_PATH } from '#drivers/k8s/egress/proxy-client'

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

describe('ProxyClient.attachIfRunning', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })

  it('dials the proxy Service by name, with no tunnel in between', async () => {
    // The server is a pod of the proxy's own namespace, so the control API
    // is an ordinary Service dial (docs/server-in-cluster.md) — there is no
    // host-side relay to establish first, and so nothing to be "not started".
    mockKubectlGetJson.mockResolvedValue({ data: { secret: Buffer.from('s3').toString('base64') } })
    const mock = vi.fn().mockResolvedValue({ ok: true })
    globalThis.fetch = mock as unknown as typeof fetch
    await expect(new ProxyClient({ image: 'yaac-test-proxy' }).attachIfRunning()).resolves.toBe(true)
    expect(mock.mock.calls[0][0]).toBe('http://yaac-proxy.yaac.svc.cluster.local:10255/healthz')
  })

  it('takes a caller-supplied origin when it is handed one', async () => {
    // The e2e harness drives this client from the HOST, where a ClusterIP
    // names nothing; `controlOrigin` is how it says where to dial instead.
    mockKubectlGetJson.mockResolvedValue({ data: { secret: Buffer.from('s3').toString('base64') } })
    const mock = vi.fn().mockResolvedValue({ ok: true })
    globalThis.fetch = mock as unknown as typeof fetch
    const client = new ProxyClient({
      image: 'yaac-test-proxy',
      controlOrigin: () => Promise.resolve('http://127.0.0.1:4444'),
    })
    await expect(client.attachIfRunning()).resolves.toBe(true)
    expect(mock.mock.calls[0][0]).toBe('http://127.0.0.1:4444/healthz')
  })

  it('answers false, without dialing, when the install has no proxy secret yet', async () => {
    mockKubectlGetJson.mockResolvedValue(null)
    const mock = vi.fn()
    globalThis.fetch = mock as unknown as typeof fetch
    await expect(new ProxyClient({ image: 'yaac-test-proxy' }).attachIfRunning()).resolves.toBe(false)
    expect(mock).not.toHaveBeenCalled()
  })
})
