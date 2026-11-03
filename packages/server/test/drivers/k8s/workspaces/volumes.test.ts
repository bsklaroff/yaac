/**
 * Workspace volumes on both cluster shapes: a directory of `yaac-volumes`
 * on kind, and on byo a claim of the volume's own whose PV the server keeps
 * and re-binds (docs/workspace-volumes.md). The cluster is `fakeCluster`;
 * its provisioner is played by seeding the PV a bound claim would get.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { deleteVolume, ensureVolume, pinVolumes, resizeVolume, volumeStorage } from '#drivers/k8s/workspaces'
import { installId, k8sNamespace } from '#drivers/k8s/substrate'
import { volumesRoot } from '@yaac/shared/paths'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'

const ID = '0b9c3f7e-5d2a-4c1b-9e8f-7a6b5c4d3e2f'
const CLAIM = `yaac-volume-${ID}`
const CLASS = 'hcloud-volumes'

interface Claim {
  metadata: { uid: string; labels: Record<string, string> }
  spec: { storageClassName: string; volumeName?: string; resources: { requests: { storage: string } } }
}

interface Pv {
  metadata: { labels?: Record<string, string> }
  spec: { persistentVolumeReclaimPolicy: string; claimRef?: { uid?: string | null; name?: string } }
}

const claim = (): Claim | undefined => fakeCluster.get<Claim>('PersistentVolumeClaim', CLAIM, k8sNamespace())
const pv = (name: string): Pv | undefined => fakeCluster.get<Pv>('PersistentVolume', name)

/**
 * The binder's work once a pod mounts the claim: the claim bound to a PV,
 * by default one the provisioner made for it; `existing` labels or
 * annotations say otherwise, as for a PV that was already there.
 */
function bind(pvName: string, existing?: { labels?: Record<string, string>; provisioned?: false }): void {
  const c = claim()
  if (!c) throw new Error('no claim to bind')
  fakeCluster.seed(
    { ...c, apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { ...c.metadata, name: CLAIM, namespace: k8sNamespace() },
      spec: { ...c.spec, volumeName: pvName }, status: { phase: 'Bound' } },
    { apiVersion: 'v1', kind: 'PersistentVolume',
      metadata: {
        name: pvName,
        ...(existing?.labels ? { labels: existing.labels } : {}),
        ...(existing?.provisioned === false ? {} : { annotations: { 'pv.kubernetes.io/provisioned-by': 'csi.hetzner.cloud' } }),
      },
      spec: { persistentVolumeReclaimPolicy: 'Delete', storageClassName: CLASS, capacity: { storage: '10Gi' },
        claimRef: { name: CLAIM, namespace: k8sNamespace(), uid: c.metadata.uid } },
      status: { phase: 'Bound' } },
  )
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await cleanupTempDir(tmpDir)
})

const byo = (): void => { vi.stubEnv('YAAC_VOLUME_STORAGE_CLASS', CLASS) }

describe('ensureVolume', () => {
  it('on kind makes the directory, and no claim', async () => {
    await ensureVolume({ id: ID, size: '10Gi', pinned: false })
    expect((await fs.stat(path.join(volumesRoot(), ID))).isDirectory()).toBe(true)
    expect(fakeCluster.objects('PersistentVolumeClaim')).toEqual([])
  })

  it('on byo applies a labelled claim from the class, then leaves an existing one be', async () => {
    byo()
    await ensureVolume({ id: ID, size: '5Gi', pinned: false })
    expect(claim()).toMatchObject({
      metadata: { labels: { 'yaac.install-id': installId(), 'yaac.volume-id': ID } },
      spec: { storageClassName: CLASS, resources: { requests: { storage: '5Gi' } } },
    })
    expect(claim()?.spec.volumeName).toBeUndefined()
    await ensureVolume({ id: ID, size: '5Gi', pinned: true })
    expect(fakeCluster.callsOf('apply', 'PersistentVolumeClaim')).toHaveLength(1)
  })

  it('re-binds the kept disk of a claim a namespace delete took, and refuses a pinned one with none', async () => {
    byo()
    await expect(ensureVolume({ id: ID, size: '10Gi', pinned: true })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(claim()).toBeUndefined()

    fakeCluster.seed({
      apiVersion: 'v1', kind: 'PersistentVolume',
      metadata: { name: 'pvc-old', labels: { 'yaac.install-id': installId(), 'yaac.volume-id': ID } },
      spec: { persistentVolumeReclaimPolicy: 'Retain', storageClassName: CLASS, capacity: { storage: '20Gi' },
        claimRef: { name: CLAIM, namespace: k8sNamespace(), uid: 'gone-uid' } },
      status: { phase: 'Released' },
    })
    await ensureVolume({ id: ID, size: '10Gi', pinned: true })
    // The stale reference to the deleted claim is cleared, and the new claim
    // names the kept PV at its size.
    expect(pv('pvc-old')?.spec.claimRef?.uid).toBeUndefined()
    expect(claim()?.spec).toMatchObject({ volumeName: 'pvc-old', resources: { requests: { storage: '20Gi' } } })
  })
})

describe('pinVolumes', () => {
  it('keeps and labels a bound disk, and skips a claim not bound yet', async () => {
    expect(await pinVolumes([ID])).toEqual([])
    byo()
    await ensureVolume({ id: ID, size: '10Gi', pinned: false })
    expect(await pinVolumes([ID])).toEqual([])
    bind('pvc-1')
    expect(await pinVolumes([ID])).toEqual([ID])
    expect(pv('pvc-1')).toMatchObject({
      metadata: { labels: { 'yaac.install-id': installId(), 'yaac.volume-id': ID } },
      spec: { persistentVolumeReclaimPolicy: 'Retain' },
    })
  })
})

describe('pinVolumes (a claim bound to a PV it was not provisioned)', () => {
  it("leaves another volume's disk, and a PV yaac never made, as they are", async () => {
    byo()
    const other = { 'yaac.install-id': installId(), 'yaac.volume-id': 'another-volume' }
    await ensureVolume({ id: ID, size: '10Gi', pinned: false })
    bind('pvc-b', { labels: other, provisioned: false })
    expect(await pinVolumes([ID])).toEqual([])
    expect(pv('pvc-b')).toMatchObject({ metadata: { labels: other }, spec: { persistentVolumeReclaimPolicy: 'Delete' } })

    bind('pv-static', { provisioned: false })
    expect(await pinVolumes([ID])).toEqual([])
    expect(pv('pv-static')?.metadata.labels).toBeUndefined()
    // Nor does a delete hand either back for deletion.
    fakeCluster.seed({ apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: 'pv-static' },
      spec: { persistentVolumeReclaimPolicy: 'Retain' }, status: { phase: 'Bound' } })
    await deleteVolume(ID)
    expect(pv('pv-static')?.spec.persistentVolumeReclaimPolicy).toBe('Retain')
  })
})

