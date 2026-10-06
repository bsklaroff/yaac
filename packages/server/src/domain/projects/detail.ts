import { projectConfigDir } from '@yaac/shared/project-paths'
import { getProjectRow, listProjectRows } from '#db'
import { workspaceDriver } from '#drivers/driver'
import { loadProjectConfig } from './config'
import { ServerError } from '@yaac/shared/errors'
import type { ProjectMeta, YaacConfig } from '@yaac/shared/types'

export interface ProjectDetail {
  id: string
  name: string
  remoteUrl: string
  addedAt: string
  workspaceCount: number
}

export interface ProjectConfigResult {
  config: YaacConfig | null
}

async function loadProjectMeta(projectId: string): Promise<ProjectMeta> {
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

/** The shortest id prefix accepted, so a short or hex-only name that
 *  names no project is not taken for another project's id. */
const MIN_ID_PREFIX = 8

/**
 * Resolve what a client typed for a project to its id: a full id, then a
 * name, then a unique id prefix of at least `MIN_ID_PREFIX` characters.
 * Names are not unique, so a name shared by several projects is an error
 * listing them. Throws `NOT_FOUND` when nothing matches.
 */
export async function resolveProjectId(ref: string): Promise<string> {
  const wanted = ref.trim().toLowerCase()
  if (wanted === '') throw new ServerError('VALIDATION', 'a project is required')
  const rows = await listProjectRows()
  if (rows.some((r) => r.id === wanted)) return wanted
  const named = rows.filter((r) => r.name === wanted)
  const matches = named.length > 0 || wanted.length < MIN_ID_PREFIX
    ? named
    : rows.filter((r) => r.id.startsWith(wanted))
  if (matches.length === 1) return matches[0].id
  if (matches.length === 0) throw new ServerError('NOT_FOUND', `project ${ref.trim()} not found`)
  throw new ServerError(
    'VALIDATION',
    `"${ref.trim()}" matches more than one project — use its id: `
    + matches.map((r) => `${r.name} (${r.id})`).join(', '),
  )
}

/**
 * The project's remote URL from its row: the only source the server uses to
 * fetch or pick a credential, since pods can write the clone's own
 * `remote.origin.url`.
 */
export async function projectRemoteUrl(projectId: string): Promise<string> {
  return (await loadProjectMeta(projectId)).remoteUrl
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
    workspaceCount: workspaceCount[projectId] ?? 0,
  }
}
