/**
 * Compares the recorded cluster with the kubeconfig's current context.
 * `kubectl config` and the API server are faked; `server.json` is written
 * for real.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import { apiError, fakeCluster } from '@yaac/test-utils/k8s-stub'
import type * as apiModule from '#drivers/k8s/substrate/api'

vi.mock('#drivers/k8s/substrate/api', async (importOriginal) => ({
  ...(await importOriginal<typeof apiModule>()),
  execFileAsync: vi.fn(),
}))

import { foreignClusterRefusal } from '#drivers/k8s/install'
import { execFileAsync } from '#drivers/k8s/substrate/api'
import { serverConfigPath, writeServerConfig } from '@yaac/shared/server-config'

const mockRun = vi.mocked(execFileAsync)

/** Stage the current context name and kube-system uid; an Error makes the uid read fail. */
function current(context: string, uid: string | Error): void {
  mockRun.mockResolvedValue({ stdout: `${context}\n`, stderr: '' })
  fakeCluster.reset()
  if (uid instanceof Error) {
    fakeCluster.intercept(() => { throw uid })
  } else {
    fakeCluster.seed({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'kube-system', uid } })
  }
}

const RECORD = {
  url: '', enabled: false, saved: [], driver: 'k8s' as const,
  installId: 'install-1', clusterUid: 'uid-prod', kubeContext: 'prod',
}

afterEach(async () => {
  vi.clearAllMocks()
  await fs.rm(serverConfigPath(), { force: true })
})

describe('foreignClusterRefusal', () => {
  it('refuses a current context on another cluster — by uid, whatever its name — naming the way back', async () => {
    await writeServerConfig(RECORD)
    current('dev', 'uid-dev')
    expect(await foreignClusterRefusal())
      .toMatch(/cluster of kube context "prod", and kubectl's current context "dev" is a different cluster[\s\S]*kubectl config use-context prod/)

    // A same-named context on another cluster: switching by name would not
    // help, so no use-context hint.
    current('prod', 'uid-elsewhere')
    const sameName = await foreignClusterRefusal()
    expect(sameName).toMatch(/same name but is a different cluster/)
    expect(sameName).toContain('uid-prod')
    expect(sameName).not.toContain('use-context')

    // The recorded cluster under any context name passes.
    current('renamed', 'uid-prod')
    expect(await foreignClusterRefusal()).toBeNull()
  })

  it('refuses a k8s record with no cluster, and a cluster it cannot identify, saying why', async () => {
    // No k8s install here: nothing to compare against.
    await writeServerConfig({ ...RECORD, driver: 'containerless', clusterUid: undefined, kubeContext: undefined })
    current('anything', 'uid-anything')
    expect(await foreignClusterRefusal()).toBeNull()
    // A k8s record that `yaac cluster install` has not stamped yet.
    await writeServerConfig({ ...RECORD, clusterUid: undefined, kubeContext: undefined })
    expect(await foreignClusterRefusal()).toMatch(/records no cluster[\s\S]*yaac cluster install/)
    expect(mockRun).not.toHaveBeenCalled()

    // Namespace-scoped RBAC makes kube-system Forbidden, which means the
    // cluster is not this install's.
    await writeServerConfig(RECORD)
    current('dev', apiError(403, 'namespaces "kube-system" is forbidden: User "me" cannot get resource'))
    expect(await foreignClusterRefusal())
      .toMatch(/current context "dev" points at cannot be identified \(.*403: .*forbidden[\s\S]*kubectl config use-context prod/)

    // Through the install's own context, the cluster is down, so no
    // use-context hint.
    current('prod', new Error('connect ECONNREFUSED 127.0.0.1:41234'))
    const down = await foreignClusterRefusal()
    expect(down).toMatch(/"prod" is the one this install was made through, but its cluster cannot be reached[\s\S]*yaac cluster install/)
    expect(down).not.toContain('use-context')
  })
})
