import { api, resolveProject } from '#commands/api'
import { readSteps } from '#commands/workspace-create'

/**
 * `yaac config init-steps <project> [--file <path> | --workflow <name> |
 * --none]`: print a project's init steps, the step graph every workspace
 * runs at start unless its create brings its own (docs/workspace-steps.md),
 * as JSON; or replace them with a JSON file's, a named workflow to follow
 * (docs/workflows.md), or none.
 */
export async function configInitSteps(project: string, opts: { file?: string; workflow?: string; none?: boolean }): Promise<void> {
  const summary = await resolveProject(project)
  const projectId = summary.id
  const given = [opts.file, opts.workflow, opts.none === true ? true : undefined].filter((o) => o !== undefined)
  if (given.length === 0) {
    if (summary.initWorkflow !== undefined) console.error(`Following workflow "${summary.initWorkflow}".`)
    console.log(JSON.stringify(summary.initSteps, null, 2))
    return
  }
  if (given.length > 1) throw new Error('Pass one of --file, --workflow and --none.')
  const stored = await api.project[':projectId']['init-steps'].$put({
    param: { projectId },
    json: opts.workflow !== undefined ? { workflow: opts.workflow } : { steps: opts.none === true ? {} : await readSteps(opts.file ?? '') },
  })
  const names = Object.keys(stored.steps)
  console.log(`Init steps in ${summary.name} are now: ${names.length === 0 ? 'none' : names.join(', ')}. `
    + 'Workspaces run them from their next start.')
}
