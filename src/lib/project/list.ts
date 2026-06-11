import fs from 'node:fs/promises'
import path from 'node:path'
import { getProjectsDir } from '@/lib/project/paths'
import { listSessionPods } from '@/lib/k8s/pods'
import type { ProjectMeta } from '@/shared/types'

export interface ProjectListEntry {
  slug: string
  remoteUrl: string
  addedAt: string
  sessionCount: number
}

/**
 * Scan every `project.json` under `~/.yaac/projects/` and count live
 * sessions by pod label. If the cluster is unavailable we still return
 * the projects — just with `sessionCount: 0`. Same behavior as the old
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

  const sessionCounts = await countSessionsByProject()

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
        sessionCount: sessionCounts[meta.slug] ?? 0,
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
    const pods = await listSessionPods()
    for (const p of pods) {
      if (p.projectSlug) counts[p.projectSlug] = (counts[p.projectSlug] ?? 0) + 1
    }
  } catch {
    // cluster not available — leave counts empty
  }
  return counts
}
