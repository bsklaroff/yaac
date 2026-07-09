import { getRpcClient, toClientError } from '@/commands/rpc'
import { runInteractiveExec } from '@/lib/k8s/exec'

export async function sessionShell(containerId: string): Promise<void> {
  const client = await getRpcClient()
  const res = await client.session[':id']['attach-info'].$get({ param: { id: containerId } })
  if (!res.ok) throw await toClientError(res)
  const { jobName } = await res.json()

  await runInteractiveExec(jobName, ['zsh'])
}
