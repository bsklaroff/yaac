import { execSync } from 'node:child_process'
import { resolveContainer } from '@/lib/container-resolve'

export async function sessionAttach(containerId: string): Promise<void> {
  const containerName = await resolveContainer(containerId)
  if (!containerName) return

  execSync(`podman exec -it ${containerName} tmux attach-session -t claude`, {
    stdio: 'inherit',
  })
}
