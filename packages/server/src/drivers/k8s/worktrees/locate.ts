import {
  findWorktreePod,
  getActiveClusterCache,
  isDeferredClusterBootPending,
  isPrewarmed,
  listWorktreeJobs,
  listWorktreePods,
  triggerDeferredClusterBoot,
  type PodInfo,
} from '#drivers/k8s/substrate'
import { runtimeHandleFromPod } from '#drivers/k8s/view'
import { ServerError } from '@yaac/shared/errors'
import type { RuntimeHandle, TeardownTarget } from '#drivers/contract'

/**
 * Answering "which workspace does this id name", and "how many is each
 * project running" — the substrate half of every resolve above the boundary.
 *
 * Runtime-side on purpose: all of it is substrate behavior — which view to
 * trust, when a miss is a miss, what a listing failure means — described in
 * the vocabulary of `#drivers/contract` so nothing above has to know a pod
 * carries a raw label string (docs/layered-server.md).
 */

/**
 * Locate a workspace by id, id prefix, or runtime name.
 *
 * `preferCache` answers from the informer's push-fed view when it is healthy.
 * A MISS still falls through to a live listing rather than concluding the
 * workspace is gone: the informer learns of a new pod from a watch event, so
 * there is a brief window after a create where a real workspace is not in the
 * cache yet, and the PTY attach that runs right after create would otherwise
 * fail with "not found". A HIT is deliberately not re-verified — for one
 * watch-latency window a pod that just died still reads as running, which is
 * the same exposure the display path already accepts. An unseeded or
 * disconnected cache cannot be trusted for presence either, so it is bypassed
 * rather than consulted.
 */
export async function findWorkspace(
  idOrName: string,
  opts: { preferCache?: boolean } = {},
): Promise<RuntimeHandle | undefined> {
  if (opts.preferCache) {
    const cache = getActiveClusterCache()
    if (cache?.healthy('worktree-pods')) {
      const hit = findWorktreePod(cache.worktreePods(), idOrName)
      if (hit) return runtimeHandleFromPod(hit)
    }
  }
  const pod = findWorktreePod(await listWorkspacePods(), idOrName)
  return pod ? runtimeHandleFromPod(pod) : undefined
}

/**
 * Every workspace the substrate is holding, optionally one project's.
 *
 * `preferCache` answers from the informer's push-fed view, which the display
 * path takes on every snapshot rather than making the apiserver list what a
 * watch is already streaming. Gated on `healthy()` for the same reason
 * `find` gates on it, and it bites harder here: this answers with the WHOLE
 * set, so there is no "miss" to fall through on, and an unseeded cache does
 * not read as "I don't know" — it reads as an empty cluster. Ungated, the
 * window between registering a cache and its first list completing would
 * blank the worktree list, and a dropped watch would keep serving a stale
 * one until the relist healed it. Unhealthy therefore takes the live
 * listing, which is what `find` does with the same fact.
 *
 * The deferred-boot answer is the other half of that path and belongs with
 * it: inside a nested yaac, a server whose cluster attach has not finished
 * has no workspaces BY CONSTRUCTION (a create awaits the attach), so it
 * answers empty instantly instead of holding the first snapshot — and the
 * whole webapp behind it — on a kubectl call to a still-waking vcluster. It
 * still kicks the attach: connecting the webapp is a real use, and the
 * caches push a fresh snapshot once it lands.
 */
export async function listWorkspaces(
  projectSlug?: string,
  opts: { preferCache?: boolean } = {},
): Promise<RuntimeHandle[]> {
  if (opts.preferCache) {
    const cache = getActiveClusterCache()
    if (cache?.healthy('worktree-pods')) {
      return cache.worktreePods(projectSlug).map(runtimeHandleFromPod)
    }
    if (!cache && isDeferredClusterBootPending()) {
      triggerDeferredClusterBoot()
      return []
    }
  }
  return (await listWorkspacePods(projectSlug)).map(runtimeHandleFromPod)
}

/**
 * What a stop should address, including a workspace whose Job outlived its
 * pod.
 *
 * A pod deleted out-of-band leaves a Job with nothing to match on, and that
 * Job is exactly what still needs deleting — so a pod miss falls through to
 * the Job listing with the same match semantics. Job names match exactly,
 * never by prefix: every name starts with `yaac-`, so a short prefix would
 * resolve to an arbitrary workspace.
 */
export async function findWorkspaceForTeardown(
  idOrName: string,
): Promise<TeardownTarget | undefined> {
  const pod = findWorktreePod(await listWorkspacePods(), idOrName)
  if (pod) {
    return { projectSlug: pod.projectSlug, workspaceId: pod.worktreeId, unitName: pod.jobName }
  }

  let jobs
  try {
    jobs = await listWorktreeJobs()
  } catch (err) {
    throw new ServerError('RUNTIME_UNAVAILABLE', err instanceof Error ? err.message : String(err))
  }
  const job = jobs.find((j) =>
    j.worktreeId === idOrName
    || j.jobName === idOrName
    || j.worktreeId.startsWith(idOrName),
  )
  return job
    ? { projectSlug: job.projectSlug, workspaceId: job.worktreeId, unitName: job.jobName }
    : undefined
}

/**
 * Live workspace counts per project, spares excluded — a spare is not a
 * user's workspace until it is claimed.
 *
 * Unlike a listing, a count is a display detail: an unreachable substrate
 * reports nothing rather than failing the project listing that wanted it.
 */
export async function countWorkspaces(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  if (isDeferredClusterBootPending()) {
    // A nested server whose deferred cluster attach hasn't finished has no
    // worktree pods by construction, so every count is 0 — answer instantly
    // instead of holding the first snapshot (and with it the web app's
    // project list) on a call to a still-waking vcluster. Kick the attach so
    // the caches come up and push a fresh snapshot with real counts.
    triggerDeferredClusterBoot()
    return counts
  }
  try {
    for (const p of await listWorktreePods()) {
      if (isPrewarmed(p)) continue
      if (p.projectSlug) counts[p.projectSlug] = (counts[p.projectSlug] ?? 0) + 1
    }
  } catch {
    // substrate not available — leave counts empty
  }
  return counts
}

/** How many one project is running, spares INCLUDED — what a project's own
 *  detail page reports. Zero when the substrate cannot be asked. */
export async function countProjectWorkspaces(projectSlug: string): Promise<number> {
  try {
    return (await listWorktreePods(projectSlug)).length
  } catch {
    return 0
  }
}

/** One listing, with the substrate's failure surfaced the way every resolver
 *  expects it: a caller with a recorded row to fall back on catches it, and
 *  one without lets it through as RUNTIME_UNAVAILABLE. */
async function listWorkspacePods(projectSlug?: string): Promise<PodInfo[]> {
  try {
    return await listWorktreePods(projectSlug)
  } catch (err) {
    throw new ServerError('RUNTIME_UNAVAILABLE', err instanceof Error ? err.message : String(err))
  }
}
