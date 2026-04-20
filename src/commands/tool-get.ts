import { getClient, exitOnClientError } from '@/lib/daemon-client'
import type { AgentTool } from '@/types'

interface ToolGetResponse {
  tool: AgentTool | null
}

export async function toolGet(): Promise<void> {
  let result: ToolGetResponse
  try {
    const client = await getClient()
    result = await client.get<ToolGetResponse>('/tool/get')
  } catch (err) {
    exitOnClientError(err)
  }
  if (result.tool) {
    console.log(result.tool)
  } else {
    console.log('No default tool configured. Run "yaac tool set <tool>" to set one.')
  }
}
