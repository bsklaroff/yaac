import { api, projectRepoOf, resolveProject } from '#commands/api'

/**
 * `yaac config default-branch <project> [branch]`: show the default branch
 * of a project's repo, or set a hosted repo's (docs/hosted-projects.md),
 * which must exist: the branch a clone checks out, new workspaces fork
 * from, and the guard protects. A repo hosted elsewhere sets it at its git
 * host, and the server refuses it here. `--repo` names the repo of a
 * project with several.
 */
export async function configDefaultBranch(
  project: string,
  branch: string | undefined,
  opts: { repo?: string } = {},
): Promise<void> {
  const summary = await resolveProject(project)
  const repo = projectRepoOf(summary, opts.repo)
  const name = summary.repos.length > 1 ? `${summary.name}/${repo.dir}` : summary.name

  if (branch === undefined) {
    const { defaultBranch } = await api.repo[':repoId'].branches.$get({ param: { repoId: repo.id }, query: {} })
    console.log(`${name}'s default branch is ${defaultBranch}${repo.hosted ? '' : ', set at its git host'}.`)
    return
  }
  await api.repo[':repoId']['default-branch'].$put({ param: { repoId: repo.id }, json: { branch } })
  console.log(`${name}'s default branch is now ${branch}. New workspaces fork from it, and clones check it out.`)
}
