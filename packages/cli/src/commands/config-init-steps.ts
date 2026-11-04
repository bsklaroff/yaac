import { api, resolveProject } from '#commands/api'
import { readSteps } from '#commands/workspace-create'

/**
 * `yaac config init-steps <project> [--file <path> | --none]`: print a
 * project's init steps, the step graph every workspace runs at start unless
 * its create brings its own (docs/workspace-steps.md), as JSON; or replace
 * them with a JSON file's, or with none.
 */
export async function configInitSteps(project: string, opts: { file?: string; none?: boolean }): Promise<void> {
  const summary = await resolveProject(project)
  const projectId = summary.id
  if (opts.file === undefined && opts.none !== true) {
    console.log(JSON.stringify(summary.initSteps, null, 2))
    return
  }
  if (opts.file !== undefined && opts.none === true) throw new Error('Pass --file or --none, not both.')
  const steps = opts.none === true ? {} : await readSteps(opts.file ?? '')
  const stored = await api.project[':projectId']['init-steps'].$put({ param: { projectId }, json: { steps } })
  const names = Object.keys(stored.steps)
  console.log(`Init steps in ${summary.name} are now: ${names.length === 0 ? 'none' : names.join(', ')}. `
    + 'Workspaces run them from their next start.')
}
