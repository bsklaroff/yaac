import path from 'node:path'
import type { WorkspaceMount, WorkspaceTree } from '#drivers/contract'
import { registryRef, resolveTrustedLayers } from '#drivers/k8s/cluster'
import { k8sWorkspacePaths } from '#drivers/k8s/substrate'

/**
 * Where a life's tree is mounted (docs/node-local-workspaces.md
 * "Layout"). The workspace container sees the node-local tree as its whole
 * root, with each checkout's git dir from the shared tier mounted inside
 * it. The tree container (and a salvage pod, which runs its final pass)
 * sees each at a path of its own, so it needs no mount inside the tree:
 * the tree, its scratch repository, the workspace's checkpoint log, each
 * git dir under `/git/<repo id>`, each main clone read-only at its own path
 * (a checkout's alternates line names it), and the program.
 */
export function treeMounts(t: WorkspaceTree): { workspace: WorkspaceMount[]; container: WorkspaceMount[] } {
  const root = k8sWorkspacePaths().workspaceDir
  const tree = path.posix.join(t.lifeDir, 'tree')
  const at = (p: string): WorkspaceMount['source'] => ({ kind: 'hostPath', path: p })
  return {
    workspace: [
      { source: at(tree), mountPath: root },
      ...t.checkouts.map((c) => ({ source: at(c.gitDir), mountPath: path.posix.join(root, c.path, '.git') })),
    ],
    container: [
      { source: at(tree), mountPath: '/tree' },
      { source: at(path.posix.join(t.lifeDir, 'scratch')), mountPath: '/scratch' },
      { source: at(t.checkpointsDir), mountPath: '/ckpt' },
      ...t.checkouts.map((c) => ({ source: at(c.gitDir), mountPath: `/git/${c.id}` })),
      ...t.mainClones.map((m) => ({ source: at(m), mountPath: m, readOnly: true })),
      { source: { kind: 'hostPath', path: t.program, type: 'File' }, mountPath: '/usr/local/bin/yaac-tree', readOnly: true },
    ],
  }
}

/** The yaac base image, which has git, node and `setpriv` whatever image
 *  the project builds, and holds none of its secrets. */
export async function treeImage(): Promise<string> {
  return registryRef((await resolveTrustedLayers()).base.tag)
}
