import fs from 'node:fs/promises'
import path from 'node:path'
import { getDataDir, projectDir, configOverrideDir, repoDir } from '@/lib/project/paths'
import { podman } from '@/lib/container/runtime'
import { loadProjectConfig, loadProjectConfigFromRef } from '@/lib/project/config'
import { getDefaultBranch } from '@/lib/git'
import { DaemonError } from '@/daemon/errors'
import type { ProjectMeta, YaacConfig } from '@/shared/types'

export interface ProjectDetail {
  slug: string
  remoteUrl: string
  addedAt: string
  sessionCount: number
  config: YaacConfig | null
  configSource: 'repo' | 'override' | null
}

export interface ProjectConfigWithSource {
  config: YaacConfig | null
  source: 'repo' | 'override' | null
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
 * Same resolution order as `resolveProjectConfig`, but also records which
 * layer the returned config came from so callers can distinguish a repo-level
 * config from a user-supplied override.
 */
export async function resolveProjectConfigWithSource(slug: string): Promise<ProjectConfigWithSource> {
  await loadProjectMeta(slug)

  const override = await loadProjectConfig(configOverrideDir(slug))
  if (override) return { config: override, source: 'override' }

  const repo = repoDir(slug)
  try {
    const defaultBranch = await getDefaultBranch(repo)
    const fromRef = await loadProjectConfigFromRef(repo, `origin/${defaultBranch}`)
    if (fromRef) return { config: fromRef, source: 'repo' }
  } catch {
    // git not available or repo not initialized — fall through to filesystem
  }

  const fromDisk = await loadProjectConfig(repo)
  if (fromDisk) return { config: fromDisk, source: 'repo' }
  return { config: null, source: null }
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
    configSource: configResult.source,
  }
}
