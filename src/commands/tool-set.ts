import { toClientError } from '@/lib/daemon-client'
import { getRpcClient } from '@/lib/daemon-rpc-client'

export async function toolSet(toolName: string): Promise<void> {
  const client = await getRpcClient()
  const res = await client.tool.set.$post({ json: { tool: toolName } })
  if (!res.ok) throw await toClientError(res)
  const { tool } = await res.json()
  console.log(`Default tool set to "${tool}".`)
}
