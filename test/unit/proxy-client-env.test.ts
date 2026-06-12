import { describe, it, expect } from 'vitest'
import { ProxyClient, PROXY_CA_PATH } from '@/lib/container/proxy-client'

describe('ProxyClient.getCaTrustEnv', () => {
  const env = new ProxyClient({ image: 'yaac-test-proxy' }).getCaTrustEnv()
  const names = env.map((e) => e.split('=')[0])

  it('keeps the CA-trust vars pointed at the mounted proxy CA', () => {
    expect(env).toContain(`NODE_EXTRA_CA_CERTS=${PROXY_CA_PATH}`)
    expect(env).toContain(`SSL_CERT_FILE=${PROXY_CA_PATH}`)
    expect(env).toContain(`GIT_SSL_CAINFO=${PROXY_CA_PATH}`)
    expect(env).toContain('GIT_TERMINAL_PROMPT=0')
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
