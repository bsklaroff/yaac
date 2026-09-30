import {
  findWorkspacePod,
  getActiveClusterCache,
  isPrewarmed,
  listWorkspaceJobs,
  listWorkspacePods,
  type PodInfo,
} from '#drivers/k8s/substrate'
import { runtimeHandleFromPod } from './handle'
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
 * Locate a workspace by its exact workspace id; spares never match.
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
  workspaceId: string,
  opts: { preferCache?: boolean } = {},
): Promise<RuntimeHandle | undefined> {
  if (opts.preferCache) {
    const cache = getActiveClusterCache()
    if (cache?.healthy('workspace-pods')) {
      const hit = findWorkspacePod(cache.workspacePods(), workspaceId)
      if (hit) return runtimeHandleFromPod(hit)
    }
  }
  const pod = findWorkspacePod(await listPodsOrUnavailable(), workspaceId)
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
 * blank the workspace list, and a dropped watch would keep serving a stale
 * one until the relist healed it. Unhealthy therefore takes the live
 * listing, which is what `find` does with the same fact.
 */
export async function listWorkspaces(
  projectSlug?: string,
  opts: { preferCache?: boolean } = {},
): Promise<RuntimeHandle[]> {
  if (opts.preferCache) {
    const cache = getActiveClusterCache()
    if (cache?.healthy('workspace-pods')) {
      return cache.workspacePods(projectSlug).map(runtimeHandleFromPod)
    }
  }
  return (await listPodsOrUnavailable(projectSlug)).map(runtimeHandleFromPod)
}

/**
 * What a stop should address, by exact workspace id, including a workspace
 * whose Job outlived its pod — and, with `spares`, an unclaimed spare, since
 * a failed warm tears down its own unit.
 *
 * A pod deleted out-of-band leaves a Job with nothing to match on, and that
 * Job is exactly what still needs deleting — so a pod miss falls through to
 * the Job listing.
 */
export async function findWorkspaceForTeardown(
  workspaceId: string,
  opts: { spares?: boolean } = {},
): Promise<TeardownTarget | undefined> {
  const pods = await listPodsOrUnavailable()
  const pod = findWorkspacePod(pods, workspaceId, opts)
  if (pod) {
    return { projectSlug: pod.projectSlug, workspaceId: pod.workspaceId, unitName: pod.jobName }
  }

  // A spare's pod is what says it is one; with the pod skipped as a spare,
  // its Job must not answer in its place.
  if (pods.some((p) => p.workspaceId === workspaceId)) return undefined

  let jobs
  try {
    jobs = await listWorkspaceJobs()
  } catch (err) {
    throw new ServerError('RUNTIME_UNAVAILABLE', err instanceof Error ? err.message : String(err))
  }
  const job = jobs.find((j) => j.workspaceId === workspaceId)
  return job
    ? { projectSlug: job.projectSlug, workspaceId: job.workspaceId, unitName: job.jobName }
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
  try {
    for (const p of await listWorkspacePods()) {
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
    return (await listWorkspacePods(projectSlug)).length
  } catch {
    return 0
  }
}

/** One listing, with the substrate's failure surfaced the way every resolver
 *  expects it: a caller with a recorded row to fall back on catches it, and
 *  one without lets it through as RUNTIME_UNAVAILABLE. */
async function listPodsOrUnavailable(projectSlug?: string): Promise<PodInfo[]> {
  try {
    return await listWorkspacePods(projectSlug)
  } catch (err) {
    throw new ServerError('RUNTIME_UNAVAILABLE', err instanceof Error ? err.message : String(err))
  }
}
