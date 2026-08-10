import { projectConfigDir } from '@yaac/shared/project-paths'
import { getProjectRow } from '#records'
import { countProjectWorkspaces } from '#runtime/k8s/worktrees'
import { loadProjectConfig } from '#store/projects'
import { ServerError } from '@yaac/shared/errors'
import type { ProjectMeta, YaacConfig } from '@yaac/shared/types'

export interface ProjectDetail {
  slug: string
  remoteUrl: string
  addedAt: string
  worktreeCount: number
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
 * Cheap existence check that doesn't parse `yaac-config.json`. Used by
 * `config edit` so a malformed config doesn't block opening the editor
 * to fix it — exactly when you need to edit it most.
 */
export async function assertProjectExists(slug: string): Promise<void> {
  await loadProjectMeta(slug)
}

/**
 * Resolve the project's config from the per-machine config directory.
 * Mirrors `resolveProjectConfig` but throws NOT_FOUND when the project
 * itself is unknown (the server route relies on this).
 */
export async function resolveProjectConfigWithSource(slug: string): Promise<ProjectConfigResult> {
  await loadProjectMeta(slug)
  return { config: await loadProjectConfig(projectConfigDir(slug)) }
}

export async function getProjectDetail(slug: string): Promise<ProjectDetail> {
  const meta = await loadProjectMeta(slug)
  const [worktreeCount, configResult] = await Promise.all([
    countProjectWorkspaces(slug),
    resolveProjectConfigWithSource(slug),
  ])
  return {
    slug: meta.slug,
    remoteUrl: meta.remoteUrl,
    addedAt: meta.addedAt,
    worktreeCount,
    config: configResult.config,
  }
}
