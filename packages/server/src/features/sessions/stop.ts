import { findSessionPod, listSessionJobs, listSessionPods } from '#platform/k8s'
import { cleanupSessionDetached } from '#features/sessions/cleanup'
import { ServerError } from '@yaac/shared/errors'

export interface StoppedWorktreeInfo {
  worktreeId: string
  jobName: string
  projectSlug: string
}

/**
 * Resolve a worktree by prefix match on id or Job/pod name and schedule a
 * detached cleanup (delete the Job + prune the session dirs). The *git
 * worktree* is deliberately kept — that is what makes this a stop rather
 * than a delete, and what a later restart re-attaches to. Throws
 * `NOT_FOUND` if nothing matches, `RUNTIME_UNAVAILABLE` if the cluster
 * can't be reached.
 */
export async function stopWorktree(idOrName: string): Promise<StoppedWorktreeInfo> {
  let pods
  try {
    pods = await listSessionPods()
  } catch (err) {
    throw new ServerError('RUNTIME_UNAVAILABLE', err instanceof Error ? err.message : String(err))
  }

  const match = findSessionPod(pods, idOrName)
  if (match) {
    const info: StoppedWorktreeInfo = {
      jobName: match.jobName,
      worktreeId: match.sessionId,
      projectSlug: match.projectSlug,
    }
    await cleanupSessionDetached({
      jobName: info.jobName,
      projectSlug: info.projectSlug,
      sessionId: info.worktreeId,
    })
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
      `No worktree found matching "${idOrName}". Run "yaac worktree list" to see running worktrees.`,
    )
  }

  const info: StoppedWorktreeInfo = {
    jobName: jobMatch.jobName,
    worktreeId: jobMatch.sessionId,
    projectSlug: jobMatch.projectSlug,
  }

  await cleanupSessionDetached({
      jobName: info.jobName,
      projectSlug: info.projectSlug,
      sessionId: info.worktreeId,
    })
  return info
}
