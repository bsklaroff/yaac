import { execSync } from 'node:child_process'
import { resolveContainerAnyState } from '@/lib/container/resolve'
import { isTmuxSessionAlive, cleanupSessionDetached } from '@/lib/session/cleanup'
import { clearPrewarmSession } from '@/lib/prewarm'

export async function sessionAttach(containerId: string): Promise<void> {
  const resolved = await resolveContainerAnyState(containerId)
  if (!resolved) return

  const { name: containerName, sessionId, projectSlug, state } = resolved

  if (state !== 'running') {
    console.error(`Container "${containerName}" is not running (state: ${state}).`)
    process.exitCode = 1
    return
  }

  // Clear prewarm state if attaching to a prewarmed session
  await clearPrewarmSession(projectSlug)

  try {
    execSync(`podman exec -it ${containerName} tmux attach-session -t yaac`, {
      stdio: 'inherit',
    })
  } catch {
    // Container or tmux session was killed (e.g. ctrl-b k) — fall through to cleanup
  }

  // Auto-cleanup if Claude Code exited (tmux session died)
  if (!isTmuxSessionAlive(containerName)) {
    console.log('Claude Code exited. Cleaning up session...')
    cleanupSessionDetached({ containerName, projectSlug, sessionId })
  }
}
