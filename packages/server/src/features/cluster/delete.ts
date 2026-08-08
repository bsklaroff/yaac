import { confirmDefault, kindEnv } from './setup'
import { ClusterDeleteError, assertNotNested } from './arg-guards'
import { execFileAsync } from '#platform/k8s'
import { env } from '@yaac/shared/env'

/**
 * `yaac cluster delete` — tear down the local kind cluster `yaac cluster
 * setup` created, leaving on-disk sessions and worktrees untouched.
 *
 * One `kind delete` is now the whole teardown: every yaac workload lives
 * inside the cluster (Calico, netd, every vcluster, the main and
 * per-project registries) and so does all of their node-local storage,
 * including the registries' image blobs — the node's filesystem goes with
 * the node. Nothing under the yaac data dir (projects, sessions, worktrees)
 * is touched, so a later `yaac cluster setup` recreates the cluster and
 * re-pushes the images.
 *
 * There is deliberately no host-container step here any more. The registry
 * an older yaac ran as a podman container beside the cluster is retired by
 * the ensure that stands up its in-cluster replacement (main-registry.ts),
 * not by delete — otherwise an install that upgraded and never deleted
 * would keep the orphan forever.
 */

// Lives in arg-guards.ts (which costs nothing to import) so the CLI can
// reject the nested guard without loading this module. Re-exported here
// because this is where consumers of `runClusterDelete` expect to find it.
export { ClusterDeleteError }

export interface ClusterDeleteOptions {
  /** Skip the interactive confirmation (for scripts / non-interactive use). */
  yes?: boolean
}

/**
 * Names of the kind clusters the podman provider can see. Throws
 * ClusterDeleteError (not a bare exit code) when kind cannot be queried at
 * all — a missing kind binary or a stopped podman is the usual cause, and
 * the message says so. `kind get clusters` prints "No kind clusters found."
 * (with spaces) when there are none; real cluster names never contain
 * whitespace, so whitespace-bearing lines are dropped to leave just names.
 */
async function listKindClusters(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('kind', ['get', 'clusters'], { env: kindEnv() })
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !/\s/.test(l))
  } catch (err) {
    const detail = ((err as { stderr?: string })?.stderr ?? '').trim()
      || (err instanceof Error ? err.message : String(err))
    throw new ClusterDeleteError(
      'Could not list kind clusters (is kind installed and podman running?):\n'
      + `  ${detail.split('\n')[0]}`,
    )
  }
}

/**
 * Delete the kind cluster. Refuses inside a nested yaac session (the
 * cluster is the outer install's infrastructure), confirms first unless
 * `yes`, and is idempotent: an absent cluster is a no-op. Throws
 * ClusterDeleteError with a user-actionable message when a step cannot
 * proceed.
 */
export async function runClusterDelete(
  opts: ClusterDeleteOptions = {},
): Promise<void> {
  assertNotNested('delete')

  const cluster = env.kindCluster
  const exists = (await listKindClusters()).includes(cluster)

  if (!opts.yes) {
    const proceed = await confirmDefault(
      `This deletes the kind cluster "${cluster}", including the in-cluster `
      + 'image registry and every image pushed to it. Any running sessions '
      + 'stop, but their on-disk state and worktrees are kept. Continue?',
    )
    if (!proceed) {
      console.log('Aborted — nothing was deleted.')
      return
    }
  }

  if (exists) {
    console.log(`Deleting kind cluster "${cluster}"...`)
    await execFileAsync('kind', ['delete', 'cluster', '--name', cluster], { env: kindEnv() })
  } else {
    console.log(`No kind cluster "${cluster}" to delete.`)
  }

  console.log(
    '\nDone. Sessions and worktrees on disk are untouched — run '
    + '`yaac cluster setup` to recreate the cluster when you need it.',
  )
}
