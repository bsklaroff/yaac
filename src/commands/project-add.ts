import { getRpcClient, toClientError } from '@/commands/rpc'

export async function projectAdd(input: string): Promise<void> {
  console.log(`Adding project from ${input}...`)
  const client = await getRpcClient()
  const res = await client.project.add.$post({ json: { remoteUrl: input } })
  if (!res.ok) throw await toClientError(res)
  const result = await res.json()
  console.log(`Project "${result.project.slug}" added successfully.`)
}
