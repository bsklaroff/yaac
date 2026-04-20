import fs from 'node:fs/promises'
import path from 'node:path'
import { getDataDir, getProjectsDir } from '@/lib/project/paths'
import { podman } from '@/lib/container/runtime'
import type { ProjectMeta } from '@/shared/types'

export interface ProjectListEntry {
  slug: string
  remoteUrl: string
  addedAt: string
  sessionCount: number
}

/**
 * Scan every `project.json` under `~/.yaac/projects/` and count live
 * sessions by label. If Podman is unavailable we still return the
 * projects — just with `sessionCount: 0`. Same behavior as the old
 * in-process `projectList()` command.
 *
 * This is the pure data half of `yaac project list`; the CLI renderer
 * lives in `src/commands/project-list.ts`.
 */
export async function listProjects(): Promise<ProjectListEntry[]> {
  const projectsDir = getProjectsDir()

  let entries: string[]
  try {
    entries = await fs.readdir(projectsDir)
  } catch {
    return []
  }

  const containerCounts = await countSessionsByProject()

  const projects: ProjectListEntry[] = []
  for (const entry of entries) {
    const metaPath = path.join(projectsDir, entry, 'project.json')
    try {
      const raw = await fs.readFile(metaPath, 'utf8')
      const meta = JSON.parse(raw) as ProjectMeta
      projects.push({
        slug: meta.slug,
        remoteUrl: meta.remoteUrl,
        addedAt: meta.addedAt,
        sessionCount: containerCounts[meta.slug] ?? 0,
      })
    } catch {
      // skip malformed entries
    }
  }

  return projects
}

async function countSessionsByProject(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  try {
    const containers = await podman.listContainers({
      all: true,
      filters: { label: [`yaac.data-dir=${getDataDir()}`] },
    })
    for (const c of containers) {
      const proj = c.Labels?.['yaac.project']
      if (proj) counts[proj] = (counts[proj] ?? 0) + 1
    }
  } catch {
    // podman not available — leave counts empty
  }
  return counts
}
