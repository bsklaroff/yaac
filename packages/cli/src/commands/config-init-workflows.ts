import { api, resolveProjectId } from '#commands/api'
import type { WorkflowEntry } from '@yaac/shared/types'

/**
 * `yaac config init-workflows <project> [workflows...] [--none]`: print a
 * project's init workflows, the named workflows every workspace that brings
 * no graph of its own and has their repos starts (docs/workflows.md "Init
 * workflows"), each with its repos and steps; or make exactly the named
 * ones its init workflows, or none.
 */
export async function configInitWorkflows(project: string, names: string[], opts: { none?: boolean }): Promise<void> {
  const projectId = await resolveProjectId(project)
  if (opts.none === true && names.length > 0) throw new Error('Pass workflow names or --none, not both.')
  if (opts.none !== true && names.length === 0) {
    const init = (await api.workflow.list.$get({ query: { project: projectId } })).filter((w) => w.init)
    if (init.length === 0) {
      console.log(`${project} has no init workflows. Make one with: yaac workflow create ${project} <name> --file <steps.json> --init`)
      return
    }
    for (const w of init) printInit(w)
    return
  }
  const init = await api.project[':projectId']['init-workflows'].$put({ param: { projectId }, json: { workflows: names } })
  console.log(`Init workflows of ${project} are now: ${init.length === 0 ? 'none' : init.map((w) => w.name).join(', ')}. `
    + 'Workspaces start them from their next start.')
}

function printInit(w: WorkflowEntry): void {
  console.log(`${w.name}  repos ${w.repos.join(', ') || 'none (runs in every workspace, in its cwd)'}`)
  console.log(JSON.stringify(w.steps, null, 2))
}
