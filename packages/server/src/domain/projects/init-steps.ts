/**
 * A project's init steps (docs/workspace-steps.md): the step graph every
 * workspace runs at start unless its create brings its own.
 */
import { ServerError } from '@yaac/shared/errors'
import { parseStepGraph, type StepGraph } from '@yaac/shared/steps'
import { setProjectInitSteps } from '#db'
import { authorizeProject, type Actor } from '#domain/access'
import { assertProjectExists } from './detail'

/** Replace a project's init steps and answer them as stored. */
export async function setInitSteps(principal: Actor, projectId: string, raw: unknown): Promise<StepGraph> {
  await assertProjectExists(projectId)
  await authorizeProject(principal, projectId)
  let graph: StepGraph
  try {
    graph = parseStepGraph(raw)
  } catch (err) {
    throw new ServerError('VALIDATION', `init steps: ${(err as Error).message}`)
  }
  if (!await setProjectInitSteps(projectId, graph)) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  return graph
}
