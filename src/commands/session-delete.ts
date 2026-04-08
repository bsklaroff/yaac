import { podman } from '@/lib/podman'
import { resolveContainerAnyState } from '@/lib/container-resolve'
import { removeWorktree } from '@/lib/git'
import { repoDir, worktreeDir } from '@/lib/paths'

export async function sessionDelete(idOrName: string): Promise<void> {
  const resolved = await resolveContainerAnyState(idOrName)
  if (!resolved) return

  const { name, sessionId, projectSlug, state } = resolved

  const container = podman.getContainer(name)

  if (state === 'running') {
    console.log(`Stopping container ${name}...`)
    await container.stop({ t: 5 })
  }

  console.log(`Removing container ${name}...`)
  await container.remove()

  // Remove the git worktree (may already be gone)
  try {
    await removeWorktree(repoDir(projectSlug), worktreeDir(projectSlug, sessionId))
  } catch {
    // worktree may not exist
  }

  console.log(`Session ${sessionId} deleted.`)
}
