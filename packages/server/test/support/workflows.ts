import { findNamedWorkflow, insertNamedWorkflow, storeWorkflow } from '#db'
import type { StepGraph } from '@yaac/shared/steps'

/**
 * A named workflow holding `steps`, for a test that needs one to point a
 * site or routine at (docs/workflows.md). Answers its id.
 */
export async function namedWorkflowFor(projectId: string, steps: StepGraph = {}, name = `wf-${crypto.randomUUID().slice(0, 8)}`): Promise<string> {
  await insertNamedWorkflow(projectId, name, (await storeWorkflow(projectId, { steps, secrets: [] })).id)
  return (await findNamedWorkflow(projectId, name))!.id
}
