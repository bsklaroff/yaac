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
 * Find workspaces by id and count them per project. Which view to trust
 * and what a listing failure means are substrate decisions, so they live
 * here and answer in contract terms (docs/layered-server.md).
 */

/**
 * Locate a workspace by exact id; spares never match.
 *
 * With `preferCache`, a healthy informer cache is checked first. A miss
 * still falls through to a live listing, because a just-created pod may not
 * be in the cache yet and the PTY attach right after create would fail. A
 * hit is not re-verified, so a pod that just died may briefly read as
 * running.
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
 * Every workspace, optionally for one project.
 *
 * With `preferCache`, a healthy informer cache answers (the display path
 * uses this on every snapshot). An unhealthy cache is bypassed: unseeded,
 * it would read as an empty cluster, and with a dropped watch it would
 * serve a stale list.
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
 * What a stop should target, by exact workspace id. With `spares`, an
 * unclaimed spare also matches (a failed warm tears down its own unit). A
 * pod miss falls through to the Job listing, since a pod deleted
 * out-of-band leaves a Job that still needs deleting.
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

  // The pod exists but was skipped as a spare; don't match its Job instead.
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
 * Live workspace counts per project, excluding unclaimed spares. A count is
 * only for display, so an unreachable substrate yields empty counts rather
 * than an error.
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

/** List pods, turning a failure into RUNTIME_UNAVAILABLE. Callers with a
 *  recorded row to fall back on catch it. */
async function listPodsOrUnavailable(projectSlug?: string): Promise<PodInfo[]> {
  try {
    return await listWorkspacePods(projectSlug)
  } catch (err) {
    throw new ServerError('RUNTIME_UNAVAILABLE', err instanceof Error ? err.message : String(err))
  }
}
