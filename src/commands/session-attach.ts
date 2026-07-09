import { getRpcClient, toClientError } from '@/commands/rpc'
import { attachTmux } from '@/lib/k8s/exec'

export async function sessionAttach(containerId: string): Promise<void> {
  const client = await getRpcClient()
  const res = await client.session[':id']['attach-info'].$get({ param: { id: containerId } })
  if (!res.ok) throw await toClientError(res)
  const { jobName, tmuxSession } = await res.json()

  await attachTmux(jobName, tmuxSession)
}
