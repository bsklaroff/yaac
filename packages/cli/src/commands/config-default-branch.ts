import { api, projectScope, resolveProjectId } from '#commands/api'

/**
 * `yaac config default-branch <project> [branch]`: show a project's default
 * branch, or set a hosted project's (docs/hosted-projects.md), which must
 * exist: the branch a clone checks out, new workspaces fork from, and the
 * guard protects. A project hosted elsewhere sets it at its git host, and
 * the server refuses it here.
 */
export async function configDefaultBranch(project: string, branch: string | undefined): Promise<void> {
  const scope = await projectScope()
  const projectId = await resolveProjectId(project, scope)
  const summary = scope.all.find((p) => p.id === projectId)
  const name = summary?.name ?? projectId

  if (branch === undefined) {
    const { defaultBranch } = await api.project[':projectId'].branches.$get({ param: { projectId }, query: {} })
    console.log(`${name}'s default branch is ${defaultBranch}${summary?.hosted === false ? ', set at its git host' : ''}.`)
    return
  }
  await api.project[':projectId']['default-branch'].$put({ param: { projectId }, json: { branch } })
  console.log(`${name}'s default branch is now ${branch}. New workspaces fork from it, and clones check it out.`)
}
