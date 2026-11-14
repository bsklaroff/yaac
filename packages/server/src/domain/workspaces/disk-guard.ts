import type { NodeDisk } from '@yaac/shared/types'
import type { RuntimeSnapshot } from '#drivers/contract'
import { workspaceDriver } from '#drivers/driver'
import { serverLog } from '#lib/log'
import { cleanupWorkspaceDetached } from './cleanup'

/**
 * The full-node guard's stop (docs/node-local-workspaces.md "A full
 * node"). On a node under its stop floor it stops the workspace holding the
 * largest tree there, one per node per pass, until the node is back above
 * the floor. That is an ordinary stop with a death reason naming the disk
 * the tree held. A node whose largest tree is small is left alone: something
 * else filled its disk (images, a package store), and the health report says
 * so instead.
 */

const GiB = 1024 ** 3
/** A tree smaller than this is never the reason a node is full. */
export const LARGE_TREE_BYTES = 1 * GiB
/** A workspace this step stopped is not picked again for this long, while
 *  its stop takes effect. */
const STOPPING_MS = 5 * 60_000

const stopping = new Map<string, number>()
/** Nodes whose fullness has been logged as not a workspace's doing. */
const reported = new Set<string>()

const gib = (b: number): string => `${(b / GiB).toFixed(1)} GiB`

export async function reconcileDiskGuard(snapshot: RuntimeSnapshot): Promise<void> {
  const driver = workspaceDriver()
  const quick = await driver.nodeDisks({ trees: false })
  if (!quick.some(underStop)) {
    reported.clear()
    return
  }
  const disks = await driver.nodeDisks({ trees: true })
  const running = new Map((await snapshot.workspaces())
    .filter((h) => !h.terminating && h.state === 'running')
    .map((h) => [h.workspaceId, h]))
  const now = Date.now()
  for (const [id, at] of stopping) if (now - at > STOPPING_MS) stopping.delete(id)
  for (const d of disks.filter(underStop)) {
    const tree = (d.trees ?? []).find((t) => t.bytes >= LARGE_TREE_BYTES && running.has(t.workspaceId))
    if (tree && stopping.has(tree.workspaceId)) continue
    if (!tree) {
      if (!reported.has(d.node)) {
        reported.add(d.node)
        serverLog(`[disk-guard] node ${d.node} has ${gib(d.freeBytes)} free, under its ${gib(d.stopBytes)} floor, `
          + `but holds no workspace tree of ${gib(LARGE_TREE_BYTES)} or more; nothing is stopped`)
      }
      continue
    }
    const handle = running.get(tree.workspaceId)
    if (!handle) continue
    stopping.set(tree.workspaceId, now)
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
