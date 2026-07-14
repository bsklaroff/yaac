import { api } from '#commands/api'

export async function toolSet(toolName: string): Promise<void> {
  const { tool } = await api.tool.set.$post({ json: { tool: toolName } })
  console.log(`Default tool set to "${tool}".`)
}
