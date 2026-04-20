import { getClient, exitOnClientError } from '@/lib/daemon-client'
import type { AgentTool } from '@/types'

export async function toolSet(toolName: string): Promise<void> {
  let saved: AgentTool
  try {
    const client = await getClient()
    const res = await client.post<{ tool: AgentTool }>('/tool/set', { tool: toolName })
    saved = res.tool
  } catch (err) {
    exitOnClientError(err)
  }
  console.log(`Default tool set to "${saved}".`)
}
