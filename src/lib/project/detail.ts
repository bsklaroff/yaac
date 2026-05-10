import fs from 'node:fs/promises'
import path from 'node:path'
import { getDataDir, projectDir, projectConfigDir } from '@/lib/project/paths'
import { podman } from '@/lib/container/runtime'
import { loadProjectConfig } from '@/lib/project/config'
import { DaemonError } from '@/daemon/errors'
import type { ProjectMeta, YaacConfig } from '@/shared/types'

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
    throw new DaemonError('NOT_FOUND', `project ${slug} not found`)
  }
  return JSON.parse(raw) as ProjectMeta
}

/**
 * Resolve the project's config from the per-machine config directory.
 * Mirrors `resolveProjectConfig` but throws NOT_FOUND when the project
 * itself is unknown (the daemon route relies on this).
 */
export async function resolveProjectConfigWithSource(slug: string): Promise<ProjectConfigResult> {
  await loadProjectMeta(slug)
  return { config: await loadProjectConfig(projectConfigDir(slug)) }
}

async function countSessionsForProject(slug: string): Promise<number> {
  try {
    const containers = await podman.listContainers({
      all: true,
      filters: { label: [`yaac.data-dir=${getDataDir()}`, `yaac.project=${slug}`] },
    })
    return containers.length
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
