import { api } from '#commands/api'

/**
 * `yaac workspace step …`: a running workspace's steps
 * (docs/workspace-steps.md). A step is named `<workflow>.<step>`, and a
 * bare name addresses it while only one workflow has a step so named; a
 * workspace is addressed by id or unique prefix.
 */

export interface StepAddOptions {
  /** Its commands, run in order in one shell. */
  run: string[]
  name?: string
  /** Comma-separated steps that must succeed (or a service be ready) first. */
  needs?: string
  service?: boolean
  ready?: string
  /** A named workflow whose steps to add instead (docs/workflows.md). */
  workflow?: string
  /** The repos it runs in, by folder (repeatable): one's checkout, or the
   *  workspace root for several. */
  repo: string[]
}

/** Add a step to a running workspace, or a named workflow's steps,
 *  printing their names. */
export async function stepAdd(workspace: string, opts: StepAddOptions): Promise<void> {
  if (opts.workflow !== undefined) {
    if (opts.run.length > 0 || opts.name !== undefined || opts.needs !== undefined || opts.service === true
      || opts.ready !== undefined || opts.repo.length > 0) {
      throw new Error('--workflow adds that workflow\'s steps as they are; it takes no other step option.')
    }
    const added = await api.workspace[':id'].steps.$post({ param: { id: workspace }, json: { workflow: opts.workflow } })
    console.log(added.map((s) => s.name).join('\n'))
    return
  }
  if (opts.run.length === 0) throw new Error('Give the step\'s commands with --run (repeat it for more), or --workflow.')
  if (opts.ready !== undefined && opts.service !== true) throw new Error('--ready goes with --service: only a service has a ready check.')
  const needs = opts.needs?.split(',').map((n) => n.trim()).filter((n) => n !== '') ?? []
  const added = await api.workspace[':id'].steps.$post({
    param: { id: workspace },
    json: {
      steps: {
        [opts.name ?? 'run']: {
          run: opts.run,
          ...(needs.length > 0 ? { needs } : {}),
          ...(opts.service === true ? { service: true } : {}),
          ...(opts.ready !== undefined ? { ready: opts.ready } : {}),
        },
      },
      ...(opts.repo.length > 0 ? { repos: opts.repo } : {}),
    },
  })
  console.log(added.map((s) => s.name).join('\n'))
}

/** Run a finished step again, with the steps it caused to be skipped. */
export async function stepRerun(workspace: string, name: string): Promise<void> {
  const step = await api.workspace[':id'].steps[':name'].rerun.$post({ param: { id: workspace, name } })
  console.log(`Rerunning step ${step.name}.`)
}

/** Stop a step that has not finished; the steps that need it are skipped. */
export async function stepCancel(workspace: string, name: string): Promise<void> {
  await api.workspace[':id'].steps[':name'].cancel.$post({ param: { id: workspace, name } })
  console.log(`Cancelled step ${name}.`)
}
