import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { KubeConfig } from '@kubernetes/client-node'
import { _resetInClusterClientForTests, inClusterClient } from 'yaac-proxy-sidecar/k8s-client'

describe('inClusterClient', () => {
  const config = (namespace?: string): KubeConfig => {
    const kubeConfig = new KubeConfig()
    kubeConfig.loadFromOptions({
      clusters: [{ name: 'c', server: 'https://10.96.0.1:443', skipTLSVerify: true }],
      users: [{ name: 'u' }],
      contexts: [{ name: 'ctx', cluster: 'c', user: 'u', ...(namespace ? { namespace } : {}) }],
      currentContext: 'ctx',
    })
    return kubeConfig
  }

  beforeEach(() => { _resetInClusterClientForTests() })
  afterEach(() => { _resetInClusterClientForTests() })

  it('exposes the API client and the namespace it serves', () => {
    const client = inClusterClient(config('yaac'))
    expect(client.namespace).toBe('yaac')
    expect(typeof client.core.listNamespacedPod).toBe('function')
  })

  it('memoizes, so the informer and the fallbacks share one credential source', () => {
    const first = inClusterClient(config('yaac'))
    expect(inClusterClient(config('other'))).toBe(first)
  })

  it('_resetInClusterClientForTests drops the memo', () => {
    const first = inClusterClient(config('yaac'))
    _resetInClusterClientForTests()
    expect(inClusterClient(config('other'))).not.toBe(first)
  })

  it('refuses a config with no namespace rather than guessing one', () => {
    // Outside a pod `loadFromCluster` leaves the namespace unset; guessing
    // one would silently misattribute traffic.
    expect(() => inClusterClient(config())).toThrow(/no in-cluster namespace/)
  })
})
