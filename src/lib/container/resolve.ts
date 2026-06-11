import { findSessionPod, listSessionPods } from '@/lib/k8s/pods'

export interface ResolvedContainer {
  /** Session Job name (`yaac-<slug>-<sessionId>`). */
  name: string
  sessionId: string
  projectSlug: string
  state: string
}

/**
 * Resolves a session by prefix match on session ID, Job name, or Pod
 * name. Returns the Job name, or null if not found/not running.
 */
export async function resolveContainer(idOrName: string): Promise<string | null> {
  let pods
  try {
    pods = await listSessionPods()
  } catch {
    console.error('Failed to reach the kubernetes cluster. Run "yaac cluster check".')
    process.exitCode = 1
    return null
  }

  const match = findSessionPod(pods, idOrName)

  if (!match) {
    console.error(`No session found matching "${idOrName}". Run "yaac session list" to see active sessions.`)
    process.exitCode = 1
    return null
  }

  if (!match.running) {
    console.error(`Session "${match.jobName}" is not running (phase: ${match.phase}).`)
    process.exitCode = 1
    return null
  }

  return match.jobName
}

/**
 * Resolves a session by prefix match, accepting any pod phase.
 */
export async function resolveContainerAnyState(idOrName: string): Promise<ResolvedContainer | null> {
  let pods
  try {
    pods = await listSessionPods()
  } catch {
    console.error('Failed to reach the kubernetes cluster. Run "yaac cluster check".')
    process.exitCode = 1
    return null
  }

  const match = findSessionPod(pods, idOrName)

  if (!match) {
    console.error(`No session found matching "${idOrName}". Run "yaac session list" to see active sessions.`)
    process.exitCode = 1
    return null
  }

  return {
    name: match.jobName,
    sessionId: match.sessionId,
    projectSlug: match.projectSlug,
    state: match.running ? 'running' : match.phase.toLowerCase(),
  }
}
