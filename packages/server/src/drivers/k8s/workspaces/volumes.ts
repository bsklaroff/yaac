/**
 * Workspace volumes (docs/workspace-volumes.md). On kind a volume is a
 * directory of the `yaac-volumes` claim, which the server pod mounts. On
 * byo it is a claim of its own from `YAAC_VOLUME_STORAGE_CLASS`: the
 * class's provisioner makes its disk and PV, and this module only keeps
 * that PV (`Retain`, labelled) so a namespace delete cannot lose the disk,
 * and re-binds a kept one when the claim is gone.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { env } from '@yaac/shared/env'
import { ServerError } from '@yaac/shared/errors'
import { volumesRoot } from '@yaac/shared/paths'
import {
  LABEL_INSTALL_ID,
  LABEL_INSTALL_NAMESPACE,
  LABEL_VOLUME_ID,
  applyObject,
  deleteObject,
  installId,
  k8sNamespace,
  listObjects,
  patchObject,
  readObject,
  VOLUMES_CLAIM_NAME,
  volumeClaimName,
  type ObjectRef,
} from '#drivers/k8s/substrate'
import { serverLog } from '#lib/log'
import { isUuid } from '#lib/uuid'
import { removeVolumeDirAsRoot } from './root-pod'
import type { VolumeRef } from '#drivers/contract'

interface RawClaim {
  metadata?: { uid?: string; labels?: Record<string, string> }
  spec?: { volumeName?: string }
  status?: { phase?: string }
}

interface RawVolume {
  metadata?: { name?: string; labels?: Record<string, string>; annotations?: Record<string, string> }
  spec?: {
    storageClassName?: string
    capacity?: { storage?: string }
    persistentVolumeReclaimPolicy?: string
    claimRef?: { uid?: string }
  }
  status?: { phase?: string }
}

/** Set by the external provisioner on every PV it made. */
const PROVISIONED_BY = 'pv.kubernetes.io/provisioned-by'

const claimRef = (volumeId: string): ObjectRef => ({
  apiVersion: 'v1', kind: 'PersistentVolumeClaim', name: volumeClaimName(volumeId), namespace: k8sNamespace(),
})

const pvRef = (name: string): ObjectRef => ({ apiVersion: 'v1', kind: 'PersistentVolume', name })

function volumeLabels(volumeId: string): Record<string, string> {
  return {
    [LABEL_INSTALL_ID]: installId(),
    [LABEL_INSTALL_NAMESPACE]: k8sNamespace(),
    [LABEL_VOLUME_ID]: volumeId,
  }
}

/** Whether a PV carries this install's id and `volumeId`: one the server
 *  pinned, or an operator restored for that volume. */
function isVolumesPv(pv: RawVolume | null, volumeId: string): boolean {
  const labels = pv?.metadata?.labels ?? {}
  return labels[LABEL_INSTALL_ID] === installId() && labels[LABEL_VOLUME_ID] === volumeId
}

/** This install's PVs for a volume that no claim holds: one a namespace
 *  delete left `Released`, or one an operator restored as `Available`. */
async function keptVolume(volumeId: string): Promise<RawVolume | undefined> {
  const pvs = await listObjects<RawVolume>('v1', 'PersistentVolume', {
    labelSelector: `${LABEL_INSTALL_ID}=${installId()},${LABEL_VOLUME_ID}=${volumeId}`,
  })
  return pvs.find((pv) => pv.status?.phase === 'Released' || pv.status?.phase === 'Available')
}

