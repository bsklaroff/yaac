import { getRpcClient } from '#commands/rpc'

export async function toolSet(toolName: string): Promise<void> {
  const client = await getRpcClient()
  const { tool } = await client.tool.set.$post({ json: { tool: toolName } }).then((r) => r.json())
  console.log(`Default tool set to "${tool}".`)
}
