import { api, resolveProject } from '#commands/api'
import type { ScratchDirSettings } from '@yaac/shared/types'

/**
 * `yaac config scratch-dirs <project> [dirs...] [--none] [--size GiB]`: show
 * the project's scratch directories, the dirs of installed packages and
 * build output that each workspace keeps off its checkout and empties when
 * it stops (docs/workspace-storage.md "Package installs"), and what they
 * may hold together; or replace the dirs, the size, or both.
 */
export async function configScratchDirs(project: string, dirs: string[], opts: { none?: boolean; size?: string }): Promise<void> {
  const summary = await resolveProject(project)
  const { id: projectId, name } = summary
  const describe = (s: ScratchDirSettings): string =>
    `${s.dirs.length === 0 ? 'none' : s.dirs.map((d) => d.path).join(', ')}, holding at most ${String(s.sizeGiB)} GiB together`

  if (dirs.length === 0 && opts.none !== true && opts.size === undefined) {
    console.log(`Scratch directories in ${name}: ${describe(summary.scratchDirs)}`)
    const ignored = summary.scratchDirs.ignoredTracked ?? []
    if (ignored.length > 0) console.log(`Not warned about when tracked in git: ${ignored.join(', ')}`)
    return
  }
  if (dirs.length > 0 && opts.none === true) throw new Error('Pass directories or --none, not both.')
  const capped = dirs.find((d) => /:\d+$/.test(d))
  if (capped !== undefined) throw new Error(`${capped}: scratch dirs share one size, set with --size.`)
  const size = opts.size === undefined ? undefined : /^\d+$/.test(opts.size) ? Number(opts.size) : NaN
  if (size !== undefined && !(Number.isInteger(size) && size >= 1 && size <= 1024)) {
    throw new Error('--size takes a whole number of GiB, from 1 to 1024.')
  }
  const stored = await api.project[':projectId']['scratch-dirs'].$put({
    param: { projectId },
    json: {
      ...(dirs.length > 0 || opts.none === true ? { dirs: dirs.map((path) => ({ path })) } : {}),
      ...(size !== undefined ? { sizeGiB: size } : {}),
    },
  })
  console.log(`Scratch directories in ${name} are now: ${describe(stored)}. Workspaces pick this up when they next start.`)
}
