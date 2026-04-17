import { spawn } from 'node:child_process'
import { execPodmanWithRetry, podman } from '@/lib/container/runtime'
import { removeWorktree } from '@/lib/git'
import { repoDir, worktreeDir } from '@/lib/project/paths'

/**
 * Check whether tmux session "yaac" is alive inside the given container.
 *
 * Uses `execPodmanWithRetry` so transient podman/OCI errors (container
 * state improper, conmon churn, etc.) do not masquerade as "session is
 * dead" — which would otherwise trigger destructive cleanup of a live
 * session.  After retries are exhausted, a genuine failure returns false.
 */
export function isTmuxSessionAlive(containerName: string): boolean {
  try {
    execPodmanWithRetry(`podman exec ${containerName} tmux has-session -t yaac`)
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
 * Spawn a detached background process to clean up a session so the calling
 * process can exit immediately without waiting for container stop/remove.
 */
export function cleanupSessionDetached(params: {
  containerName: string
  projectSlug: string
  sessionId: string
}): void {
  const { containerName, projectSlug, sessionId } = params
  const wtDir = worktreeDir(projectSlug, sessionId)
  const rDir = repoDir(projectSlug)

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
