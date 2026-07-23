import fs from 'node:fs/promises'
import path from 'node:path'
import { getProjectsDir } from '@yaac/shared/project-paths'
import { listSessionPods, isPrewarmed } from '#platform/k8s/pods'
import {
  isDeferredClusterBootPending,
  triggerDeferredClusterBoot,
} from '#platform/k8s/deferred-boot'
import type { ProjectMeta } from '@yaac/shared/types'

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
  if (isDeferredClusterBootPending()) {
    // A nested server whose deferred cluster attach hasn't finished has
    // no session pods by construction, so every count is 0 — answer
    // instantly instead of holding the first snapshot (and with it the
    // web-app's project list) on a kubectl call to a still-waking
    // vcluster. Kick the attach so the caches come up and push a fresh
    // snapshot with real counts.
    triggerDeferredClusterBoot()
    return counts
  }
  try {
    const pods = await listSessionPods()
    for (const p of pods) {
      if (isPrewarmed(p)) continue // spares aren't user sessions
      if (p.projectSlug) counts[p.projectSlug] = (counts[p.projectSlug] ?? 0) + 1
    }
  } catch {
    // cluster not available — leave counts empty
  }
  return counts
}
