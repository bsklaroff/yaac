import { getRpcClient } from '#commands/rpc'

export async function toolGet(): Promise<void> {
  const client = await getRpcClient()
  const result = await client.tool.get.$get().then((r) => r.json())
  if (result.tool) {
    console.log(result.tool)
  } else {
    console.log('No default tool configured. Run "yaac tool set <tool>" to set one.')
  }
}
