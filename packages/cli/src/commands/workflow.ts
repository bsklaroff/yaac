import { api, resolveProjectId } from '#commands/api'
import { printTable } from '#commands/table'
import { readSteps } from '#commands/workspace-create'
import type { WorkflowEntry } from '@yaac/shared/types'

/**
 * `yaac workflow …`: a project's named workflows (docs/workflows.md), which
 * routines, sites, creates and queued workspaces run by name, and the run
 * secrets each is given.
 */

export interface WorkflowOptions {
  /** A JSON file of its steps. */
  file?: string
  /** Run secrets it is given (repeatable). */
  secret: string[]
  /** False (`--no-secrets`) to give it none. */
  secrets?: boolean
}

function summary(w: WorkflowEntry): string {
  const secrets = w.secrets.length > 0 ? `, given ${w.secrets.join(', ')}` : ''
  return `workflow "${w.name}" (${Object.keys(w.steps).join(', ') || 'no steps'})${secrets}`
}

export async function workflowCreate(project: string, name: string, opts: WorkflowOptions & { file: string }): Promise<void> {
  const created = await api.workflow.create.$post({ json: {
    project: await resolveProjectId(project),
    name,
    steps: await readSteps(opts.file),
    ...(opts.secret.length > 0 ? { secrets: opts.secret } : {}),
  } })
  console.log(`Created ${summary(created)}.`)
}

/**
 * New steps, new secrets, or both. Secrets are given only
 * with the steps they reach (`--file`), so the graph they go to is the one
 * in the file, not whatever the workflow holds now.
 */
export async function workflowEdit(project: string, name: string, opts: WorkflowOptions): Promise<void> {
  if (opts.secret.length > 0 && opts.secrets === false) throw new Error('Pass --secret or --no-secrets, not both.')
  const secrets = opts.secrets === false ? [] : opts.secret.length > 0 ? opts.secret : undefined
  if (opts.file === undefined && secrets === undefined) throw new Error('Nothing to change: give --file, --secret or --no-secrets.')
  const edited = await api.workflow.edit.$post({ json: {
    project: await resolveProjectId(project),
    name,
    ...(opts.file !== undefined ? { steps: await readSteps(opts.file) } : {}),
    ...(secrets !== undefined ? { secrets } : {}),
  } })
  console.log(`Updated ${summary(edited)}.`)
}

export async function workflowList(project: string): Promise<void> {
  const workflows = await api.workflow.list.$get({ query: { project: await resolveProjectId(project) } })
  if (workflows.length === 0) {
    console.log(`No workflows in ${project}. Create one with: yaac workflow create ${project} <name> --file <steps.json>`)
    return
  }
  printTable(
    [{ header: 'NAME' }, { header: 'STEPS' }, { header: 'SECRETS' }],
    workflows.map((w) => [w.name, Object.keys(w.steps).join(', '), w.secrets.join(', ') || '-']),
  )
}

export async function workflowShow(project: string, name: string): Promise<void> {
  const w = await api.workflow.show.$get({ query: { project: await resolveProjectId(project), name } })
  console.log(`Workflow "${w.name}":`)
  console.log(JSON.stringify(w.steps, null, 2))
  console.log(`  secrets            ${w.secrets.join(', ') || '-'}`)
  console.log(`  approved commits   ${w.approvedCommits.map((c) => c.slice(0, 12)).join(', ') || '-'}`)
  console.log(`  approved branches  ${w.approvedBranches.join(', ') || '-'}`)
}

export async function workflowDelete(project: string, name: string): Promise<void> {
  await api.workflow.delete.$post({ json: { project: await resolveProjectId(project), name } })
  console.log(`Deleted workflow "${name}".`)
}
