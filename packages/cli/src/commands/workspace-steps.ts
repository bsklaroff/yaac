import { randomBytes } from 'node:crypto'
import { api } from '#commands/api'

/**
 * `yaac workspace step …`: a running workspace's steps
 * (docs/workspace-steps.md). Steps are named; a workspace is addressed by
 * id or unique prefix.
 */

export interface StepAddOptions {
  /** Its commands, run in order in one shell. */
  run: string[]
  name?: string
  /** Comma-separated steps that must succeed (or a service be ready) first. */
  needs?: string
  service?: boolean
  ready?: string
}

/** Add a step to a running workspace, printing its name. */
export async function stepAdd(workspace: string, opts: StepAddOptions): Promise<void> {
  if (opts.run.length === 0) throw new Error('Give the step\'s commands with --run (repeat it for more).')
  if (opts.ready !== undefined && opts.service !== true) throw new Error('--ready goes with --service: only a service has a ready check.')
  const name = opts.name ?? `run-${randomBytes(4).toString('hex')}`
  const needs = opts.needs?.split(',').map((n) => n.trim()).filter((n) => n !== '') ?? []
  await api.workspace[':id'].steps.$post({
    param: { id: workspace },
    json: {
      steps: {
        [name]: {
          run: opts.run,
          ...(needs.length > 0 ? { needs } : {}),
          ...(opts.service === true ? { service: true } : {}),
          ...(opts.ready !== undefined ? { ready: opts.ready } : {}),
        },
      },
    },
  })
  console.log(name)
}

/** Run a finished step again, with the steps it caused to be skipped. */
export async function stepRerun(workspace: string, name: string): Promise<void> {
  await api.workspace[':id'].steps[':name'].rerun.$post({ param: { id: workspace, name } })
  console.log(`Rerunning step ${name}.`)
}

/** Stop a step that has not finished; the steps that need it are skipped. */
export async function stepCancel(workspace: string, name: string): Promise<void> {
  await api.workspace[':id'].steps[':name'].cancel.$post({ param: { id: workspace, name } })
  console.log(`Cancelled step ${name}.`)
}
