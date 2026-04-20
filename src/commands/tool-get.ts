import { toClientError } from '@/lib/daemon-client'
import { getRpcClient } from '@/lib/daemon-rpc-client'

export async function toolGet(): Promise<void> {
  const client = await getRpcClient()
  const res = await client.tool.get.$get()
  if (!res.ok) throw await toClientError(res)
  const result = await res.json()
  if (result.tool) {
    console.log(result.tool)
  } else {
    console.log('No default tool configured. Run "yaac tool set <tool>" to set one.')
  }
}
