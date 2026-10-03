import { describe, it, expect } from 'vitest'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'
import { PROXY_AUTH_SECRET_NAME, k8sNamespace } from '#drivers/k8s/substrate'
import {
  ProxyClient,
  PROXY_CA_PATH,
  PROXY_CA_BUNDLE_PATH,
  isProxyAuthSecret,
} from '#drivers/k8s/egress/proxy-client'

describe('ProxyClient.getCaTrustEnv', () => {
  const env = new ProxyClient({ image: 'yaac-test-proxy' }).getCaTrustEnv()
  const names = env.map((e) => e.split('=')[0])

  it('points the additive vars at the bare proxy CA', () => {
    expect(env).toContain(`NODE_EXTRA_CA_CERTS=${PROXY_CA_PATH}`)
    expect(env).toContain(`SSL_CERT_FILE=${PROXY_CA_PATH}`)
    expect(env).toContain('GIT_TERMINAL_PROMPT=0')
  })

  it('points the own-bundle (replace-semantics) vars at the combined bundle', () => {
    // curl, requests, cargo and git ignore SSL_CERT_FILE and replace their
    // whole trust set with this file, so it must hold the public roots plus
    // the proxy CA.
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

describe('isProxyAuthSecret', () => {
  it('accepts only the secret stored in the install', async () => {
    fakeCluster.seed({
      apiVersion: 'v1', kind: 'Secret',
      metadata: { name: PROXY_AUTH_SECRET_NAME, namespace: k8sNamespace() },
      data: { secret: Buffer.from('s3cret').toString('base64') },
    })
    await expect(isProxyAuthSecret('s3cret')).resolves.toBe(true)
    await expect(isProxyAuthSecret('s3cre')).resolves.toBe(false)
    await expect(isProxyAuthSecret('')).resolves.toBe(false)
  })

  it('accepts nothing when the install has no proxy secret yet', async () => {
    await expect(isProxyAuthSecret('')).resolves.toBe(false)
  })
})
