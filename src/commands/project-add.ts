import { getClient, exitOnClientError } from '@/lib/daemon-client'
import { expandOwnerRepo } from '@/lib/project/add'
import type { AddProjectResult } from '@/lib/project/add'

export { expandOwnerRepo, validateGithubHttpsUrl } from '@/lib/project/add'

export async function projectAdd(input: string): Promise<void> {
  const remoteUrl = expandOwnerRepo(input)
  console.log(`Adding project from ${remoteUrl}...`)
  let result: AddProjectResult
  try {
    const client = await getClient()
    result = await client.post<AddProjectResult>('/project/add', { remoteUrl })
  } catch (err) {
    exitOnClientError(err)
  }
  console.log(`Project "${result.project.slug}" added successfully.`)
}
