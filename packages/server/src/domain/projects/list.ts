import { countStoppedWorkspaces, listProjectIconHashes, listProjectRows, listRepos, type StoppedCount } from '#db'
import { workspaceDriver } from '#drivers/driver'
import { repoCredentialNames } from '#domain/repos'
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
  const [rows, workspaceCounts, stoppedCounts, iconHashes, repos] = await Promise.all([
    listProjectRows(),
    workspaceDriver().count(),
    counts,
    listProjectIconHashes(),
    listRepos(),
  ])
  const repoOf = new Map(repos.map((r) => [r.id, r]))
  // A fork's upstream is its owner's alone, so only their projects see it.
  const upstreamFor = (repoId: string | null, owner: string): { id: string; remoteUrl: string } | undefined => {
    const up = repoId === null ? undefined : repoOf.get(repoId)
    return up !== undefined && up.owner === owner && up.deletedAt === undefined ? { id: up.id, remoteUrl: up.remoteUrl } : undefined
  }
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
  const credentials = await repoCredentialNames(rows.flatMap((r) => r.repos.map((l) => l.repo)))
  return rows.map((meta) => ({
    id: meta.id,
    name: meta.name,
    addedAt: meta.addedAt,
    owner: meta.owner,
    ...(iconHashes.has(meta.id) ? { iconHash: iconHashes.get(meta.id) } : {}),
    workspaceCount: workspaceCounts[meta.id] ?? 0,
    ...stoppedIn(meta.id),
    // Remembered create defaults, so the create form opens on what an
    // untouched create would run (see `resolveToolCreateDefaults`).
    ...(meta.lastTool !== undefined ? { lastTool: meta.lastTool } : {}),
    ...(meta.defaultImageId !== undefined ? { defaultImageId: meta.defaultImageId } : {}),
    ...(meta.lastImageId !== undefined ? { lastImageId: meta.lastImageId } : {}),
    ...(meta.imageCacheDays !== undefined ? { imageCacheDays: meta.imageCacheDays } : {}),
    createDefaults: meta.createDefaults,
    repos: meta.repos.map((l) => {
      const upstream = upstreamFor(l.repo.upstreamRepoId, meta.owner)
      return {
        id: l.repo.id,
        dir: l.dir,
        remoteUrl: l.repo.remoteUrl,
        owner: l.repo.owner,
        hosted: l.repo.hosted,
        guardDefaultBranch: l.repo.guardDefaultBranch,
        ...(l.repo.keepsHostedRepo ? { keepsHostedRepo: true as const } : {}),
        gitCredential: credentials.get(l.repo.id) ?? null,
        readOnly: l.readOnly,
        repoReadOnly: l.repo.readOnly,
        ...(l.repo.pushAccess === 'no' && !l.repo.readOnly && !l.repo.hosted ? { pushRefused: true as const } : {}),
        ...(upstream !== undefined ? { upstream } : {}),
        guardAllowsCatchUp: l.repo.guardAllowsCatchUp,
        ghToken: l.ghToken,
        lastIncluded: l.lastIncluded,
        ...(l.lastBranch !== undefined ? { lastBranch: l.lastBranch } : {}),
      }
    }),
    ...(meta.lastNested !== undefined ? { lastNested: meta.lastNested } : {}),
    ...(meta.lastCwd !== undefined ? { lastCwd: meta.lastCwd } : {}),
    ...(meta.stoppedWorkspaceRetentionDays !== undefined
      ? { stoppedWorkspaceRetentionDays: meta.stoppedWorkspaceRetentionDays } : {}),
    ...(meta.keptIgnoredPaths.length > 0 ? { keptIgnoredPaths: meta.keptIgnoredPaths } : {}),
    scratchDirs: meta.scratchDirs,
    portForwards: meta.portForwards,
    cacheVolumes: meta.cacheVolumes,
    npmCache: meta.npmCache,
  }))
}
