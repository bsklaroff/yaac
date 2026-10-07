import { ServerError } from '@yaac/shared/errors'
import type { ImageBuildEntry, ImageLayerName } from '@yaac/shared/types'
import { workspaceDriver } from '#drivers/driver'
import type { ProjectReaders } from '#drivers/contract'
import { getProjectRow } from '#db'
import { authorizeProject, type Actor } from '#domain/access'
import { resolveProjectConfig } from './config'

/**
 * The user's controls on the image build feed. A build of a project's own
 * layers is its owner's to retry or dismiss; the shared images every chain
 * starts from are anyone's (docs/plans/multi-user-deployment.md "Image
 * builds").
 */

/** The layers built per project, from its owner's files. */
const PROJECT_LAYERS = new Set<ImageLayerName>(['project', 'user'])

/**
 * The build the feed lists under `id`, once `principal` may act on it, or
 * undefined for one it does not list (unknown or dismissed). The caller
 * then does nothing, so a build the check cannot see is never acted on.
 */
async function authorizedImageBuild(principal: Actor, id: string): Promise<ImageBuildEntry | undefined> {
  const build = workspaceDriver().listImageBuilds().find((b) => b.id === id)
  if (build && PROJECT_LAYERS.has(build.layer)) {
    for (const projectId of build.projectIds) await authorizeProject(principal, projectId)
  }
  return build
}

/**
 * What a rebuild reads about each project, which the runtime may not read
 * itself. (`null` from the store and `undefined` for the contract both mean
 * "no config".)
 */
const projectReaders: ProjectReaders = {
  projectConfig: (projectId) => resolveProjectConfig(projectId).then((cfg) => cfg ?? undefined),
  projectOwner: async (projectId) => {
    const row = await getProjectRow(projectId)
    if (!row) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
    return row.owner
  },
}

/**
 * Forget a finished image build and rerun it. `false` when the feed does
 * not list the id (unknown or dismissed) or it is still running.
 */
export async function retryImageBuild(principal: Actor, id: string): Promise<boolean> {
  if (!await authorizedImageBuild(principal, id)) return false
  return workspaceDriver().retryImageBuild(id, projectReaders)
}

/** Hide a finished build from the feed. Idempotent for an id it does not
 *  list. */
export async function dismissImageBuild(principal: Actor, id: string): Promise<void> {
  if (await authorizedImageBuild(principal, id)) workspaceDriver().dismissImageBuild(id)
}
