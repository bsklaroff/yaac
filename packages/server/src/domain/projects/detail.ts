import { hostedRepoDir, projectConfigDir } from '@yaac/shared/project-paths'
import { getProjectRow, listProjectRows } from '#db'
import { workspaceDriver } from '#drivers/driver'
import { loadProjectConfig } from './config'
import { ServerError } from '@yaac/shared/errors'
import { resolveProjectRef } from '@yaac/shared/project-name'
import type { ProjectMeta, YaacConfig } from '@yaac/shared/types'

export interface ProjectDetail {
  id: string
  name: string
  remoteUrl: string
  addedAt: string
  hosted: boolean
  workspaceCount: number
}

export interface ProjectConfigResult {
  config: YaacConfig | null
}

async function loadProjectMeta(projectId: string): Promise<ProjectMeta & { hosted: boolean; sharedFrom?: string; shareRevoked: boolean }> {
  const meta = await getProjectRow(projectId)
  if (!meta) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  return meta
}

/**
 * Existence check that doesn't parse `yaac-config.json`, so a malformed
 * config can still be opened for editing.
 */
export async function assertProjectExists(projectId: string): Promise<void> {
  await loadProjectMeta(projectId)
}

/** Resolve what a client typed for a project, among every user's, to its
 *  id (`resolveProjectRef`). */
export async function resolveProjectId(ref: string): Promise<string> {
  return resolveProjectRef(await listProjectRows(), ref)
}

/**
 * The project's remote URL from its row: the only source the server uses to
 * fetch or pick a credential, since pods can write the clone's own
 * `remote.origin.url`.
 */
export async function projectRemoteUrl(projectId: string): Promise<string> {
  return (await loadProjectMeta(projectId)).remoteUrl
}

/** Where the server's own git fetches the project from: the row's URL, or
 *  for a hosted project the bare repository on disk, which a share takes
 *  from the project it was shared from. A removed share fetches nothing,
 *  so its main clone keeps what it had. */
export async function projectFetchUrl(projectId: string): Promise<string> {
  const meta = await loadProjectMeta(projectId)
  if (meta.shareRevoked) throw new ServerError('FORBIDDEN', `${meta.name} is no longer shared with its owner`)
  return meta.hosted ? hostedRepoDir(meta.sharedFrom ?? projectId) : meta.remoteUrl
}

/**
 * The project's config from its config directory, like
 * `resolveProjectConfig` but throwing NOT_FOUND for an unknown project.
 */
export async function resolveProjectConfigWithSource(projectId: string): Promise<ProjectConfigResult> {
  await loadProjectMeta(projectId)
  return { config: await loadProjectConfig(projectConfigDir(projectId)) }
}

/**
 * The project's row and live workspace count. Leaves the config to
 * `GET /project/:projectId/config`, so a malformed one never stops a client
 * resolving the project, e.g. to repair that config.
 */
export async function getProjectDetail(projectId: string): Promise<ProjectDetail> {
  const meta = await loadProjectMeta(projectId)
  const workspaceCount = await workspaceDriver().count()
  return {
    id: meta.id,
    name: meta.name,
    remoteUrl: meta.remoteUrl,
    addedAt: meta.addedAt,
    hosted: meta.hosted,
    workspaceCount: workspaceCount[projectId] ?? 0,
  }
}
