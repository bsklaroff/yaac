import path from 'node:path'
import { globalRoot, nodeLocalRoot, serverLocalRoot } from '@yaac/shared/paths'
import { dataDirHash } from './kubectl'
import type { PodMount } from './pod-spec'
import { GLOBAL_CLAIM_NAME, NODE_LOCAL_NODE_ROOT } from './storage-constants'

/**
 * This install's NODE-LOCAL tree on a node: `/var/lib/yaac/node/<hash>`.
 * Hashed by the install identity so the real install and every e2e
 * namespace on one cluster keep separate node directories; on kind the
 * second extraMount binds it to `<dataDir>/node-local` on the host
 * (docs/server-in-cluster.md "Storage is two claims").
 */
export function nodeLocalNodePath(): string {
  return `${NODE_LOCAL_NODE_ROOT}/${dataDirHash()}`
}

/**
 * Where a worktree mount's bytes come from, resolved from the storage
 * tier its path declares.
 *
 * The layers above the driver declare every mount as a `hostPath` against
 * a tier helper (`worktreeDir`, `cachedPackagesDir`, …) and never learn
 * how the tier is realized; this is the one place that knows. A path under
 * the GLOBAL root becomes a subPath of the `yaac-global` claim — the same
 * claim the server pod has mounted whole, so the subtree the pod sees is
 * the one the server wrote. A path under the NODE-LOCAL root becomes the
 * matching path under the node's own tree, which is host disk on kind
 * (through the second kind extraMount) and node disk on a cloud node. An
 * `emptyDir` or `pvc` source passes through: it declared no host path to
 * resolve.
 *
 * The roots are siblings on the host and inside the pod, so this is a
 * plain prefix test with no ordering concern. A path under SERVER-LOCAL
 * is a thrown error — a worktree pod may not mount the server's claim —
 * and so is a path under no root at all, because every product path is
 * tiered and an untiered one is a caller that bypassed the helpers.
 *
 * A `File` hostPath becomes a subPath to that file. kubelet bind-mounts an
 * existing file at a subPath; a subPath that does not exist is created as
 * a root-owned DIRECTORY, so the create's ordering — every global file
 * and directory a pod mounts exists before the Job is applied — is what
 * replaced the `type: File` guard that used to fail such a mount loudly.
 */
export function resolveMountSource(m: PodMount): PodMount {
  const { source } = m
  if (source.kind !== 'hostPath') return m
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
      `mount ${m.mountPath}: ${source.path} is SERVER-LOCAL, which no worktree pod may mount`,
    )
  }
  throw new Error(
    `mount ${m.mountPath}: ${source.path} is under no storage tier root `
    + `(${globalRoot()}, ${nodeLocalRoot()}) — declare it through a tier helper`,
  )
}

/**
 * The node path of a NODE-LOCAL server-side path — what the store writer
 * and the sweep pods mount. Throws for a path outside the tier.
 */
export function nodeLocalHostPath(serverPath: string): string {
  const rel = under(serverPath, nodeLocalRoot())
  if (rel === null) {
    throw new Error(`${serverPath} is not under the node-local root ${nodeLocalRoot()}`)
  }
  return path.posix.join(nodeLocalNodePath(), rel)
}

/**
 * The node paths of every NODE-LOCAL directory among RESOLVED mounts that
 * the pod WRITES, for its init container to create and chown. Read-only
 * mounts are excluded — an image-store generation is a node-side writer's
 * to own, and kubelet creates a missing one on its own — and so are File
 * mounts: a file subPath has to exist already, and none is node-local.
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
