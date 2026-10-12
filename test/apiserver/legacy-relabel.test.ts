/**
 * The startup relabel (`relabelLegacyObjects`) against a real
 * kube-apiserver: objects an older yaac server-side applied with only a
 * data-dir-hash label gain `yaac.install-id`, nothing else about them
 * changes, other installs' objects are left alone, a second run is a no-op,
 * and a later apply of the new-style manifest neither conflicts nor keeps
 * the old label.
 */
import { execFileSync } from 'node:child_process'
import { beforeAll, describe, expect, inject, it } from 'vitest'
import { applyObject, ensureKubernetes } from '@yaac/server/drivers/k8s/substrate/api'
import { installId } from '@yaac/server/drivers/k8s/substrate/install-id'
import { relabelLegacyObjects } from '@yaac/server/drivers/k8s/substrate/legacy-labels'

const NS = 'yaac'
const HASH = '0123456789abcdef'
const OTHER = 'fedcba9876543210'
let kubectlBin = ''

type Labels = Record<string, string>
const podSpec = { restartPolicy: 'Never', containers: [{ name: 'c', image: 'x' }] }
const meta = (name: string, labels: Labels) => ({ name, namespace: NS, labels })
interface Stored {
  metadata: { labels?: Labels; managedFields?: Array<{ manager: string; operation: string }>; [key: string]: unknown }
  spec?: { template?: { metadata?: { labels?: Labels } } }
  [key: string]: unknown
}

function get(kind: string, name: string): Stored {
  return JSON.parse(execFileSync(kubectlBin, ['get', kind, name, '-n', NS, '-o', 'json', '--show-managed-fields'], {
    encoding: 'utf8',
  })) as Stored
}

/** Everything but the bookkeeping a metadata patch is allowed to touch. */
function body(obj: Stored): unknown {
  const meta = { ...obj.metadata }
  delete meta.labels
  delete meta.managedFields
  delete meta.resourceVersion
  return { ...obj, metadata: meta }
}

const registryDeployment = (labels: Labels) => ({
  apiVersion: 'apps/v1', kind: 'Deployment', metadata: meta('yaac-reg-p1', labels),
  spec: {
    selector: { matchLabels: { app: 'yaac-registry', 'yaac.project-id': 'p1' } },
    template: { metadata: { labels }, spec: { containers: [{ name: 'c', image: 'x' }] } },
  },
})

const SEEDED: Array<[string, Record<string, unknown>]> = [
  ['job/ws-1', { apiVersion: 'batch/v1', kind: 'Job', metadata: meta('ws-1', { 'yaac.workspace-id': 'w1', 'yaac.data-dir-hash': HASH }),
    spec: { backoffLimit: 0, template: { metadata: { labels: { 'yaac.workspace-id': 'w1', 'yaac.data-dir-hash': HASH } }, spec: podSpec } } }],
  ['pod/ws-1-pod', { apiVersion: 'v1', kind: 'Pod', metadata: meta('ws-1-pod', { 'yaac.workspace-id': 'w1', 'yaac.data-dir-hash': HASH }), spec: podSpec }],
  ['pod/sweep', { apiVersion: 'v1', kind: 'Pod', metadata: meta('sweep', { app: 'yaac-node-local-sweep', 'yaac.sweep-data-dir-hash': HASH }), spec: podSpec }],
  ['pod/store', { apiVersion: 'v1', kind: 'Pod', metadata: meta('store', { app: 'yaac-image-store', 'yaac.store-data-dir-hash': HASH }), spec: podSpec }],
  ['deployment/yaac-reg-p1',
    registryDeployment({ app: 'yaac-registry', 'yaac.project-id': 'p1', 'yaac.registry-data-dir-hash': HASH })],
  ['service/yaac-reg-p1', { apiVersion: 'v1', kind: 'Service',
    metadata: meta('yaac-reg-p1', { app: 'yaac-registry', 'yaac.registry-data-dir-hash': HASH }),
    spec: { selector: { app: 'yaac-registry' }, ports: [{ port: 5000 }] } }],
  ['pvc/yaac-reg-p1', { apiVersion: 'v1', kind: 'PersistentVolumeClaim',
    metadata: meta('yaac-reg-p1', { app: 'yaac-registry', 'yaac.registry-data-dir-hash': HASH }),
    spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } } }],
  ['networkpolicy/yaac-reg-p1', { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
    metadata: meta('yaac-reg-p1', { app: 'yaac-registry', 'yaac.registry-data-dir-hash': HASH }),
    spec: { podSelector: { matchLabels: { app: 'yaac-registry' } }, policyTypes: ['Egress'] } }],
  // Another install's, and one already claimed: both must be left alone.
  ['pod/other', { apiVersion: 'v1', kind: 'Pod', metadata: meta('other', { 'yaac.data-dir-hash': OTHER }), spec: podSpec }],
  ['pod/claimed', { apiVersion: 'v1', kind: 'Pod', metadata: meta('claimed', { 'yaac.data-dir-hash': HASH, 'yaac.install-id': 'someone-else' }), spec: podSpec }],
]

beforeAll(async () => {
  process.env.KUBECONFIG = inject('apiserverKubeconfig')
  kubectlBin = inject('apiserverKubectl')
  await ensureKubernetes()
  await applyObject({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS } })
  // As an older yaac wrote them: server-side apply under `yaac`.
  for (const [, manifest] of SEEDED) await applyObject(manifest)
})

describe('relabelLegacyObjects', () => {
  it('adds the install id to this hash\'s objects only, changing nothing else, once', async () => {
    const before = new Map(SEEDED.map(([key]) => [key, get(...key.split('/') as [string, string])]))
    expect(await relabelLegacyObjects(HASH)).toBe(8)
    for (const [key] of SEEDED) {
      const [kind, name] = key.split('/')
      const was = before.get(key)!
      const now = get(kind, name)
      expect(body(now), key).toEqual(body(was))
      const expected = name === 'other' || name === 'claimed'
        ? was.metadata.labels
        : { ...was.metadata.labels, 'yaac.install-id': installId() }
      expect(now.metadata.labels, key).toEqual(expected)
      if (kind === 'deployment' || kind === 'job') {
        // Only metadata: the template still carries just the old label.
        expect(now.spec?.template?.metadata?.labels?.['yaac.install-id'], key).toBeUndefined()
      }
    }
    expect(await relabelLegacyObjects(HASH)).toBe(0)
  })

  it('lets a later new-style apply take the label without conflict, pruning the old one', async () => {
    const labels = { app: 'yaac-registry', 'yaac.project-id': 'p1', 'yaac.install-id': installId() }
    await applyObject(registryDeployment(labels))
    const now = get('deployment', 'yaac-reg-p1')
    expect(now.metadata.labels).toEqual(labels)
    expect(now.spec?.template?.metadata?.labels).toEqual(labels)
    const managers = (now.metadata.managedFields ?? []).map((f) => `${f.manager}/${f.operation}`)
    expect(managers).toContain('yaac/Apply')
  })
})
