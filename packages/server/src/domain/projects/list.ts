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
  const stoppedIn = (projectId: string): Pick<ProjectSummary, 'stoppedCount' | 'deaths' | 'deathsSeenBy'> => {
    const total = { stoppedCount: 0, deaths: 0, deathsSeenBy: {} as Record<string, number> }
    for (const c of stoppedCounts.filter((c) => c.projectId === projectId)) {
      total.stoppedCount += c.stopped
      total.deaths += c.deaths
      for (const [userId, n] of Object.entries(c.deathsSeenBy)) {
        total.deathsSeenBy[userId] = (total.deathsSeenBy[userId] ?? 0) + n
      }
    }
    return total
  }
  const credentials = await projectCredentialNames(rows)
  return rows.map((meta) => ({
    id: meta.id,
    name: meta.name,
    remoteUrl: meta.remoteUrl,
    addedAt: meta.addedAt,
    owner: meta.owner,
    workspaceCount: workspaceCounts[meta.id] ?? 0,
    ...stoppedIn(meta.id),
    // Remembered create defaults, so the create form opens on what an
    // untouched create would run (see `resolveToolCreateDefaults`).
    ...(meta.lastTool !== undefined ? { lastTool: meta.lastTool } : {}),
    ...(meta.lastBranch !== undefined ? { lastBranch: meta.lastBranch } : {}),
    createDefaults: meta.createDefaults,
    gitCredential: credentials.get(meta.id) ?? null,
    hosted: meta.hosted,
    // A share pushes under the guard of the project it was shared from.
    guardDefaultBranch: (rows.find((r) => r.id === meta.sharedFrom) ?? meta).guardDefaultBranch,
    ...(meta.sharedFrom !== undefined ? { sharedFrom: { projectId: meta.sharedFrom, revoked: meta.shareRevoked } } : {}),
  }))
}
