import { countStoppedWorkspaces, listProjectRows, type StoppedCount } from '#db'
import { workspaceDriver } from '#drivers/driver'
import { projectCredentialNames } from './credentials'
import type { ProjectSummary } from '@yaac/shared/types'

/**
 * Every recorded project, with a live workspace count from the runtime and
 * the recorded stopped count. The data behind `yaac project list` (rendered
 * by packages/cli/src/commands/project-list.ts). The snapshot passes in the
 * stopped counts it shares with `listWorkspaceGroups`, so that query runs
 * once.
 */
export async function listProjects(
  counts: Promise<StoppedCount[]> = countStoppedWorkspaces(),
): Promise<ProjectSummary[]> {
  const [rows, workspaceCounts, stoppedCounts] = await Promise.all([
    listProjectRows(),
    workspaceDriver().count(),
    counts,
  ])
  const stoppedIn = (projectId: string, field: 'stopped' | 'unseenDeaths'): number =>
    stoppedCounts.filter((c) => c.projectId === projectId).reduce((n, c) => n + c[field], 0)
  const credentials = await projectCredentialNames(rows)
  return rows.map((meta) => ({
    id: meta.id,
    name: meta.name,
    remoteUrl: meta.remoteUrl,
    addedAt: meta.addedAt,
    owner: meta.owner,
    workspaceCount: workspaceCounts[meta.id] ?? 0,
    stoppedCount: stoppedIn(meta.id, 'stopped'),
    unseenDeaths: stoppedIn(meta.id, 'unseenDeaths'),
    // Remembered create defaults, so the create form opens on what an
    // untouched create would run (see `resolveToolCreateDefaults`).
    ...(meta.lastTool !== undefined ? { lastTool: meta.lastTool } : {}),
    ...(meta.lastBranch !== undefined ? { lastBranch: meta.lastBranch } : {}),
    createDefaults: meta.createDefaults,
    gitCredential: credentials.get(meta.id) ?? null,
  }))
}
