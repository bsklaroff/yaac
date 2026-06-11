import { spawn } from 'node:child_process'
import { getRpcClient, toClientError } from '@/commands/rpc'
import { interactiveExecArgs } from '@/lib/k8s/exec'

export async function sessionShell(containerId: string): Promise<void> {
  const client = await getRpcClient()
  const res = await client.session[':id']['shell-info'].$get({ param: { id: containerId } })
  if (!res.ok) throw await toClientError(res)
  const { jobName } = await res.json()

  await new Promise<void>((resolve, reject) => {
    const child = spawn('kubectl', interactiveExecArgs(jobName, ['zsh']), { stdio: 'inherit' })
    child.on('close', () => resolve())
    child.on('error', reject)
  })
}
