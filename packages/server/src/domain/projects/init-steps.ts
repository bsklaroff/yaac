/**
 * A project's init steps (docs/workspace-steps.md): what every workspace
 * runs at start unless its create brings its own. A graph given here is a
 * workflow of its own; a named workflow is followed to its current one
 * (docs/workflows.md).
 */
import { ServerError } from '@yaac/shared/errors'
import { parseStepGraph, type StepGraph } from '@yaac/shared/steps'
import { setProjectInit, storeWorkflow } from '#db'
import { authorizeProject, type Actor } from '#domain/access'
import { assertProjectExists } from './detail'
import { resolveWorkflow } from './workflows'

/** Replace a project's init steps with a graph and answer it as stored;
 *  an empty one is none. */
export async function setInitSteps(principal: Actor, projectId: string, raw: unknown): Promise<StepGraph> {
  await assertProjectExists(projectId)
  await authorizeProject(principal, projectId)
  let graph: StepGraph
  try {
    graph = parseStepGraph(raw)
  } catch (err) {
    throw new ServerError('VALIDATION', `init steps: ${(err as Error).message}`)
  }
  const init = Object.keys(graph).length > 0
    ? { workflowId: (await storeWorkflow(projectId, { steps: graph, secrets: [] })).id }
    : null
  await setProjectInit(projectId, init)
  return graph
}

/** Make a project's init steps follow a named workflow. */
export async function setInitWorkflow(principal: Actor, projectId: string, name: string): Promise<StepGraph> {
  await assertProjectExists(projectId)
  await authorizeProject(principal, projectId)
  const named = await resolveWorkflow(projectId, name)
  await setProjectInit(projectId, { namedWorkflowId: named.id })
  return named.workflow.steps
}
