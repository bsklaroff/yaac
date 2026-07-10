import { findSessionPod, listSessionJobs, listSessionPods } from '#lib/k8s/pods'
import { cleanupSessionDetached } from '#lib/session/cleanup'
import { ServerError } from '@yaac/shared/errors'

export interface DeletedSessionInfo {
  sessionId: string
  jobName: string
  projectSlug: string
}

/**
 * Resolve a session by prefix match on id or Job/pod name and schedule
 * a detached cleanup (delete Job + prune session dirs). Throws
 * `NOT_FOUND` if nothing matches, `RUNTIME_UNAVAILABLE` if the cluster
 * can't be reached.
 */
export async function deleteSession(idOrName: string): Promise<DeletedSessionInfo> {
  let pods
  try {
    pods = await listSessionPods()
  } catch (err) {
    throw new ServerError('RUNTIME_UNAVAILABLE', err instanceof Error ? err.message : String(err))
  }

  const match = findSessionPod(pods, idOrName)
  if (match) {
    const info: DeletedSessionInfo = {
      jobName: match.jobName,
      sessionId: match.sessionId,
      projectSlug: match.projectSlug,
    }
    await cleanupSessionDetached(info)
    return info
  }

  // A Job whose pod was deleted out-of-band has no pod to match — fall
  // back to the Job list with the same match semantics so the pod-less
  // Job can still be deleted. Job names are matched exactly, not by
  // prefix: every name starts with `yaac-`, so a short prefix would
  // resolve to an arbitrary session.
  let jobs
  try {
    jobs = await listSessionJobs()
  } catch (err) {
    throw new ServerError('RUNTIME_UNAVAILABLE', err instanceof Error ? err.message : String(err))
  }
  const jobMatch = jobs.find((j) =>
    j.sessionId === idOrName
    || j.jobName === idOrName
    || j.sessionId.startsWith(idOrName),
  )

  if (!jobMatch) {
    throw new ServerError(
      'NOT_FOUND',
      `No session found matching "${idOrName}". Run "yaac session list" to see active sessions.`,
    )
  }

  const info: DeletedSessionInfo = {
    jobName: jobMatch.jobName,
    sessionId: jobMatch.sessionId,
    projectSlug: jobMatch.projectSlug,
  }

  await cleanupSessionDetached(info)
  return info
}
