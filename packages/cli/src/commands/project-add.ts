import { getRpcClient } from '#commands/rpc'

export async function projectAdd(input: string): Promise<void> {
  console.log(`Adding project from ${input}...`)
  const client = await getRpcClient()
  const result = await client.project.add.$post({ json: { remoteUrl: input } }).then((r) => r.json())
  console.log(`Project "${result.project.slug}" added successfully.`)
}
