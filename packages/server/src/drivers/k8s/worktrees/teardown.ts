import { k8sNamespace, kubectlWithRetry } from '#drivers/k8s/substrate'
import { proxyClient } from '#drivers/k8s/egress'
import { stopWorktreeForwarders } from '#drivers/k8s/forwarders'
import { removeNodeImageStore, salvageWorktreeImages } from '#drivers/k8s/images'
import {
  buildVclusterCleanupShellCommand,
  getVclusterStatus,
  removeProjectRegistry,
  removeWorktreeVcluster,
  vclusterName,
} from '#drivers/k8s/cluster'
import type { TeardownTarget } from '#drivers/contract'

/**
 * How the k8s runtime destroys what it was holding for a workspace — the
 * mechanics half of a stop (docs/layered-server.md).
 *
 * What the mediator keeps is everything that is bookkeeping ABOUT the
 * workspace: the terminating mark, the stop record, the status eviction,
 * and which directories a workspace owns on disk. What is here is the
 * sequence over cluster objects, and the sequence is the substance — every
 * ordering below exists because a later step destroys the evidence or the
 * reachability an earlier one needed.
 *
 * Two shapes, because the callers differ. `destroyWorkspace` waits and
 * reports whether the unit really went away, for a caller that is about to
 * delete the workspace's files. `detachedTeardownCommand` answers the same
 * teardown as a shell command, for a caller that must return before it
 * finishes; the two are written to compose with each other, since a
 * teardown interrupted half way is resumed by re-issuing it.
 */

/**
 * Drop the workspace's state from the egress proxy. If no proxy is running
 * there is nothing registered, so nothing to drop. Failures are swallowed:
 * a sidecar hiccup must never hold up a teardown, and a registration with
 * no workspace behind it reaches nothing anyway.
 */
async function removeWorkspaceFromProxy(workspaceId: string): Promise<void> {
  try {
    if (!await proxyClient.attachIfRunning()) return
    await proxyClient.removeWorktree(workspaceId)
  } catch (err) {
    console.warn(
      `Failed to remove session ${workspaceId} from proxy: ${(err as Error).message}`,
    )
  }
}

/**
 * Stop routing for a workspace: its host port-forwards come down as one
 * set, then its proxy registration goes.
 *
 * Split out of `destroyWorkspace` because a DETACHED teardown wants exactly
 * this half in-process — both parts are fast, both are this process's own
 * state as much as the cluster's, and a detached script could not do either.
 */
export async function deregisterWorkspace(workspaceId: string): Promise<void> {
  stopWorktreeForwarders(workspaceId)
  await removeWorkspaceFromProxy(workspaceId)
}

/**
 * Salvage the image layers a nested workspace built into its project's
 * registry, before the pod (and the graphroot tmpfs holding them) is
 * destroyed.
 *
 * Best-effort and self-gating — the in-pod survey does nothing in a pod
 * that carries no engine, so a non-nested or already-dead workspace costs
 * one probe — and never throws: losing a salvage costs a rebuild, and must
 * not strand a teardown. Unlike the mid-life reconciler this is unfiltered:
 * a teardown holds a name, not a pod, so the gate that decides is the
 * in-pod one.
 */
export async function salvageWorkspaceImages(target: TeardownTarget): Promise<void> {
  await salvageWorktreeImages({
    jobName: target.unitName,
    projectSlug: target.projectSlug,
    worktreeId: target.workspaceId,
  }).then(() => undefined, () => undefined)
}

/** Deadline for the Job delete to report its pod actually gone. */
const UNIT_DELETE_TIMEOUT = '30s'

