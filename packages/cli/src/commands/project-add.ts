import { api } from '#commands/api'

export async function projectAdd(input: string): Promise<void> {
  console.log(`Adding project from ${input}...`)
  const result = await api.project.add.$post({ json: { remoteUrl: input } })
  console.log(`Project "${result.project.slug}" added successfully.`)
}
