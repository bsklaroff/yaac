import { api, projectRepoOf, resolveProject } from '#commands/api'

/**
 * `yaac config upstream-rebase <project> [on|off]`: show or set whether a
 * hosted fork's default-branch guard lets a push through that rebases the
 * branch onto the upstream's (docs/repo-forks.md "Catching up with the
 * upstream"). `--repo` names the repo of a project with several.
 */
export async function configUpstreamRebase(
  project: string,
  value: 'on' | 'off' | undefined,
  opts: { repo?: string } = {},
): Promise<void> {
  const summary = await resolveProject(project)
  const repo = projectRepoOf(summary, opts.repo)
  const name = summary.repos.length > 1 ? `${summary.name}/${repo.dir}` : summary.name
  const state = (on: boolean): string => (on
    ? 'lets a rebase of its default branch onto the upstream through the guard'
    : 'refuses every rewrite of its default branch, so catching up is a merge')
  if (value === undefined) {
    console.log(!repo.hosted || repo.upstream === undefined
      ? `${name} is not a fork yaac hosts, so the setting does not apply.`
      : `${name} ${state(repo.guardAllowsCatchUp)}.`)
    return
  }
  await api.repo[':repoId']['upstream-rebase'].$put({ param: { repoId: repo.id }, json: { enabled: value === 'on' } })
  console.log(`${name} now ${state(value === 'on')}.`)
}
