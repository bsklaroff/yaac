import path from 'node:path'
import type { WorkspaceMount, WorkspaceTree } from '#drivers/contract'
import { registryRef, resolveTrustedLayers } from '#drivers/k8s/cluster'

/**
 * Where a one-shot pod doing the tree container's work (a salvage or an
 * import) sees a life's things (docs/node-local-workspaces.md "Layout"):
 * the tree, its scratch repository, the workspace's checkpoint log, each
 * git dir under `/git/<repo id>`, each main clone read-only at its own path
 * (a checkout's alternates line names it), and the program.
 */
export function treeContainerMounts(t: WorkspaceTree): WorkspaceMount[] {
  const at = (p: string): WorkspaceMount['source'] => ({ kind: 'hostPath', path: p })
  return [
    { source: at(path.posix.join(t.lifeDir, 'tree')), mountPath: '/tree' },
    { source: at(path.posix.join(t.lifeDir, 'scratch')), mountPath: '/scratch' },
    { source: at(t.checkpointsDir), mountPath: '/ckpt' },
    ...t.checkouts.map((c) => ({ source: at(c.gitDir), mountPath: `/git/${c.id}` })),
    ...t.mainClones.map((m) => ({ source: at(m), mountPath: m, readOnly: true })),
    { source: { kind: 'hostPath', path: t.program, type: 'File' }, mountPath: '/usr/local/bin/yaac-tree', readOnly: true },
  ]
}

/** The yaac base image, which has git, node and `setpriv` whatever image
 *  the project builds, and holds none of its secrets. */
export async function treeImage(): Promise<string> {
  return registryRef((await resolveTrustedLayers()).base.tag)
}
