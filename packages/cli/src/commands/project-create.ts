import { api } from '#commands/api'
import { resolveServerTarget } from '@yaac/shared/server-api'
import { hostedCloneUrl } from '@yaac/shared/hosted-git'

/** Create a project with one empty repo whose git remote the server hosts. */
export async function projectCreate(name: string): Promise<void> {
  const project = await api.project.create.$post({ json: { name } })
  const [{ baseUrl }, all] = await Promise.all([resolveServerTarget(), api.project.list.$get()])
  // A name its owner already has names no one project to the CLI.
  const created = all.find((p) => p.id === project.id)
  const ref = all.filter((p) => p.owner === created?.owner && p.name === project.name).length > 1 ? project.id : project.name
  console.log(`Project "${project.name}" (${project.id}) created; yaac hosts its git remote.`)
  const repo = created?.repos.find((r) => r.hosted)
  console.log(`Clone it with \`yaac project clone ${ref}\``
    + (repo !== undefined ? `, or \`git clone ${hostedCloneUrl(baseUrl, repo.id)}\`.` : '.'))
}