/**
 * Tear a workspace's runtime down and wait for it to really be gone.
 *
 * The order is the point:
 *
 * 1. Deregister first, so nothing routes traffic to (or holds host ports
 *    against) a workspace that is dying.
 * 2. Salvage second, because it EXECS INTO the pod and step 3 destroys it.
 * 3. Delete the Job `--cascade=foreground --wait`. Both halves are needed
 *    and only the pair is enough: under kubectl's default background
 *    propagation the API server drops the Job and returns while the GC
 *    deletes the pod behind it, so `--wait` alone would return with the pod
 *    still running — and still writing into /workspace — for its whole
 *    grace period. The pod's terminationGracePeriodSeconds covers the
 *    graceful stop, so no separate stop step is needed.
 * 4. Remove the vcluster last, gated on one cheap status probe so a
 *    workspace that never had one pays a single read. After the delete, and
 *    best-effort: the vcluster reconcile sweeps whatever this misses.
 *
 * Resolves `false` when step 3 could not confirm the pod was gone — a
 * timeout, or a delete that failed outright. That verdict is what a caller
 * about to remove the workspace's files gates on; the leftover Job is swept
 * by the stale reaper, which resumes the (idempotent) teardown.
 *
 * `unitOnly` keeps steps 1 and 4, and what it protects is RECEIPT
 * COHERENCE for a caller that is about to launch again. A create prepares
 * its substrate once and reuses that receipt across attempts, so the
 * registration and the vcluster it names have to outlive any one attempt:
 * deregistering would leave the next attempt reaching nothing, and removing
 * the vcluster would invalidate the kubeconfig already written to disk for
 * it. Step 3 is the whole of it, and step 3 is exactly what a failed
 * attempt left behind.
 *
 * It is NOT a way to preserve a workspace's nested-cluster state. Nothing
 * here does: every stop and restart takes the full path, and what a
 * `unitOnly` give-up leaves standing is collected by the vcluster orphan
 * sweep once it ages past its grace window, since no pod or Job names it
 * any more. A resumed workspace gets a freshly prepared substrate. Do not
 * "improve" a stop path to keep state that the sweep will collect anyway.
 */
export async function destroyWorkspace(
  target: TeardownTarget,
  opts: { salvageImages?: boolean; unitOnly?: boolean } = {},
): Promise<boolean> {
  if (!opts.unitOnly) await deregisterWorkspace(target.workspaceId)

  if (opts.salvageImages !== false) await salvageWorkspaceImages(target)

  let unitGone = true
  try {
    await kubectlWithRetry([
      'delete', 'job', target.unitName, '-n', k8sNamespace(),
      '--ignore-not-found', '--cascade=foreground', '--wait=true',
      `--timeout=${UNIT_DELETE_TIMEOUT}`,
    ])
  } catch {
    unitGone = false
  }

  if (opts.unitOnly) return unitGone

  try {
    if (await getVclusterStatus(target.workspaceId)) {
      await removeWorktreeVcluster(vclusterName(target.workspaceId))
    }
  } catch (err) {
    console.warn(
      `vcluster cleanup for ${target.workspaceId} failed: ${(err as Error).message}`,
    )
  }

  return unitGone
}

/**
 * The same teardown as a shell command, for a caller that must return
 * before it finishes.
 *
 * Every line is idempotent and error-tolerant, which is what lets a
 * teardown be resumed by simply re-issuing the whole script — the reaper
 * does exactly that for a delete whose in-memory mark was lost. The
 * vcluster half is pure label-selector deletes, so a workspace that never
 * had one no-ops rather than branching.
 *
 * Deliberately NOT the whole of a teardown: the caller appends the
 * removals it owns, and must have awaited `deregisterWorkspace` and
 * `salvageWorkspaceImages` first — neither can be expressed here, and the
 * salvage in particular has to reach into a pod this command destroys.
 */
export function detachedTeardownCommand(target: TeardownTarget): string {
  return [
    `kubectl delete job ${target.unitName} -n ${k8sNamespace()}`
    + ' --ignore-not-found 2>/dev/null || true',
    buildVclusterCleanupShellCommand(vclusterName(target.workspaceId)),
  ].join('; ')
}

/**
 * Everything the runtime holds for a whole project once its workspaces are
 * gone: the per-project push registry and the node-local image stores.
 *
 * Each part is independently best-effort, because they fail for unrelated
 * reasons and neither is recoverable by the other — a registry that could
 * not be reached must not stop the node stores from going, and a stale
 * store is a cache nothing will ever mount again.
 */
export async function destroyProjectSubstrate(projectSlug: string): Promise<void> {
  try {
    await removeProjectRegistry(projectSlug)
  } catch {
    // Unreachable cluster — the server-start orphan GC collects it.
  }
  try {
    await removeNodeImageStore(projectSlug)
  } catch {
    // Node-side residue is a cache nothing will mount.
  }
}
