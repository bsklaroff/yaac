import { spawn } from 'node:child_process'
import { execPodmanWithRetry, podman } from '@/lib/container/runtime'
import { proxyClient } from '@/lib/container/proxy-client'
import { removeWorktree } from '@/lib/git'
import { repoDir, worktreeDir } from '@/lib/project/paths'

/**
 * Best-effort removal of the session's state from the proxy sidecar. If
 * the sidecar isn't running there's nothing to clean up. Errors are
 * swallowed so cleanup never blocks container teardown on a sidecar hiccup.
 */
async function removeSessionFromProxy(sessionId: string): Promise<void> {
  try {
    const attached = await proxyClient.attachIfRunning()
    if (!attached) return
    await proxyClient.removeSession(sessionId)
  } catch (err) {
    console.warn(
      `Failed to remove session ${sessionId} from proxy: ${(err as Error).message}`,
    )
  }
}

/**
 * Check whether tmux session "yaac" is alive inside the given container.
 *
 * Uses `execPodmanWithRetry` with a tight budget so transient podman/OCI
 * errors (container state improper, conmon churn, etc.) do not masquerade
 * as "session is dead" — which would otherwise trigger destructive cleanup
 * of a live session.  The default retry budget (8 attempts, ~12.6s) is
 * much too long here: this function is called from hot paths in
 * `getWaitingSessions` (once per container) and in
 * `finalizeAttachedSession` (right after the user exits a session, when
 * the container is often truly gone).  A tight budget keeps stale-session
 * detection effectively asynchronous without losing protection against
 * short state-transition races.
 */
export function isTmuxSessionAlive(containerName: string): boolean {
  try {
    execPodmanWithRetry(`podman exec ${containerName} tmux has-session -t yaac`, {
      maxAttempts: 3,
      baseDelay: 100,
    })
    return true
  } catch {
    return false
  }
}

export async function cleanupSession(params: {
  containerName: string
  projectSlug: string
  sessionId: string
}): Promise<void> {
  const { containerName, projectSlug, sessionId } = params
  const container = podman.getContainer(containerName)

  await removeSessionFromProxy(sessionId)

  try {
    await container.stop({ t: 5 })
  } catch {
    // container may already be stopped
  }

  try {
    await container.remove()
  } catch {
    // container may already be removed
  }

  try {
    await removeWorktree(repoDir(projectSlug), worktreeDir(projectSlug, sessionId))
  } catch {
    // worktree may not exist
  }

  console.log(`Session ${sessionId} cleaned up.`)
}

/**
 * Remove the session's state from the proxy sidecar (in-process, fast),
 * then spawn a detached background process to do the slow container +
 * worktree teardown so the calling process can exit immediately.
 */
export async function cleanupSessionDetached(params: {
  containerName: string
  projectSlug: string
  sessionId: string
}): Promise<void> {
  const { containerName, projectSlug, sessionId } = params
  const wtDir = worktreeDir(projectSlug, sessionId)
  const rDir = repoDir(projectSlug)

  await removeSessionFromProxy(sessionId)

  // Build a shell script that stops + removes the container, then removes the worktree.
  // Each step ignores errors (the resource may already be gone).
  const script = [
    `podman stop -t 5 ${containerName} 2>/dev/null || true`,
    `podman rm ${containerName} 2>/dev/null || true`,
    `git -C '${rDir}' worktree remove '${wtDir}' 2>/dev/null || true`,
  ].join('; ')

  const child = spawn('sh', ['-c', script], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}
