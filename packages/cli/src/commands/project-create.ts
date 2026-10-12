import { api } from '#commands/api'
import { resolveServerTarget } from '@yaac/shared/server-api'
import { hostedCloneUrl } from '@yaac/shared/hosted-git'

/** Create an empty project whose git remote the server hosts. */
export async function projectCreate(name: string): Promise<void> {
  const project = await api.project.create.$post({ json: { name } })
  const { baseUrl } = await resolveServerTarget()
  console.log(`Project "${project.name}" (${project.id}) created; yaac hosts its git remote.`)
  console.log(`Clone it with \`yaac project clone ${project.name}\`, or \`git clone ${hostedCloneUrl(baseUrl, project.id)}\`.`)
}
