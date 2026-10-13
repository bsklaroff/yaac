import { describe, it, expect, beforeEach } from 'vitest'
import { createK8sDriver } from '#drivers/k8s'
import type { PassContext } from '#drivers/contract'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'
import { snapshotFixture } from '#test/support/fake-driver'

/**
 * The driver's reconcile steps run against the stub cluster with no
 * projects, which is what a fresh install's passes see: every step reads
 * what the pass hands it and finishes with nothing to do.
 */
describe('createK8sDriver', () => {
  beforeEach(() => {
    fakeCluster.reset()
    // Not Ready, so no registry hosts.toml is due on it yet; its address
    // still feeds the node-address policies.
    fakeCluster.seed({
      apiVersion: 'v1',
      kind: 'Node',
      metadata: { name: 'node-1' },
      status: { addresses: [{ type: 'InternalIP', address: '10.89.0.2' }], conditions: [{ type: 'Ready', status: 'False' }] },
    })
  })

  it('runs each of its reconcile steps over an empty install', async () => {
    const ctx: PassContext = {
      triggers: new Set(),
      resync: true,
      signal: new AbortController().signal,
      snapshot: () => snapshotFixture([]),
      projectIds: () => Promise.resolve([]),
      projectConfig: () => Promise.resolve(undefined),
      projectOwner: () => Promise.reject(new Error('no projects')),
      terminating: () => false,
    }
    const { prePool, maintenance } = createK8sDriver().reconcileSteps()
    for (const step of [...prePool, ...maintenance]) {
      await expect(step.run(ctx), step.name).resolves.toBeUndefined()
    }
  })
})
