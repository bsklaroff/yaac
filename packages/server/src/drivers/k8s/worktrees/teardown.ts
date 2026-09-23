import { k8sNamespace, kubectlWithRetry,
  PRE_STOP_GRACE_SECONDS,
} from '#drivers/k8s/substrate'
import { deregisterWorkspaceEgress } from '#drivers/k8s/egress'
import { stopWorktreeForwarders } from '#drivers/k8s/forwarders'
import { removeNodeLocalProject, salvageWorktreeImages } from '#drivers/k8s/images'
import { removeProjectRegistry, removeProjectSecrets } from '#drivers/k8s/cluster'
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
 * Stop routing for a workspace: its host port-forwards come down as one
 * set, then its egress registration goes (its failures are swallowed
 * there — a datapath hiccup must never hold up a teardown).
 *
 * Split out of `destroyWorkspace` because a DETACHED teardown wants exactly
 * this half in-process — both parts are fast, and the forwarders are this
 * process's own state, which a detached script could not touch.
 */
export async function deregisterWorkspace(workspaceId: string): Promise<void> {
  stopWorktreeForwarders(workspaceId)
  await deregisterWorkspaceEgress(workspaceId)
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

/** The detached delete's wait: past a hooked pod's grace period, with room. */
const DETACHED_DELETE_TIMEOUT = `${String(PRE_STOP_GRACE_SECONDS + 30)}s`

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
 *
 * Resolves `false` when step 3 could not confirm the pod was gone — a
 * timeout, or a delete that failed outright. That verdict is what a caller
 * about to remove the workspace's files gates on; the leftover Job is swept
 * by the stale reaper, which resumes the (idempotent) teardown.
 *
 * `unitOnly` skips step 1, and what it protects is RECEIPT COHERENCE for a
 * caller that is about to launch again. A create prepares its substrate
 * once and reuses that receipt across attempts, so the registration has to
 * outlive any one attempt: deregistering would leave the next attempt
 * reaching nothing. Step 3 is the whole of it, and step 3 is exactly what a
 * failed attempt left behind.
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

  return unitGone
}

/**
 * The same teardown as a shell command, for a caller that must return
 * before it finishes.
 *
 * Every line is idempotent and error-tolerant, which is what lets a
 * teardown be resumed by simply re-issuing the whole script — the reaper
 * does exactly that for a delete whose in-memory mark was lost.
 *
 * Deliberately NOT the whole of a teardown: the caller appends the
 * removals it owns, and must have awaited `deregisterWorkspace` and
 * `salvageWorkspaceImages` first — neither can be expressed here, and the
 * salvage in particular has to reach into a pod this command destroys.
 */
export function detachedTeardownCommand(target: TeardownTarget): string {
  // Foreground cascade, waited: the caller removes the session dir next,
  // and that dir is the source of the pod's File mounts — the preStop
  // hook's own script among them — so the delete has to outlast the pod,
  // not just the Job object, which means outlasting the hook's whole grace
  // period. The timeout keeps a stuck pod from holding the removals
  // hostage; they run either way.
  return `kubectl delete job ${target.unitName} -n ${k8sNamespace()}`
    + ` --ignore-not-found --cascade=foreground --wait=true --timeout=${DETACHED_DELETE_TIMEOUT}`
    + ' 2>/dev/null || true'
}

/**
 * Everything the runtime holds for a whole project once its workspaces are
 * gone: the per-project push registry, the node-local image stores, and
 * the secret values the egress proxy was handed.
 *
 * Each part is independently best-effort, because they fail for unrelated
 * reasons and none is recoverable by another — a registry that could not
 * be reached must not stop the node stores from going, and a stale store
 * is a cache nothing will ever mount again.
 */
export async function destroyProjectSubstrate(projectSlug: string): Promise<void> {
  try {
    await removeProjectRegistry(projectSlug)
  } catch {
    // Unreachable cluster — the server-start orphan GC collects it.
  }
  try {
    await removeProjectSecrets(projectSlug)
  } catch (err) {
    // The object lingers, naming a project nothing registers under.
    console.warn(`Failed to remove the egress secrets of ${projectSlug}: ${(err as Error).message}`)
  }
  try {
    await removeNodeLocalProject(projectSlug)
  } catch {
    // Node-side residue is a cache nothing will mount.
  }
}
