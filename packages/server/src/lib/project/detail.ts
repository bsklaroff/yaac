import fs from 'node:fs/promises'
import path from 'node:path'
import { projectDir, projectConfigDir } from '@yaac/shared/project-paths'
import { listSessionPods } from '#lib/k8s/pods'
import { loadProjectConfig } from '#lib/project/config'
import { ServerError } from '@yaac/shared/errors'
import type { ProjectMeta, YaacConfig } from '@yaac/shared/types'

export interface ProjectDetail {
  slug: string
  remoteUrl: string
  addedAt: string
  sessionCount: number
  config: YaacConfig | null
}

export interface ProjectConfigResult {
  config: YaacConfig | null
}

async function loadProjectMeta(slug: string): Promise<ProjectMeta> {
  const metaPath = path.join(projectDir(slug), 'project.json')
  let raw: string
  try {
    raw = await fs.readFile(metaPath, 'utf8')
  } catch {
    throw new ServerError('NOT_FOUND', `project ${slug} not found`)
  }
  return JSON.parse(raw) as ProjectMeta
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

async function countSessionsForProject(slug: string): Promise<number> {
  try {
    const pods = await listSessionPods(slug)
    return pods.length
  } catch {
    return 0
  }
}

export async function getProjectDetail(slug: string): Promise<ProjectDetail> {
  const meta = await loadProjectMeta(slug)
  const [sessionCount, configResult] = await Promise.all([
    countSessionsForProject(slug),
    resolveProjectConfigWithSource(slug),
  ])
  return {
    slug: meta.slug,
    remoteUrl: meta.remoteUrl,
    addedAt: meta.addedAt,
    sessionCount,
    config: configResult.config,
  }
}
