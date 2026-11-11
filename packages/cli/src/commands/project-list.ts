import { projectScope } from '#commands/api'
import { printTable } from '#commands/table'
import type { ProjectRepo } from '@yaac/shared/types'

/** How a listing names a repo's remote. */
export const repoRemote = (repo: Pick<ProjectRepo, 'hosted' | 'remoteUrl'>): string =>
  (repo.hosted ? '(hosted by yaac)' : repo.remoteUrl)

/** The projects in scope (`projectScope`): the caller's, or `--user`'s. */
export async function projectList(): Promise<void> {
  const { projects } = await projectScope()

  if (projects.length === 0) {
    console.log('No projects found. Add one with `yaac project add <remote-url> <credential>`, or create one with `yaac project create <name>`.')
    return
  }

  // The id prefix tells apart projects that share a name; any command taking
  // a project accepts either. A project with several repos lists each as
  // its folder and remote.
  printTable(
    [{ header: 'PROJECT' }, { header: 'ID' }, { header: 'WORKSPACES' }, { header: 'REPOS' }],
    projects.map((p) => [
      p.name,
      p.id.slice(0, 8),
      String(p.workspaceCount),
      p.repos.length === 0 ? '(none)'
        : p.repos.length === 1 ? repoRemote(p.repos[0])
        : p.repos.map((r) => `${r.dir}: ${repoRemote(r)}`).join(', '),
    ]),
  )
}