/** See `WorkspaceDriver.ensureVolume`. */
export async function ensureVolume(volume: VolumeRef): Promise<void> {
  const className = env.volumeStorageClass
  if (className === undefined) {
    // kubelet would create a missing subPath root-owned.
    await fs.mkdir(path.join(volumesRoot(), volume.id), { recursive: true })
    return
  }
  if (await readObject(claimRef(volume.id))) return
  const kept = await keptVolume(volume.id)
  const keptName = kept?.metadata?.name
  if (keptName === undefined && volume.pinned) {
    throw new ServerError('NOT_FOUND', 'this volume\'s disk is gone: its claim was deleted and no '
      + `PersistentVolume labelled ${LABEL_VOLUME_ID}=${volume.id} is left to re-bind. Restore its PV `
      + `with that label and ${LABEL_INSTALL_ID}=${installId()}, or delete the volume.`)
  }
  if (keptName !== undefined && kept?.status?.phase === 'Released') {
    // Its claimRef still names the deleted claim's uid, so it binds nothing.
    await patchObject(pvRef(keptName), {
      spec: { claimRef: { namespace: k8sNamespace(), name: volumeClaimName(volume.id), uid: null, resourceVersion: null } },
    })
  }
  await applyObject({
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: volumeClaimName(volume.id), namespace: k8sNamespace(), labels: volumeLabels(volume.id) },
    spec: {
      accessModes: ['ReadWriteOnce'],
      storageClassName: kept?.spec?.storageClassName ?? className,
      resources: { requests: { storage: kept?.spec?.capacity?.storage ?? volume.size } },
      ...(keptName !== undefined ? { volumeName: keptName } : {}),
    },
  })
}

/**
 * See `WorkspaceDriver.pinVolumes`. A fresh claim can bind any Available PV
 * of its class, not only one provisioned for it, so a PV is kept only if it
 * is bound to this very claim and is either the provisioner's (unlabelled)
 * or already this volume's. Any other is left alone and logged: relabelling
 * it would make another volume's disk, or one yaac never made, this one's.
 */
export async function pinVolumes(volumeIds: string[]): Promise<string[]> {
  if (env.volumeStorageClass === undefined) return []
  const pinned: string[] = []
  for (const id of volumeIds) {
    const claim = await readObject<RawClaim>(claimRef(id))
    const pvName = claim?.status?.phase === 'Bound' ? claim.spec?.volumeName : undefined
    if (pvName === undefined) continue
    const pv = await readObject<RawVolume>(pvRef(pvName))
    const labels = pv?.metadata?.labels ?? {}
    const fresh = labels[LABEL_VOLUME_ID] === undefined && labels[LABEL_INSTALL_ID] === undefined
      && pv?.metadata?.annotations?.[PROVISIONED_BY] !== undefined
    if (pv?.spec?.claimRef?.uid !== claim?.metadata?.uid || !(fresh || isVolumesPv(pv, id))) {
      serverLog(`[volumes] not keeping PV ${pvName} for volume ${id}: it was not provisioned for this `
        + 'volume\'s claim, so its labels and reclaim policy are left as they are')
      continue
    }
    await patchObject(pvRef(pvName), {
      metadata: { labels: volumeLabels(id) },
      spec: { persistentVolumeReclaimPolicy: 'Retain' },
    })
    pinned.push(id)
  }
  return pinned
}

/** See `WorkspaceDriver.resizeVolume`. A volume whose claim does not exist
 *  yet gets the new size when it is made. */
export async function resizeVolume(volume: VolumeRef, size: string): Promise<void> {
  const className = env.volumeStorageClass
  if (className === undefined) {
    throw new ServerError('NOT_SUPPORTED', 'a volume on this cluster is a host directory, with no size to grow')
  }
  const sc = await readObject<{ allowVolumeExpansion?: boolean }>({
    apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', name: className,
  })
  if (sc?.allowVolumeExpansion !== true) {
    throw new ServerError('NOT_SUPPORTED', `storage class ${className} does not allow volume expansion`)
  }
  if (!await readObject(claimRef(volume.id))) return
  await patchObject(claimRef(volume.id), { spec: { resources: { requests: { storage: size } } } })
}

/**
 * See `WorkspaceDriver.deleteVolume`. On byo every PV of the volume (those
 * labelled with this install and volume, which are the ones it pinned) is
 * set to `Delete` first: deleting a kept PV's claim alone would leave its
 * disk orphaned, still billed. A PV it bound but never pinned keeps its own
 * policy.
 */
