import path from 'node:path'
import { env } from '@yaac/shared/env'
import { globalRoot, nodeLocalRoot, serverLocalRoot } from '@yaac/shared/paths'
import { installNameKey } from './install-id'
import type { PodMount } from './pod-spec'
import type { WorkspaceMount } from '#drivers/contract'
import {
  GLOBAL_CLAIM_NAME,
  NODE_LOCAL_NODE_ROOT,
  NODE_MOUNTS_NODE_ROOT,
  SOCKETS_NODE_ROOT,
  VOLUMES_CLAIM_NAME,
  volumeClaimName,
} from './storage-constants'

/**
 * This install's node-local directory on a node:
 * `/var/lib/yaac/node/<install id>`, which keeps installs (and e2e
 * namespaces) on one cluster apart. On kind an extraMount binds it to
 * `<dataDir>/node-local` on the host (docs/server-in-cluster.md). An
 * install from before install ids keeps its legacy path
 * (`installNameKey`), since a kind extraMount cannot change.
 */
export function nodeLocalNodePath(): string {
  return `${NODE_LOCAL_NODE_ROOT}/${installNameKey()}`
}

/** This install's node-mounts root on a node, beside its node-local one. */
export function nodeMountsNodePath(): string {
  return `${NODE_MOUNTS_NODE_ROOT}/${installNameKey()}`
}

/** This install's socket root on a node: one directory per sandbox, named
 *  as its node-mounts directory is (docs/workspace-egress.md). */
export function socketsNodePath(): string {
  return `${SOCKETS_NODE_ROOT}/${installNameKey()}`
}

/**
 * Where a host path is stored, as mountd names it: `shared` (the
 * global claim), `node` (the node-local root) or `volumes` (kind's volumes
 * claim), with the path inside it.
 */
export function storageTierOf(source: WorkspaceMount['source']): { tier: 'shared' | 'node' | 'volumes'; path: string } {
  if (source.kind === 'volume') {
    if (env.volumeStorageClass !== undefined) throw new Error('a byo volume is a claim of its own, not a tier')
    return { tier: 'volumes', path: source.volumeId }
  }
  if (source.kind !== 'hostPath') throw new Error(`a ${source.kind} mount is in no storage tier`)
  const global = under(source.path, globalRoot())
  if (global !== null) return { tier: 'shared', path: global || '.' }
  const nodeLocal = under(source.path, nodeLocalRoot())
  if (nodeLocal !== null) return { tier: 'node', path: nodeLocal || '.' }
  throw new Error(`${source.path} is in no storage tier a workspace may mount (${globalRoot()}, ${nodeLocalRoot()})`)
}

/**
 * Turn a workspace `hostPath` mount into its real source, based on which
 * storage root the path is under. Callers declare mounts with the tier
 * helpers (`workspaceDir`, `cachedPackagesDir`, …); only this function
 * knows how each tier is stored.
 *
 * - Global root: a subPath of the `yaac-global` claim, which the server
 *   pod also mounts, so the pod sees what the server wrote.
 * - Node-local root: the matching path under this install's node directory.
 * - Server-local root, or no root at all: an error.
 * - A volume: its own claim on byo (`YAAC_VOLUME_STORAGE_CLASS` set), else
 *   its directory in the `yaac-volumes` claim (docs/workspace-volumes.md).
 * - `emptyDir` and `pvc` sources pass through unchanged.
 *
 * kubelet creates a missing subPath as a root-owned directory, so every
 * global file a pod mounts, and a kind volume's directory, must exist
 * before its Job is applied.
 */
export function resolveMountSource(m: PodMount | WorkspaceMount): PodMount {
  const { source } = m
  if (source.kind === 'volume') {
    return {
      ...m,
      source: env.volumeStorageClass !== undefined
        ? { kind: 'pvc', claimName: volumeClaimName(source.volumeId) }
        : { kind: 'pvc', claimName: VOLUMES_CLAIM_NAME, subPath: source.volumeId },
    }
  }
  // emptyDir and pvc sources are the same shape in both types.
  if (source.kind !== 'hostPath') return m as PodMount
  const global = under(source.path, globalRoot())
  if (global !== null) {
    return { ...m, source: { kind: 'pvc', claimName: GLOBAL_CLAIM_NAME, subPath: global } }
  }
  const nodeLocal = under(source.path, nodeLocalRoot())
  if (nodeLocal !== null) {
    return {
      ...m,
      source: {
        kind: 'hostPath',
        path: path.posix.join(nodeLocalNodePath(), nodeLocal),
        type: source.type ?? 'DirectoryOrCreate',
      },
    }
  }
  if (under(source.path, serverLocalRoot()) !== null) {
    throw new Error(
      `mount ${m.mountPath}: ${source.path} is SERVER-LOCAL, which no workspace pod may mount`,
    )
  }
  throw new Error(
    `mount ${m.mountPath}: ${source.path} is under no storage tier root `
    + `(${globalRoot()}, ${nodeLocalRoot()}) — declare it through a tier helper`,
  )
}

/** `p` relative to `root` when it is `root` or inside it, else null. */
function under(p: string, root: string): string | null {
  if (p === root) return ''
  const prefix = root.endsWith('/') ? root : `${root}/`
  return p.startsWith(prefix) ? p.slice(prefix.length) : null
}
