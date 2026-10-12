import { k8sNamespace, listObjects, patchObject } from './api'
import { installId } from './install-id'
import { LABEL_INSTALL_ID } from './storage-constants'

/**
 * Legacy: an install from before install ids labelled its objects with a
 * hash of its data dir's path, under one of these four keys, and nothing
 * else. The startup relabel adds `yaac.install-id` to each such object, so
 * every selector finds it (docs/legacy-compat-shims.md).
 */
const LEGACY_HASH_LABELS = [
  'yaac.data-dir-hash',
  'yaac.registry-data-dir-hash',
  'yaac.sweep-data-dir-hash',
  'yaac.store-data-dir-hash',
]

/**
 * The namespaced kinds that carried a legacy label. Volumes are left to
 * `yaac cluster install`, which relabels them as it ensures them; the
 * server may not write them.
 */
const LABELLED_KINDS: Array<{ apiVersion: string; kind: string }> = [
  { apiVersion: 'batch/v1', kind: 'Job' },
  { apiVersion: 'v1', kind: 'Pod' },
  { apiVersion: 'apps/v1', kind: 'Deployment' },
  { apiVersion: 'v1', kind: 'Service' },
  { apiVersion: 'v1', kind: 'PersistentVolumeClaim' },
  { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy' },
]

/**
 * Add this install's `yaac.install-id` to every object in its namespace
 * labelled with `hash` under a legacy key and still lacking one. Returns
 * how many it labelled. Repeatable: a second run finds nothing.
 */
export async function relabelLegacyObjects(hash: string): Promise<number> {
  const namespace = k8sNamespace()
  let count = 0
  for (const { apiVersion, kind } of LABELLED_KINDS) {
    for (const key of LEGACY_HASH_LABELS) {
      const items = await listObjects<{ metadata?: { name?: string } }>(apiVersion, kind, {
        namespace, labelSelector: `${key}=${hash},!${LABEL_INSTALL_ID}`,
      })
      for (const item of items) {
        const name = item.metadata?.name
        if (!name) continue
        await patchObject({ apiVersion, kind, name, namespace }, { metadata: { labels: { [LABEL_INSTALL_ID]: installId() } } })
        count++
      }
    }
  }
  return count
}

/**
 * The legacy hash a server Deployment's pod template carries, for `yaac
 * cluster install` to record before it re-applies the Deployment.
 */
export function legacyHashOf(labels: Record<string, string> | undefined): string | undefined {
  return labels?.[LEGACY_HASH_LABELS[0]]
}
