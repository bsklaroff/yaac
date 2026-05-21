import { spawn } from 'node:child_process'
import { getRpcClient, toClientError } from '@/commands/rpc'
import { CONTAINER_TMUX_SOCK } from '@/shared/paths'

export async function sessionAttach(containerId: string): Promise<void> {
  const client = await getRpcClient()
  const res = await client.session[':id']['attach-info'].$get({ param: { id: containerId } })
  if (!res.ok) throw await toClientError(res)
  const { containerName, tmuxSession } = await res.json()

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'podman',
      ['exec', '-it', containerName, 'tmux', '-S', CONTAINER_TMUX_SOCK, 'attach-session', '-t', tmuxSession],
      { stdio: 'inherit' },
    )
    child.on('close', () => resolve())
    child.on('error', reject)
  })
}
