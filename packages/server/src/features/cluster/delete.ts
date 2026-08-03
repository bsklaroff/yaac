import { confirmDefault, kindEnv } from './setup'
import { execFileAsync } from '#platform/k8s'
import { removeLocalRegistry, REGISTRY_CONTAINER_NAME } from '#platform/container'
import { env } from '@yaac/shared/env'

/**
 * `yaac cluster delete` — tear down the local kind cluster and the local
 * registry container `yaac cluster setup` created, leaving on-disk sessions
 * and worktrees untouched. Deleting the cluster removes the node and
 * everything living inside it (Calico, netd, every vcluster, the per-project
 * registries, all node-local storage); the standalone registry container
 * lives beside the cluster on podman, so it is removed explicitly. Nothing
 * under the yaac data dir (projects, sessions, worktrees) is touched — a
 * later `yaac cluster setup` recreates the cluster and re-pushes images.
 */

/** A delete step failed in a way the user must resolve; message is the fix. */
export class ClusterDeleteError extends Error {}

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
 * Delete the kind cluster and remove the local registry container. Refuses
 * inside a nested yaac session (the cluster is the outer install's
 * infrastructure), confirms first unless `yes`, and is idempotent: an absent
 * cluster and an absent registry container are both no-ops. Throws
 * ClusterDeleteError with a user-actionable message when a step cannot
 * proceed.
 */
export async function runClusterDelete(
  opts: ClusterDeleteOptions = {},
): Promise<void> {
  if (env.nested) {
    throw new ClusterDeleteError(
      'yaac cluster delete cannot run inside a nested yaac session — the '
      + 'cluster is external infrastructure managed by the outer yaac.',
    )
  }

  const cluster = env.kindCluster
  const exists = (await listKindClusters()).includes(cluster)

  if (!opts.yes) {
    const proceed = await confirmDefault(
      `This deletes the kind cluster "${cluster}" and the local registry `
      + `container "${REGISTRY_CONTAINER_NAME}". Any running sessions stop, but `
      + 'their on-disk state and worktrees are kept. Continue?',
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

  console.log(`Removing local registry container "${REGISTRY_CONTAINER_NAME}"...`)
  await removeLocalRegistry()

  console.log(
    '\nDone. Sessions and worktrees on disk are untouched — run '
    + '`yaac cluster setup` to recreate the cluster when you need it.',
  )
}
