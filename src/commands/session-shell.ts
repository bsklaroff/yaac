import { execSync } from 'node:child_process'
import { resolveContainerAnyState } from '@/lib/container/resolve'

export async function sessionShell(containerId: string): Promise<void> {
  const resolved = await resolveContainerAnyState(containerId)
  if (!resolved) return

  const { name: containerName, state } = resolved

  if (state !== 'running') {
    console.error(`Container "${containerName}" is not running (state: ${state}).`)
    process.exitCode = 1
    return
  }

  try {
    execSync(`podman exec -it ${containerName} zsh`, { stdio: 'inherit' })
  } catch {
    // Shell exited non-zero (e.g. user exited with non-zero status) — nothing to do.
  }
}
