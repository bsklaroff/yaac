import { execSync } from 'node:child_process'
import { podman } from '@/lib/podman'
import { removeWorktree } from '@/lib/git'
import { repoDir, worktreeDir } from '@/lib/paths'

export function isTmuxSessionAlive(containerName: string): boolean {
  try {
    execSync(`podman exec ${containerName} tmux has-session -t yaac`, {
      stdio: 'pipe',
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
