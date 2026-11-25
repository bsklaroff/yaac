import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'
import type * as apiModule from '#drivers/k8s/substrate/api'
import { planTokenCertificate, tokenKeyFingerprint, type TokenTlsPair } from '@yaac/shared/token-tls'

vi.mock('#drivers/k8s/substrate/api', async (importOriginal) => ({
  ...await importOriginal<typeof apiModule>(),
  k8sNamespace: () => 'test-ns',
}))

import { installedTokenEndpoint } from '#drivers/k8s/install'

/*
 * What `yaac cluster start|restart|status` print of the token endpoint.
 * The rest of the module (the Service, policy, Secret, forwarder and the
 * byo refusals) runs through `runClusterInstall` in install.test.ts and
 * `runClusterCheck` in check.test.ts.
 */
beforeEach(() => { fakeCluster.reset() })

describe('installedTokenEndpoint', () => {
  it('reads where the endpoint answers from its Service and the key fingerprint from its Secret', async () => {
    expect(await installedTokenEndpoint()).toBeNull()
    fakeCluster.seed({
      apiVersion: 'v1', kind: 'Service', spec: {},
      metadata: { name: 'yaac-server-token', namespace: 'test-ns', annotations: { 'yaac.token-listen': '10.0.1.2:8443' } },
    })
    expect(await installedTokenEndpoint()).toEqual({ listen: '10.0.1.2:8443', fingerprint: null })
    const pair = (await planTokenCertificate(undefined, '10.0.1.2')) as TokenTlsPair
    fakeCluster.seed({
      apiVersion: 'v1', kind: 'Secret', metadata: { name: 'yaac-server-token-tls', namespace: 'test-ns' },
      data: { 'tls.crt': Buffer.from(pair.cert).toString('base64'), 'tls.key': Buffer.from(pair.key).toString('base64') },
    })
    expect(await installedTokenEndpoint()).toEqual({ listen: '10.0.1.2:8443', fingerprint: tokenKeyFingerprint(pair.cert) })
  })
})
