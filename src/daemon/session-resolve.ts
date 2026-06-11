import { listSessionPods, findSessionPod } from '@/lib/k8s/pods'
import { DaemonError } from '@/daemon/errors'

export interface ResolvedSession {
  jobName: string
  sessionId: string
  projectSlug: string
  state: string
}

/**
 * Resolve a session Job by session ID (full or prefix), Job name, or Pod
 * name prefix. Mirrors the CLI-side `findSessionPod` matching but throws
 * `DaemonError` codes instead of writing to stderr.
 */
export async function resolveSessionContainer(
  idOrName: string,
  opts: { requireRunning?: boolean } = {},
): Promise<ResolvedSession> {
  let pods
  try {
    pods = await listSessionPods()
  } catch (err) {
    throw new DaemonError('RUNTIME_UNAVAILABLE', err instanceof Error ? err.message : String(err))
  }

  const match = findSessionPod(pods, idOrName)
  if (!match) throw new DaemonError('NOT_FOUND', `session ${idOrName} not found`)

  const state = match.running ? 'running' : match.phase.toLowerCase()
  if (opts.requireRunning && state !== 'running') {
    throw new DaemonError('CONFLICT', `job "${match.jobName}" is not running (phase: ${match.phase})`)
  }

  return {
    jobName: match.jobName,
    sessionId: match.sessionId,
    projectSlug: match.projectSlug,
    state,
  }
}
