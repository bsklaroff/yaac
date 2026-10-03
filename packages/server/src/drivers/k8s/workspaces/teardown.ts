import {
  PRE_STOP_GRACE_SECONDS,
  findWorkspacePod,
  execFileAsync,
  k8sNamespace,
  readWorkspacePods,
} from '#drivers/k8s/substrate'
import { deregisterWorkspaceEgress } from '#drivers/k8s/egress'
import { stopWorkspaceForwarders } from '#drivers/k8s/forwarders'
import { salvageJobImages } from '#drivers/k8s/images'
import { removeProjectRegistry, removeProjectSecrets } from '#drivers/k8s/cluster'
import type { ProjectRef, TeardownTarget } from '#drivers/contract'

/**
 * How the k8s driver destroys a workspace's cluster objects
 * (docs/layered-server.md). Bookkeeping (terminating mark, stop record,
 * status eviction, on-disk dirs) stays with the domain mediator. The step
 * order matters: each later step removes something an earlier one needs.
 *
 * `destroyWorkspace` waits and reports whether the unit is gone, for a
 * caller about to delete the workspace's files. `detachedTeardownCommand`
 * is the same teardown as a shell command for callers that must return
 * first. Both are idempotent, so an interrupted teardown is resumed by
 * re-issuing it.
 */

/**
 * Stop routing to a workspace: close its port-forwards, then remove its
 * egress registration (whose failures are swallowed so they never block a
 * teardown). Separate from `destroyWorkspace` because a detached teardown
 * runs this part in-process; the forwarders are this process's state.
 */
export async function deregisterWorkspace(workspaceId: string): Promise<void> {
  stopWorkspaceForwarders(workspaceId)
  await deregisterWorkspaceEgress(workspaceId)
}

/**
 * Push a nested workspace's image layers to its project's registry before
 * the pod and its graphroot tmpfs are destroyed.
 *
 * Best-effort and never throws: a lost salvage only costs a rebuild. The
 * in-pod survey decides whether there is anything to do (a pod with no
 * engine costs one probe), so unlike the periodic salvage this does not
 * check the nested label. The registry is named by the pod's project id.
 */
export async function salvageWorkspaceImages(target: TeardownTarget): Promise<void> {
  const pods = await readWorkspacePods().catch(() => [])
  const pod = findWorkspacePod(pods, target.workspaceId, { spares: true })
  if (!pod) return
  await salvageJobImages({
    jobName: target.unitName,
    project: { slug: target.projectSlug, id: pod.projectId },
    workspaceId: target.workspaceId,
  }).then(() => undefined, () => undefined)
}

/** Deadline for the Job delete to report its pod actually gone. */
const UNIT_DELETE_TIMEOUT = '30s'

/** The detached delete's wait: past a hooked pod's grace period, with room. */
const DETACHED_DELETE_TIMEOUT = `${String(PRE_STOP_GRACE_SECONDS + 30)}s`

/**
 * Tear down a workspace's runtime and wait until it is gone. In order:
 *
 * 1. Deregister, so nothing routes to or holds ports for the dying pod.
 * 2. Salvage images, which execs into the pod that step 3 deletes.
 * 3. Delete the Job with `kubectl delete --cascade=foreground --wait`. Both
 *    flags are needed: with the default background cascade, `--wait`
 *    returns once the Job is gone while the pod keeps running (and writing
 *    to /workspace) through its grace period. It stays kubectl so it is the
 *    same command `detachedTeardownCommand` hands to a shell.
 *
 * Resolves `false` if step 3 could not confirm the pod is gone. Callers
 * about to remove the workspace's files check this; the stale reaper later
 * resumes the teardown for the leftover Job.
 *
 * `unitOnly` skips step 1 for a create retrying after a failed attempt: the
 * create reuses one substrate receipt across attempts, so its registration
 * must survive.
 */
export async function destroyWorkspace(
  target: TeardownTarget,
  opts: { salvageImages?: boolean; unitOnly?: boolean } = {},
): Promise<boolean> {
  if (!opts.unitOnly) await deregisterWorkspace(target.workspaceId)

  if (opts.salvageImages !== false) await salvageWorkspaceImages(target)

  let unitGone = true
  try {
    await execFileAsync('kubectl', [
      'delete', 'job', target.unitName, '-n', k8sNamespace(),
      '--ignore-not-found', '--cascade=foreground', '--wait=true',
      `--timeout=${UNIT_DELETE_TIMEOUT}`,
    ])
  } catch {
    unitGone = false
  }

  return unitGone
}

/**
 * The Job delete as a shell command, for callers that must return before
 * it finishes. Idempotent and error-tolerant, so the reaper can resume a
 * lost teardown by re-issuing it. The caller appends its own removals and
 * must first await `deregisterWorkspace` and `salvageWorkspaceImages`.
 */
export function detachedTeardownCommand(target: TeardownTarget): string {
  // Wait for the pod itself, through its preStop grace period: the caller
  // next removes the session dir that backs the pod's file mounts,
  // including the preStop script. The timeout keeps a stuck pod from
  // blocking those removals.
  return `kubectl delete job ${target.unitName} -n ${k8sNamespace()}`
    + ` --ignore-not-found --cascade=foreground --wait=true --timeout=${DETACHED_DELETE_TIMEOUT}`
    + ' 2>/dev/null || true'
}

/**
 * Remove what the runtime holds for a project once its workspaces are gone:
 * the push registry and the egress proxy's secret values. Each step is
 * best-effort on its own, since they fail for unrelated reasons. The
 * node-local sweep reaps the project's node-local data and image stores.
 */
export async function destroyProjectSubstrate(project: ProjectRef): Promise<void> {
  try {
    await removeProjectRegistry(project.id)
  } catch {
    // Unreachable cluster — the orphan registry GC collects it by id.
  }
  try {
    await removeProjectSecrets(project.slug)
  } catch (err) {
    // The object lingers, naming a project nothing registers under.
    console.warn(`Failed to remove the egress secrets of ${project.slug}: ${(err as Error).message}`)
  }
}
