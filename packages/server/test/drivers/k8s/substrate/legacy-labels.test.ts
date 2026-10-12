import { describe, it, expect } from 'vitest'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'
import {
  LABEL_INSTALL_ID,
  LABEL_PROJECT_ID,
  installId,
  k8sNamespace,
  legacyHashOf,
  listWorkspaceJobs,
  listWorkspacePods,
  relabelLegacyObjects,
  workspaceIdLabels,
} from '#drivers/k8s/substrate'
// Internal, for fixtures only.
import { JOB_NAME_LABEL } from '#drivers/k8s/substrate/pods'

const HASH = '0123456789abcdef'

function obj(apiVersion: string, kind: string, name: string, labels: Record<string, string>) {
  return {
    apiVersion, kind,
    metadata: { name, labels, namespace: k8sNamespace() },
    ...(kind === 'Pod' ? { status: { phase: 'Running' } } : {}),
  }
}

/** A workspace's Job and pod as an install from before install ids left them. */
function legacyWorkspace(id: string, hash = HASH) {
  const labels = { ...workspaceIdLabels(id), [LABEL_PROJECT_ID]: 'demo', 'yaac.tool': 'claude', 'yaac.data-dir-hash': hash }
  return [
    obj('batch/v1', 'Job', `yaac-${id}`, labels),
    obj('v1', 'Pod', `yaac-${id}-x1`, { ...labels, [JOB_NAME_LABEL]: `yaac-${id}` }),
  ]
}

describe('relabelLegacyObjects', () => {
  it('gives the install id to what an older install labelled with its hash, so the listings see it', async () => {
    fakeCluster.seed(
      ...legacyWorkspace('w1'),
      // A leaked builder and a registry, each under its own legacy key.
      obj('v1', 'Pod', 'builder-1', { 'yaac.role': 'builder', 'yaac.data-dir-hash': HASH }),
      obj('apps/v1', 'Deployment', 'yaac-reg-p1', { app: 'yaac-registry', 'yaac.registry-data-dir-hash': HASH }),
      // Another install's, which stays out of this one.
      ...legacyWorkspace('theirs', 'fedcba9876543210'),
    )
    expect(await listWorkspacePods()).toEqual([])

    expect(await relabelLegacyObjects(HASH)).toBe(4)

    expect((await listWorkspacePods()).map((p) => p.workspaceId)).toEqual(['w1'])
    expect((await listWorkspaceJobs()).map((j) => j.workspaceId)).toEqual(['w1'])
    for (const [kind, name] of [['Pod', 'builder-1'], ['Deployment', 'yaac-reg-p1']]) {
      expect(fakeCluster.get<{ metadata: { labels: Record<string, string> } }>(kind, name)?.metadata.labels)
        .toMatchObject({ [LABEL_INSTALL_ID]: installId() })
    }
    expect(fakeCluster.get<{ metadata: { labels: Record<string, string> } }>('Pod', 'yaac-theirs-x1')?.metadata.labels)
      .not.toHaveProperty(LABEL_INSTALL_ID)
    // Repeatable: every start runs it while the hash is recorded.
    expect(await relabelLegacyObjects(HASH)).toBe(0)
  })
})

describe('legacyHashOf', () => {
  it('reads the hash an older server Deployment\'s pod template carries', () => {
    expect(legacyHashOf({ app: 'yaac-server', 'yaac.data-dir-hash': HASH })).toBe(HASH)
    expect(legacyHashOf({ app: 'yaac-server', [LABEL_INSTALL_ID]: 'id-1' })).toBeUndefined()
    expect(legacyHashOf(undefined)).toBeUndefined()
  })
})