describe('volumeStorage', () => {
  const pod = (name: string, spec: Record<string, unknown>) => ({
    apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: k8sNamespace() }, spec,
  })

  it('on kind lists the volume directories, and which a pod mounts', async () => {
    const mounted = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
    for (const id of [ID, mounted]) await ensureVolume({ id, size: '1Gi', pinned: false })
    await fs.mkdir(path.join(volumesRoot(), 'not-a-volume'))
    fakeCluster.seed(pod('ws', {
      volumes: [{ name: 'pv-3', persistentVolumeClaim: { claimName: 'yaac-volumes' } }],
      containers: [{ name: 'c', volumeMounts: [{ name: 'pv-3', mountPath: '/home/yaac/volume', subPath: mounted }] }],
    }))
    expect((await volumeStorage()).sort((a, b) => a.volumeId.localeCompare(b.volumeId)))
      .toEqual([{ volumeId: ID, mounted: false }, { volumeId: mounted, mounted: true }]
        .sort((a, b) => a.volumeId.localeCompare(b.volumeId)))
  })

  it('on kind reads a missing volumes root as no storage, and fails on any other read error', async () => {
    expect(await volumeStorage()).toEqual([])
    await fs.writeFile(volumesRoot(), 'not a directory')
    await expect(volumeStorage()).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('on byo lists the volumes with a claim or a kept PV, and which a pod mounts', async () => {
    byo()
    await ensureVolume({ id: ID, size: '10Gi', pinned: false })
    const released = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
    fakeCluster.seed({ apiVersion: 'v1', kind: 'PersistentVolume',
      metadata: { name: 'pvc-old', labels: { 'yaac.install-id': installId(), 'yaac.volume-id': released } },
      spec: {}, status: { phase: 'Released' } })
    const mountedIds = async (): Promise<string[]> => (await volumeStorage()).filter((v) => v.mounted).map((v) => v.volumeId)
    expect((await volumeStorage()).map((v) => v.volumeId).sort()).toEqual([ID, released].sort())
    expect(await mountedIds()).toEqual([])
    fakeCluster.seed(pod('ws', { volumes: [{ name: 'pv-0', persistentVolumeClaim: { claimName: CLAIM } }], containers: [] }))
    expect(await mountedIds()).toEqual([ID])
  })
})

describe('resizeVolume', () => {
  it('refuses on kind and on a class that cannot expand, and grows the claim on one that can', async () => {
    await expect(resizeVolume({ id: ID, size: '10Gi', pinned: false }, '20Gi')).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    byo()
    fakeCluster.seed({ apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', metadata: { name: CLASS } })
    await ensureVolume({ id: ID, size: '10Gi', pinned: false })
    await expect(resizeVolume({ id: ID, size: '10Gi', pinned: false }, '20Gi')).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    fakeCluster.seed({ apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', metadata: { name: CLASS }, allowVolumeExpansion: true })
    await resizeVolume({ id: ID, size: '10Gi', pinned: false }, '20Gi')
    expect(claim()?.spec.resources.requests.storage).toBe('20Gi')
  })
})

describe('deleteVolume', () => {
  it('on kind removes the directory', async () => {
    await ensureVolume({ id: ID, size: '10Gi', pinned: false })
    await fs.writeFile(path.join(volumesRoot(), ID, 'state.json'), '{}')
    await deleteVolume(ID)
    await expect(fs.stat(path.join(volumesRoot(), ID))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('on byo hands a kept disk back to its provisioner before deleting the claim', async () => {
    byo()
    await ensureVolume({ id: ID, size: '10Gi', pinned: false })
    bind('pvc-1')
    await pinVolumes([ID])
    await deleteVolume(ID)
    expect(pv('pvc-1')?.spec.persistentVolumeReclaimPolicy).toBe('Delete')
    expect(claim()).toBeUndefined()
    // The server never deletes a PV itself.
    expect(fakeCluster.callsOf('delete', 'PersistentVolume')).toEqual([])
  })
})
