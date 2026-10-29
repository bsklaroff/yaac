import { api, projectScope, resolveProjectId } from '#commands/api'
import { DEFAULT_SCRATCH_DIR_GIB, type ScratchDir } from '@yaac/shared/types'

/**
 * `yaac config scratch-dirs <project> [dirs...] [--none]`: show the
 * project's scratch directories, the dirs of installed packages and build
 * output that each workspace keeps off its checkout and empties when it
 * stops (docs/workspace-storage.md "Package installs"), or replace them.
 * Each dir is `path`, capped at the default, or `path:GiB`.
 */
export async function configScratchDirs(project: string, dirs: string[], opts: { none?: boolean }): Promise<void> {
  const scope = await projectScope()
  const projectId = await resolveProjectId(project, scope)
  const summary = scope.all.find((p) => p.id === projectId)
  const name = summary?.name ?? projectId
  const list = (all: ScratchDir[]): string => (all.length === 0 ? 'none' : all.map((d) =>
    `${d.path} (${d.sizeGiB !== undefined ? `${d.sizeGiB} GiB` : `${DEFAULT_SCRATCH_DIR_GIB} GiB, the default`})`).join(', '))

  if (dirs.length === 0 && opts.none !== true) {
    console.log(`Scratch directories in ${name}: ${list(summary?.scratchDirs.dirs ?? [])}`)
    const ignored = summary?.scratchDirs.ignoredTracked ?? []
    if (ignored.length > 0) console.log(`Not warned about when tracked in git: ${ignored.join(', ')}`)
    return
  }
  if (dirs.length > 0 && opts.none === true) throw new Error('Pass directories or --none, not both.')
  const wanted = dirs.map((arg) => {
    const [, path, size] = /^(.*?)(?::(\d+))?$/.exec(arg) ?? []
    return size !== undefined ? { path, sizeGiB: Number(size) } : { path }
  })
  const stored = await api.project[':projectId']['scratch-dirs'].$put({ param: { projectId }, json: { dirs: wanted } })
  console.log(`Scratch directories in ${name} are now: ${list(stored.dirs)}. `
    + 'Workspaces pick this up when they next start.')
}
