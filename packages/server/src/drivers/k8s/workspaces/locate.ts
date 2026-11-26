import {
  findWorkspacePod,
  listWorkspaceJobs,
  listWorkspacePods,
  readWorkspacePods,
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
  const pod = (opts.preferCache ? findWorkspacePod(await readPods(), workspaceId) : undefined)
    ?? findWorkspacePod(await listPods(), workspaceId)
  return pod ? runtimeHandleFromPod(pod) : undefined
}

/**
 * Every workspace, optionally for one project. With `preferCache`, a
 * healthy informer cache answers (the display path uses this on every
 * snapshot).
 */
export async function listWorkspaces(
  projectId?: string,
  opts: { preferCache?: boolean } = {},
): Promise<RuntimeHandle[]> {
  const pods = opts.preferCache ? await readPods(projectId) : await listPods(projectId)
  return pods.map(runtimeHandleFromPod)
}

/**
 * What a stop should target, by exact workspace id. A pod miss falls
 * through to the Job listing, since a pod deleted out-of-band leaves a Job
 * that still needs deleting.
 */
export async function findWorkspaceForTeardown(workspaceId: string): Promise<TeardownTarget | undefined> {
  const pod = findWorkspacePod(await listPods(), workspaceId)
  if (pod) {
    return { projectId: pod.projectId, workspaceId: pod.workspaceId, unitName: pod.jobName }
  }
  const job = (await unavailableOnFailure(listWorkspaceJobs()))
    .find((j) => j.workspaceId === workspaceId)
  return job
    ? { projectId: job.projectId, workspaceId: job.workspaceId, unitName: job.jobName }
    : undefined
}

/**
 * The RuntimeClass of workspace pods from before the socket datapath
 * (docs/legacy-compat-shims.md "Workspaces on the gvisor class").
 */
const LEGACY_RUNTIME_CLASS = 'gvisor'

/**
 * Workspaces whose pod runs on the legacy RuntimeClass: it has a network
 * interface and nothing left to carry its traffic, so the server stops it,
 * and a restart brings it back in the current shape.
 */
export async function outdatedWorkspaces(): Promise<RuntimeHandle[]> {
  return (await readPods())
    .filter((p) => p.runtimeClass === LEGACY_RUNTIME_CLASS && !p.terminating)
    .map(runtimeHandleFromPod)
}

/**
 * Live workspace counts per project, excluding unclaimed spares. A count is
 * only for display, so an unreachable substrate yields empty counts rather
 * than an error.
 */
export async function countWorkspaces(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  try {
    for (const p of await readWorkspacePods()) {
      if (p.projectId) counts[p.projectId] = (counts[p.projectId] ?? 0) + 1
    }
  } catch {
    // substrate not available — leave counts empty
  }
  return counts
}

/** A listing failure as RUNTIME_UNAVAILABLE. Callers with a recorded row
 *  to fall back on catch it. */
async function unavailableOnFailure<T>(listing: Promise<T>): Promise<T> {
  try {
    return await listing
  } catch (err) {
    throw new ServerError('RUNTIME_UNAVAILABLE', err instanceof Error ? err.message : String(err))
  }
}

function listPods(projectId?: string): Promise<PodInfo[]> {
  return unavailableOnFailure(listWorkspacePods(projectId))
}

function readPods(projectId?: string): Promise<PodInfo[]> {
  return unavailableOnFailure(readWorkspacePods(projectId))
}