export async function deleteVolume(volumeId: string): Promise<void> {
  if (env.volumeStorageClass === undefined) {
    const dir = path.join(volumesRoot(), volumeId)
    try {
      await fs.rm(dir, { recursive: true, force: true })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EACCES' && code !== 'EPERM') throw err
      await removeVolumeDirAsRoot(volumeId)
      await fs.rm(dir, { recursive: true, force: true })
    }
    return
  }
  const claim = await readObject<RawClaim>(claimRef(volumeId))
  const names = new Set<string>()
  const bound = claim?.spec?.volumeName
  if (bound && isVolumesPv(await readObject<RawVolume>(pvRef(bound)), volumeId)) names.add(bound)
  const kept = (await keptVolume(volumeId))?.metadata?.name
  if (kept !== undefined) names.add(kept)
  for (const name of names) {
    await patchObject(pvRef(name), { spec: { persistentVolumeReclaimPolicy: 'Delete' } })
  }
  await deleteObject(claimRef(volumeId))
}

/**
 * See `WorkspaceDriver.volumeStorage`. Every pod object counts, whatever its
 * phase, so a Pending or Terminating one keeps its volume mounted.
 */
export async function volumeStorage(): Promise<Array<{ volumeId: string; mounted: boolean }>> {
  const pods = await listObjects<RawPod>('v1', 'Pod', { namespace: k8sNamespace() })
  const stored = env.volumeStorageClass === undefined ? await volumeDirs() : await volumeObjects()
  return stored.map((volumeId) => ({ volumeId, mounted: pods.some((pod) => mounts(pod, volumeId)) }))
}

interface RawPod {
  spec?: {
    volumes?: Array<{ name?: string; persistentVolumeClaim?: { claimName?: string } }>
    containers?: Array<{ volumeMounts?: Array<{ name?: string; subPath?: string }> }>
    initContainers?: Array<{ volumeMounts?: Array<{ name?: string; subPath?: string }> }>
  }
}

/** Whether a pod mounts a volume: its own claim (byo), or its directory of
 *  `yaac-volumes` (kind). */
function mounts(pod: RawPod, volumeId: string): boolean {
  const claimed = (pod.spec?.volumes ?? []).filter((v) => v.persistentVolumeClaim !== undefined)
  if (claimed.some((v) => v.persistentVolumeClaim?.claimName === volumeClaimName(volumeId))) return true
  const shared = new Set(claimed.filter((v) => v.persistentVolumeClaim?.claimName === VOLUMES_CLAIM_NAME).map((v) => v.name))
  return [...pod.spec?.containers ?? [], ...pod.spec?.initContainers ?? []]
    .some((c) => (c.volumeMounts ?? []).some((m) => shared.has(m.name) && m.subPath === volumeId))
}

/** kind: the volume directories under the volumes root. */
async function volumeDirs(): Promise<string[]> {
  // Only a missing root reads as no storage: a sweep forgets the deletes
  // whose storage it does not see, so a failed read must fail the pass.
  const entries = await fs.readdir(volumesRoot(), { withFileTypes: true }).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  })
  return entries.filter((e) => e.isDirectory() && isUuid(e.name)).map((e) => e.name)
}

/** byo: the volumes this install has a claim or a kept PV for. */
async function volumeObjects(): Promise<string[]> {
  const selector = { labelSelector: `${LABEL_INSTALL_ID}=${installId()},${LABEL_VOLUME_ID}` }
  const claims = await listObjects<RawClaim>('v1', 'PersistentVolumeClaim', { namespace: k8sNamespace(), ...selector })
  const kept = (await listObjects<RawVolume>('v1', 'PersistentVolume', selector))
    .filter((pv) => pv.status?.phase === 'Released' || pv.status?.phase === 'Available')
  return [...new Set([...claims, ...kept].flatMap((o) => o.metadata?.labels?.[LABEL_VOLUME_ID] ?? []))]
}
