/**
 * A byo volume's claim and PV writes (`drivers/k8s/workspaces/volumes.ts`,
 * docs/workspace-volumes.md) against a real kube-apiserver, read back with
 * kubectl. Nothing here runs controllers, so the provisioner's and binder's
 * work (a PV, a claim's phase) is written by hand through kubectl.
 */
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { applyObject, ensureKubernetes } from '@yaac/server/drivers/k8s/substrate/api'
import { installId } from '@yaac/server/drivers/k8s/substrate/install-id'
import { deleteVolume, ensureVolume, pinVolumes, resizeVolume } from '@yaac/server/drivers/k8s/workspaces/volumes'

const NS = 'yaac-volumes'
const CLASS = 'apiserver-rwo'
const ID = '2c6e1a4b-8d3f-4e7a-9b5c-1d2e3f4a5b6c'
const CLAIM = `yaac-volume-${ID}`
let kubectlBin = ''
let saved: Record<string, string | undefined> = {}

const kubectl = (args: string[], input?: string): string =>
  execFileSync(kubectlBin, args, { encoding: 'utf8', ...(input !== undefined ? { input } : {}) })
const get = <T>(kind: string, name: string): T =>
  JSON.parse(kubectl(['get', kind, name, ...(kind === 'pv' ? [] : ['-n', NS]), '-o', 'json'])) as T

interface Claim {
  metadata: { labels: Record<string, string>; deletionTimestamp?: string }
  spec: { storageClassName: string; volumeName?: string; resources: { requests: { storage: string } } }
}
interface Pv {
  metadata: { labels?: Record<string, string> }
  spec: { persistentVolumeReclaimPolicy: string; claimRef?: { name: string; uid?: string; resourceVersion?: string } }
}

beforeAll(async () => {
  saved = { KUBECONFIG: process.env.KUBECONFIG, YAAC_K8S_NAMESPACE: process.env.YAAC_K8S_NAMESPACE, YAAC_VOLUME_STORAGE_CLASS: process.env.YAAC_VOLUME_STORAGE_CLASS }
  process.env.KUBECONFIG = inject('apiserverKubeconfig')
  process.env.YAAC_K8S_NAMESPACE = NS
  process.env.YAAC_VOLUME_STORAGE_CLASS = CLASS
  kubectlBin = inject('apiserverKubectl')
  await ensureKubernetes()
  await applyObject({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS } })
  await applyObject({
    apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', metadata: { name: CLASS },
    provisioner: 'example.com/disk', allowVolumeExpansion: true, volumeBindingMode: 'WaitForFirstConsumer',
  })
})

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('byo volume claims', () => {
  it('re-binds a kept disk, pins it, grows it, and hands it back to its provisioner on delete', async () => {
    // A disk a namespace delete left behind: Released, still naming the
    // deleted claim's uid.
    kubectl(['apply', '-f', '-'], JSON.stringify({
      apiVersion: 'v1', kind: 'PersistentVolume',
      metadata: { name: 'pvc-kept', labels: { 'yaac.install-id': installId(), 'yaac.volume-id': ID } },
      spec: {
        capacity: { storage: '10Gi' }, accessModes: ['ReadWriteOnce'], storageClassName: CLASS,
        persistentVolumeReclaimPolicy: 'Retain', hostPath: { path: '/tmp/kept' },
        claimRef: { namespace: NS, name: CLAIM, uid: '00000000-0000-0000-0000-000000000000' },
      },
    }))
    kubectl(['patch', 'pv', 'pvc-kept', '--subresource=status', '--type=merge', '-p', '{"status":{"phase":"Released"}}'])

    await ensureVolume({ id: ID, size: '5Gi', pinned: true })
    const kept = get<Pv>('pv', 'pvc-kept')
    expect(kept.spec.claimRef).toMatchObject({ name: CLAIM })
    expect(kept.spec.claimRef?.uid).toBeUndefined()
    expect(get<Claim>('pvc', CLAIM)).toMatchObject({
      metadata: { labels: { 'yaac.install-id': installId(), 'yaac.volume-id': ID } },
      spec: { storageClassName: CLASS, volumeName: 'pvc-kept', resources: { requests: { storage: '10Gi' } } },
    })

    // Not bound yet: nothing to pin.
    expect(await pinVolumes([ID])).toEqual([])
    // The binder's part: the claim Bound, and the PV naming its uid.
    kubectl(['patch', 'pvc', CLAIM, '-n', NS, '--subresource=status', '--type=merge', '-p', '{"status":{"phase":"Bound"}}'])
    const uid = get<{ metadata: { uid: string } }>('pvc', CLAIM).metadata.uid
    kubectl(['patch', 'pv', 'pvc-kept', '--type=merge', '-p', JSON.stringify({ spec: { claimRef: { uid } } })])
    kubectl(['patch', 'pv', 'pvc-kept', '--type=merge', '-p', '{"spec":{"persistentVolumeReclaimPolicy":"Delete"}}'])
    expect(await pinVolumes([ID])).toEqual([ID])
    expect(get<Pv>('pv', 'pvc-kept').spec.persistentVolumeReclaimPolicy).toBe('Retain')

    await resizeVolume({ id: ID, size: '10Gi', pinned: true }, '20Gi')
    expect(get<Claim>('pvc', CLAIM).spec.resources.requests.storage).toBe('20Gi')

    await deleteVolume(ID)
    expect(get<Pv>('pv', 'pvc-kept').spec.persistentVolumeReclaimPolicy).toBe('Delete')
    // Gone, or held only by the protection finalizer no controller here clears.
    const left = kubectl(['get', 'pvc', '-n', NS, '-o', 'json'])
    const items = (JSON.parse(left) as { items: Claim[] }).items
    expect(items.every((c) => c.metadata.deletionTimestamp !== undefined)).toBe(true)
  })
})
