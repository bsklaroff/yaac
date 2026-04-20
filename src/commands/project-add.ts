import { toClientError } from '@/lib/daemon-client'
import { getRpcClient } from '@/lib/daemon-rpc-client'
import { expandOwnerRepo } from '@/lib/project/add'

export { expandOwnerRepo, validateGithubHttpsUrl } from '@/lib/project/add'

export async function projectAdd(input: string): Promise<void> {
  const remoteUrl = expandOwnerRepo(input)
  console.log(`Adding project from ${remoteUrl}...`)
  const client = await getRpcClient()
  const res = await client.project.add.$post({ json: { remoteUrl } })
  if (!res.ok) throw await toClientError(res)
  const result = await res.json()
  console.log(`Project "${result.project.slug}" added successfully.`)
}
