import { projectScope } from '#commands/api'
import { printTable } from '#commands/table'

/** The projects in scope (`projectScope`): the caller's, or `--user`'s. */
export async function projectList(): Promise<void> {
  const { projects } = await projectScope()

  if (projects.length === 0) {
    console.log('No projects found. Add one with `yaac project add <remote-url> <credential>`, or create one with `yaac project create <name>`.')
    return
  }

  // The id prefix tells apart projects that share a name; any command taking
  // a project accepts either.
  printTable(
    [{ header: 'PROJECT' }, { header: 'ID' }, { header: 'REMOTE' }, { header: 'WORKSPACES' }],
    projects.map((p) => [p.name, p.id.slice(0, 8), p.hosted ? '(hosted by yaac)' : p.remoteUrl, String(p.workspaceCount)]),
  )
}
