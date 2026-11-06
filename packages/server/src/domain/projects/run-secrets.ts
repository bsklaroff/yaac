import { deleteRunSecret, getRoutineRow, getSiteRow, listRunSecrets, upsertRunSecret, type RunSecretRow } from '#db'
import { ServerError } from '@yaac/shared/errors'
import type { ProjectRunSecret } from '@yaac/shared/types'
import { authorizeProject, type Actor } from '#domain/access'
import { assertProjectExists } from './detail'
import { ENV_NAME_PATTERN, pushProjectSecrets } from './env'

/**
 * A project's run secrets (docs/project-config.md "Run secrets"): values
 * that reach a workspace's environment as they are, under k8s too, and so
 * only reach workspaces whose graph and commit a person chose. Each names
 * the sites whose releases get it and the routines whose runs do; a
 * routine may be named only while it is non-interactive and pinned to a
 * commit, since a branch's tip is whatever an agent last pushed. Only a
 * person sets them: a workspace's agent is refused here, and yaac-mama has
 * no route to them.
 */

function toWire(row: RunSecretRow): ProjectRunSecret {
  return { id: row.id, name: row.name, hasValue: row.value !== undefined, siteIds: row.siteIds, routineIds: row.routineIds }
}

/** Every run secret a project has, for the settings UI. */
export async function listProjectRunSecrets(projectId: string): Promise<ProjectRunSecret[]> {
  await assertProjectExists(projectId)
  return (await listRunSecrets(projectId)).map(toWire)
}

/**
 * Create or replace one run secret. Without a value only its targets
 * change, which needs one stored already. The runtime gets the value at
 * the next launch that names it.
 */
export async function setRunSecret(principal: Actor, projectId: string, input: {
  name: string
  value?: string
  siteIds: string[]
  routineIds: string[]
}): Promise<ProjectRunSecret> {
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
  for (const id of input.siteIds) {
    if ((await getSiteRow(id))?.projectId !== projectId) {
      throw new ServerError('NOT_FOUND', `no site ${id} in this project`)
    }
  }
  for (const id of input.routineIds) {
    const routine = await getRoutineRow(id)
    if (routine?.projectId !== projectId) throw new ServerError('NOT_FOUND', `no routine ${id} in this project`)
    if (!routine.nonInteractive || routine.commit === undefined) {
      throw new ServerError('VALIDATION', `routine "${routine.name}" must be non-interactive and start at a commit `
        + 'to get run secrets, since its runs would otherwise run code no one chose')
    }
  }
  const saved = await upsertRunSecret(projectId, {
    name,
    ...(input.value !== undefined && input.value !== '' ? { value: input.value } : {}),
    siteIds: [...new Set(input.siteIds)],
    routineIds: [...new Set(input.routineIds)],
  })
  if (!saved) throw new ServerError('VALIDATION', `${name}: a value is required for a new run secret`)
  return toWire(saved)
}

/** Remove one run secret by id, and its value from the runtime. */
export async function removeRunSecret(principal: Actor, projectId: string, id: string): Promise<void> {
  await assertProjectExists(projectId)
  await authorizeProject(principal, projectId)
  if (!await deleteRunSecret(projectId, id)) {
    throw new ServerError('NOT_FOUND', `no run secret ${id} in project ${projectId}`)
  }
  await pushProjectSecrets(projectId)
}

/**
 * The run secrets a site or routine (by id) names, with their values, for
 * its workspace's launch, which first hands the runtime the project's
 * current ones (`pushProjectSecrets`). One whose value will not open fails
 * the launch, which would otherwise run without it.
 */
export async function resolveRunSecrets(projectId: string, targetId: string): Promise<Record<string, string>> {
  const values: Record<string, string> = {}
  for (const row of await listRunSecrets(projectId)) {
    if (!row.siteIds.includes(targetId) && !row.routineIds.includes(targetId)) continue
    if (row.value === undefined) {
      throw new ServerError('VALIDATION', `run secret ${row.name} could not be decrypted; re-enter it in project settings`)
    }
    values[row.name] = row.value
  }
  return values
}
