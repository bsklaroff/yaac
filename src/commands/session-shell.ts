import { spawn } from 'node:child_process'
import { getRpcClient, toClientError } from '@/lib/daemon-client'

export async function sessionShell(containerId: string): Promise<void> {
  const client = await getRpcClient()
  const res = await client.session[':id']['shell-info'].$get({ param: { id: containerId } })
  if (!res.ok) throw await toClientError(res)
  const { containerName } = await res.json()

  await new Promise<void>((resolve, reject) => {
    const child = spawn('podman', ['exec', '-it', containerName, 'zsh'], { stdio: 'inherit' })
    child.on('close', () => resolve())
    child.on('error', reject)
  })
}
