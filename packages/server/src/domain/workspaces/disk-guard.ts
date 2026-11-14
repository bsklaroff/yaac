import type { NodeDisk, NodeDiskTree } from '@yaac/shared/types'
import type { RuntimeHandle, RuntimeSnapshot } from '#drivers/contract'
import { workspaceDriver } from '#drivers/driver'
import { listUnstampedTreeLives } from '#db'
import { serverLog } from '#lib/log'
import { cleanupWorkspaceDetached } from './cleanup'

/**
 * The full-node guard's stop (docs/node-local-workspaces.md "A full
 * node"). On a node under its stop floor it stops the running workspace
 * filling the largest tree there, one at a time per node, until the node is
 * back above the floor. That is an ordinary stop with a death reason naming the disk
 * the tree held. A node whose largest tree is small is left alone: something
 * else filled its disk (images, a package store), and the health report says
 * so instead.
 */

const GiB = 1024 ** 3
/** A tree smaller than this is never the reason a node is full. */
export const LARGE_TREE_BYTES = 1 * GiB
/** How long a stop this step made holds its node back from another, until
 *  the runtime shows it as terminating. */
const STOPPING_MS = 5 * 60_000

/** Workspaces this step stopped, with when and on which node. */
const stopping = new Map<string, { at: number; node: string }>()
/** Nodes whose fullness has been logged as not a workspace's doing. */
const reported = new Set<string>()

const gib = (b: number): string => `${(b / GiB).toFixed(1)} GiB`

function reportOnce(node: string, message: string): void {
  if (reported.has(node)) return
  reported.add(node)
  serverLog(`[disk-guard] ${message}`)
}

export async function reconcileDiskGuard(snapshot: RuntimeSnapshot): Promise<void> {
  const driver = workspaceDriver()
  const quick = await driver.nodeDisks({ trees: false })
  if (!quick.some(underStop)) {
    reported.clear()
    return
  }
  const [disks, handles, lives] = await Promise.all([
    driver.nodeDisks({ trees: true }), snapshot.workspaces(), listUnstampedTreeLives({ stopped: false }),
  ])
  // The tree each running workspace's current life fills.
  const lifeOf = new Map(lives.map((l) => [l.workspaceId, l.treeDir]))
  const now = Date.now()
  // A stop has landed once the runtime no longer shows the workspace.
  for (const [id, s] of stopping) {
    if (now - s.at > STOPPING_MS || !handles.some((h) => h.workspaceId === id)) stopping.delete(id)
  }
  for (const d of disks.filter(underStop)) {
    // One stop at a time per node: until the last one has landed, its tree
    // is still there and the node still reads as full.
    const inFlight = handles.some((h) => h.node === d.node && h.terminating)
      || [...stopping.values()].some((s) => s.node === d.node)
    if (inFlight) continue
    if (d.truncated === true) {
      reportOnce(d.node, `node ${d.node} is under its ${gib(d.stopBytes)} floor, but its trees could not all be measured; nothing is stopped`)
      continue
    }
    // Only a tree the workspace is filling now, on the node it runs on:
    // stopping it for one an earlier life left would free nothing.
    const owner = (t: NodeDiskTree): RuntimeHandle | undefined => handles.find((h) =>
      h.workspaceId === t.workspaceId && h.state === 'running' && !h.terminating && h.node === d.node
      && lifeOf.get(t.workspaceId) === t.life)
    const tree = (d.trees ?? []).find((t) => t.bytes >= LARGE_TREE_BYTES && owner(t) !== undefined)
    const handle = tree ? owner(tree) : undefined
    if (!tree || !handle) {
      reportOnce(d.node, `node ${d.node} has ${gib(d.freeBytes)} free, under its ${gib(d.stopBytes)} floor, `
        + `but no running workspace there fills a tree of ${gib(LARGE_TREE_BYTES)} or more; nothing is stopped`)
      continue
    }
    stopping.set(tree.workspaceId, { at: now, node: d.node })
    const detail = `its files held ${gib(tree.bytes)} on node ${d.node}, which had ${gib(d.freeBytes)} free, under the ${gib(d.stopBytes)} floor`
    serverLog(`[disk-guard] stopping ${tree.workspaceId.slice(0, 8)}: ${detail}`)
    void cleanupWorkspaceDetached({
      jobName: handle.jobName,
      projectId: handle.projectId,
      workspaceId: handle.workspaceId,
      cause: { reason: 'disk-full', detail },
    }).catch((err: unknown) => {
      serverLog(`[disk-guard] stopping ${tree.workspaceId.slice(0, 8)} failed: ${String(err)}`)
    })
  }
}

function underStop(d: NodeDisk): boolean {
  return d.error === undefined && d.freeBytes < d.stopBytes
}
