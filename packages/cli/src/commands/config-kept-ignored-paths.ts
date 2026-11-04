import { api, projectScope, resolveProjectId } from '#commands/api'

/**
 * `yaac config kept-ignored-paths <project> [paths...] [--none]`: show or
 * replace the gitignored paths a project's workspaces keep when they stop,
 * which removes every other ignored file from the checkout
 * (docs/workspace-storage.md "Ignored files at stop").
 */
export async function configKeptIgnoredPaths(project: string, paths: string[], opts: { none?: boolean }): Promise<void> {
  const scope = await projectScope()
  const projectId = await resolveProjectId(project, scope)
  const summary = scope.all.find((p) => p.id === projectId)
  const name = summary?.name ?? projectId
  const list = (all: string[]): string => (all.length === 0 ? 'none' : all.join(', '))

  if (paths.length === 0 && opts.none !== true) {
    console.log(`Ignored paths ${name} keeps at stop: ${list(summary?.keptIgnoredPaths ?? [])}`)
    return
  }
  if (paths.length > 0 && opts.none === true) throw new Error('Pass paths or --none, not both.')
  const stored = await api.project[':projectId']['kept-ignored-paths'].$put({ param: { projectId }, json: { paths } })
  console.log(`Ignored paths ${name} keeps at stop are now: ${list(stored.paths)}. Applies from each workspace's next stop.`)
}
