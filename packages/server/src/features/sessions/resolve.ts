import { listSessionPods, findSessionPod } from '#platform/k8s/pods'
import { ServerError } from '@yaac/shared/errors'

export interface ResolvedSession {
  jobName: string
  sessionId: string
  projectSlug: string
  state: string
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
  let pods
  try {
    pods = await listSessionPods()
  } catch (err) {
    throw new ServerError('RUNTIME_UNAVAILABLE', err instanceof Error ? err.message : String(err))
  }

  const match = findSessionPod(pods, idOrName)
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
