import { projectConfigDir } from '@yaac/shared/project-paths'
import { getProjectRow } from '#db'
import { workspaceDriver } from '#drivers/driver'
import { loadProjectConfig } from './config'
import { ServerError } from '@yaac/shared/errors'
import type { ProjectMeta, YaacConfig } from '@yaac/shared/types'

export interface ProjectDetail {
  slug: string
  remoteUrl: string
  addedAt: string
  workspaceCount: number
  config: YaacConfig | null
}

export interface ProjectConfigResult {
  config: YaacConfig | null
}

async function loadProjectMeta(slug: string): Promise<ProjectMeta> {
  const meta = await getProjectRow(slug)
  if (!meta) throw new ServerError('NOT_FOUND', `project ${slug} not found`)
  return meta
}

/**
 * Existence check that doesn't parse `yaac-config.json`, so a malformed
 * config can still be opened for editing.
 */
export async function assertProjectExists(slug: string): Promise<void> {
  await loadProjectMeta(slug)
}

/**
 * The project's remote URL from its row: the only source the server uses to
 * fetch or pick a credential, since pods can write the clone's own
 * `remote.origin.url`.
 */
export async function projectRemoteUrl(slug: string): Promise<string> {
  return (await loadProjectMeta(slug)).remoteUrl
}

/**
 * The project's config from its config directory, like
 * `resolveProjectConfig` but throwing NOT_FOUND for an unknown project.
 */
export async function resolveProjectConfigWithSource(slug: string): Promise<ProjectConfigResult> {
  await loadProjectMeta(slug)
  return { config: await loadProjectConfig(projectConfigDir(slug)) }
}

export async function getProjectDetail(slug: string): Promise<ProjectDetail> {
  const meta = await loadProjectMeta(slug)
  const [workspaceCount, configResult] = await Promise.all([
    workspaceDriver().countForProject(slug),
    resolveProjectConfigWithSource(slug),
  ])
  return {
    slug: meta.slug,
    remoteUrl: meta.remoteUrl,
    addedAt: meta.addedAt,
    workspaceCount,
    config: configResult.config,
  }
}
