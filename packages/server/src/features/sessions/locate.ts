import {
  findSessionPod,
  getActiveClusterCache,
  isDeferredClusterBootPending,
  isPrewarmed,
  listSessionPods,
  triggerDeferredClusterBoot,
  type SessionPod,
} from '#platform/k8s'
import { normalizeTool } from '#features/agents'
import { ServerError } from '@yaac/shared/errors'
import type { WorkspaceHandle } from '@yaac/shared/herd'

/**
 * Answering "which workspace does this id name", and "how many is each
 * project running" — the substrate half of every resolve above the boundary.
 *
 * Herd-side rather than in the boundary's own implementation on purpose: all
 * of it is substrate behavior (which view to trust, when a miss is a miss,
 * what a listing failure means), and the boundary's implementation is the
 * file that gets replaced by an RPC client. Anything left there vanishes at
 * that swap; anything here moves into the herd package with its feature
 * (docs/plans/herd-split.md).
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
): Promise<WorkspaceHandle | undefined> {
  if (opts.preferCache) {
    const cache = getActiveClusterCache()
    if (cache?.healthy('session-pods')) {
      const hit = findSessionPod(cache.sessionPods(), idOrName)
      if (hit) return toWorkspaceHandle(hit)
    }
  }
  const pod = findSessionPod(await listWorkspacePods(), idOrName)
  return pod ? toWorkspaceHandle(pod) : undefined
}

/** Every workspace the substrate is running, optionally one project's. */
export async function listWorkspaces(projectSlug?: string): Promise<WorkspaceHandle[]> {
  return (await listWorkspacePods(projectSlug)).map(toWorkspaceHandle)
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
    // session pods by construction, so every count is 0 — answer instantly
    // instead of holding the first snapshot (and with it the web app's
    // project list) on a call to a still-waking vcluster. Kick the attach so
    // the caches come up and push a fresh snapshot with real counts.
    triggerDeferredClusterBoot()
    return counts
  }
  try {
    for (const p of await listSessionPods()) {
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
    return (await listSessionPods(projectSlug)).length
  } catch {
    return 0
  }
}

/** One listing, with the substrate's failure surfaced the way every resolver
 *  expects it: a caller with a recorded row to fall back on catches it, and
 *  one without lets it through as RUNTIME_UNAVAILABLE. */
async function listWorkspacePods(projectSlug?: string): Promise<SessionPod[]> {
  try {
    return await listSessionPods(projectSlug)
  } catch (err) {
    throw new ServerError('RUNTIME_UNAVAILABLE', err instanceof Error ? err.message : String(err))
  }
}

/** A pod as the boundary describes a workspace. The tool label is normalized
 *  here so nothing above has to know a pod carries a raw string. */
function toWorkspaceHandle(pod: SessionPod): WorkspaceHandle {
  return {
    workspaceId: pod.sessionId,
    projectSlug: pod.projectSlug,
    jobName: pod.jobName,
    tool: normalizeTool(pod.tool),
    running: pod.running,
    state: pod.running ? 'running' : pod.phase.toLowerCase(),
    labels: pod.labels,
    createdAtMs: pod.createdAtMs,
    prewarmed: isPrewarmed(pod),
  }
}
