import { findSessionPod, getActiveClusterCache, listSessionPods, type SessionPod } from '#platform/k8s'
import { findWorktreeRow } from '#features/sessions/worktree-store'
import { ServerError } from '@yaac/shared/errors'

export interface ResolvedSession {
  jobName: string
  sessionId: string
  projectSlug: string
  state: string
}

/**
 * Locate a session pod, preferring the informer's push-fed cache over a
 * one-shot `kubectl get pods`.
 *
 * Every session endpoint resolves through here and several of them are polled,
 * so the subprocess this replaces was the most expensive step on those paths —
 * paid before the request's real work even started.
 *
 * A cache MISS still falls through to a live list rather than concluding the
 * session is gone. The informer learns of a new pod from a watch event, so
 * there is a brief window after create where a real session is not in the cache
 * yet, and the PTY attach that runs right after create would otherwise fail
 * with "session not found". A miss only happens for an unknown id or a session
 * that has really ended, so the fallback never runs in steady state.
 *
 * A cache HIT is deliberately not re-verified, which is the accepted tradeoff:
 * for one watch-latency window a pod that just died still reads as running (the
 * exec then fails downstream instead of returning CONFLICT), and one that just
 * turned Ready can still read Pending. The fallback above covers absence, not
 * staleness. Watch deltas are pushed, so the window is sub-second — the same
 * exposure the session-list display path already accepts.
 */
async function findPod(idOrName: string): Promise<SessionPod | undefined> {
  const cache = getActiveClusterCache()
  if (cache?.healthy('session-pods')) {
    const hit = findSessionPod(cache.sessionPods(), idOrName)
    if (hit) return hit
  }
  let pods: SessionPod[]
  try {
    pods = await listSessionPods()
  } catch (err) {
    throw new ServerError('RUNTIME_UNAVAILABLE', err instanceof Error ? err.message : String(err))
  }
  return findSessionPod(pods, idOrName)
}

/**
 * Resolve a session Job by session ID (full or prefix), Job name, or Pod
 * name prefix. Mirrors the CLI-side `findSessionPod` matching but throws
 * `ServerError` codes instead of writing to stderr.
 */
export async function resolveSessionContainer(
  idOrName: string,
  opts: { requireRunning?: boolean } = {},
): Promise<ResolvedSession> {
  const match = await findPod(idOrName)
  if (!match) throw new ServerError('NOT_FOUND', `session ${idOrName} not found`)

  const state = match.running ? 'running' : match.phase.toLowerCase()
  if (opts.requireRunning && state !== 'running') {
    throw new ServerError('CONFLICT', `job "${match.jobName}" is not running (phase: ${match.phase})`)
  }

  return {
    jobName: match.jobName,
    sessionId: match.sessionId,
    projectSlug: match.projectSlug,
    state,
  }
}

/**
 * Resolve a worktree whatever state it is in — running pod first, then the
 * recorded row.
 *
 * The pod-only resolver above answers "which container", so it rightly fails
 * when there is none. Anything that reads *recorded* state must not: a
 * stopped worktree keeps its row, its checkout and its conversation links,
 * and listing those is exactly what you do before restarting it. Restart
 * falls back the same way, for the same reason.
 */
export async function resolveWorktreeRecord(
  idOrName: string,
): Promise<{ projectSlug: string; worktreeId: string }> {
  try {
    const match = findSessionPod(await listSessionPods(), idOrName)
    if (match) return { projectSlug: match.projectSlug, worktreeId: match.sessionId }
  } catch {
    // Cluster unreachable — the row still answers.
  }
  const row = await findWorktreeRow(idOrName)
  if (row) return { projectSlug: row.projectSlug, worktreeId: row.worktreeId }
  throw new ServerError('NOT_FOUND', `worktree ${idOrName} not found`)
}
