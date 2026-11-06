import { deleteRunSecret, listRunSecrets, upsertRunSecret, type RunSecretRow } from '#db'
import { ServerError } from '@yaac/shared/errors'
import type { ProjectRunSecret } from '@yaac/shared/types'
import { authorizeProject, type Actor } from '#domain/access'
import { assertProjectExists } from './detail'
import { ENV_NAME_PATTERN, pushProjectSecrets } from './env'

/**
 * A project's run secrets (docs/project-config.md "Run secrets"): values
 * that reach a workspace's environment as they are, under k8s too, and so
 * only through a workflow revision a person gave them to
 * (docs/workflows.md). Only a person sets them: a workspace's agent is
 * refused here, and yaac-mama has no route to them.
 */

function toWire(row: RunSecretRow): ProjectRunSecret {
  return { id: row.id, name: row.name, hasValue: row.value !== undefined }
}

/** Every run secret a project has, for the settings UI. */
export async function listProjectRunSecrets(projectId: string): Promise<ProjectRunSecret[]> {
  await assertProjectExists(projectId)
  return (await listRunSecrets(projectId)).map(toWire)
}

/** Create or replace one run secret. The runtime gets the value at the
 *  next launch that names it. */
export async function setRunSecret(principal: Actor, projectId: string, input: { name: string; value: string }): Promise<ProjectRunSecret> {
  await assertProjectExists(projectId)
  await authorizeProject(principal, projectId)
  if (principal.kind === 'workspace') {
    throw new ServerError('FORBIDDEN', 'run secrets are set by a person, in the webapp or with `yaac config env`')
  }
  const name = input.name.trim()
  if (!ENV_NAME_PATTERN.test(name)) {
    throw new ServerError('VALIDATION', `"${name}" is not a valid environment variable name (letters, digits and `
      + 'underscores, not starting with a digit)')
  }
  if (input.value === '') throw new ServerError('VALIDATION', `${name}: a value is required`)
  return toWire(await upsertRunSecret(projectId, { name, value: input.value }))
}

/** Remove one run secret by id, and its value from the runtime. A launch
 *  of a revision that names it then fails. */
export async function removeRunSecret(principal: Actor, projectId: string, id: string): Promise<void> {
  await assertProjectExists(projectId)
  await authorizeProject(principal, projectId)
  if (!await deleteRunSecret(projectId, id)) {
    throw new ServerError('NOT_FOUND', `no run secret ${id} in project ${projectId}`)
  }
  await pushProjectSecrets(projectId)
}
