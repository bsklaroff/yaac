import path from 'node:path'
import { globalRoot, nodeLocalRoot, serverLocalRoot } from '@yaac/shared/paths'
import { dataDirHash } from './api'
import type { PodMount } from './pod-spec'
import { CHECKOUTS_CLAIM_NAME, GLOBAL_CLAIM_NAME, NODE_LOCAL_NODE_ROOT } from './storage-constants'

/**
 * This install's node-local directory on a node:
 * `/var/lib/yaac/node/<hash>`. The install hash keeps installs (and e2e
 * namespaces) on one cluster apart. On kind an extraMount binds it to
 * `<dataDir>/node-local` on the host (docs/server-in-cluster.md).
 */
export function nodeLocalNodePath(): string {
  return `${NODE_LOCAL_NODE_ROOT}/${dataDirHash()}`
}

/**
 * Turn a workspace `hostPath` mount into its real source, based on which
 * storage root the path is under. Callers declare mounts with the tier
 * helpers (`workspaceDir`, `cachedPackagesDir`, …); only this function
 * knows how each tier is stored.
 *
 * - Global root: a subPath of the `yaac-global` claim, which the server
 *   pod also mounts, so the pod sees what the server wrote. A checkout
 *   (`workspaceDir` in @yaac/shared/project-paths) is the same subPath of
 *   `yaac-checkouts` instead, the same directory mounted with longer
 *   attribute caching (docs/nfs-checkout-performance.md).
 * - Node-local root: the matching path under this install's node directory.
 * - Server-local root, or no root at all: an error.
 * - `emptyDir` and `pvc` sources pass through unchanged.
 *
 * kubelet creates a missing subPath as a root-owned directory, so every
 * global file a pod mounts must exist before its Job is applied.
 */
export function resolveMountSource(m: PodMount): PodMount {
  const { source } = m
  if (source.kind !== 'hostPath') return m
  const global = under(source.path, globalRoot())
  if (global !== null) {
    const claimName = CHECKOUT_SUBPATH.test(global) ? CHECKOUTS_CLAIM_NAME : GLOBAL_CLAIM_NAME
    return { ...m, source: { kind: 'pvc', claimName, subPath: global } }
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

/** A checkout, relative to the global root: `projects/<id>/workspaces/<id>`. */
const CHECKOUT_SUBPATH = /^projects\/[^/]+\/workspaces\/[^/]+$/

/**
 * The node path for a server-side node-local path, as mounted by the store
 * writer and sweep pods. Throws for a path outside the node-local root.
 */
export function nodeLocalHostPath(serverPath: string): string {
  const rel = under(serverPath, nodeLocalRoot())
  if (rel === null) {
    throw new Error(`${serverPath} is not under the node-local root ${nodeLocalRoot()}`)
  }
  return path.posix.join(nodeLocalNodePath(), rel)
}

/**
 * Node-local directories among already-resolved mounts that the pod
 * writes, for its init container to create and chown. Read-only and file
 * mounts are skipped.
 */
export function nodeLocalDirsOf(mounts: PodMount[]): string[] {
  const dirs: string[] = []
  for (const { source, readOnly } of mounts) {
    if (source.kind !== 'hostPath' || readOnly) continue
    if (source.type === 'File' || source.type === 'FileOrCreate') continue
    if (under(source.path, nodeLocalNodePath()) === null) continue
    if (!dirs.includes(source.path)) dirs.push(source.path)
  }
  return dirs
}

/** `p` relative to `root` when it is `root` or inside it, else null. */
function under(p: string, root: string): string | null {
  if (p === root) return ''
  const prefix = root.endsWith('/') ? root : `${root}/`
  return p.startsWith(prefix) ? p.slice(prefix.length) : null
}
