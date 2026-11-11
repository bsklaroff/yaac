import { api, projectRepoOf, resolveProject } from '#commands/api'

/**
 * `yaac config default-branch-guard <project> [on|off]`: show or set
 * whether a project's hosted repo refuses pushes that delete its default
 * branch or rewrite its history (docs/hosted-projects.md). A repo hosted
 * elsewhere is protected at its git host, and the server refuses it here.
 * `--repo` names the repo of a project with several.
 */
export async function configDefaultBranchGuard(
  project: string,
  value: 'on' | 'off' | undefined,
  opts: { repo?: string } = {},
): Promise<void> {
  const summary = await resolveProject(project)
  const repo = projectRepoOf(summary, opts.repo)
  const name = summary.repos.length > 1 ? `${summary.name}/${repo.dir}` : summary.name
  const state = (on: boolean): string => (on ? 'refuses' : 'accepts')

  if (value === undefined) {
    console.log(repo.hosted
      ? `${name} ${state(repo.guardDefaultBranch)} pushes that delete its default branch or rewrite its history.`
      : `${name} is not hosted by yaac; its git host protects its branches.`)
    return
  }
  await api.repo[':repoId']['default-branch-guard'].$put({ param: { repoId: repo.id }, json: { enabled: value === 'on' } })
  console.log(`${name} now ${state(value === 'on')} pushes that delete its default branch or rewrite its history.`)
}
