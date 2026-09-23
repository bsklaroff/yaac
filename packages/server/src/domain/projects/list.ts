import { listProjectRows } from '#db'
import { worktreeDriver } from '#drivers/driver'
import type { ProjectSummary } from '@yaac/shared/types'

/**
 * Every recorded project, with a live worktree count. If the substrate is
 * unavailable we still return the projects — just with `worktreeCount: 0`:
 * which projects exist is the server's own record, and only the count needs
 * a substrate.
 *
 * This is the pure data half of `yaac project list`; the CLI renderer
 * lives in `src/commands/project-list.ts`.
 */
export async function listProjects(): Promise<ProjectSummary[]> {
  const [rows, worktreeCounts] = await Promise.all([
    listProjectRows(),
    worktreeDriver().count(),
  ])
  return rows.map((meta) => ({
    slug: meta.slug,
    remoteUrl: meta.remoteUrl,
    addedAt: meta.addedAt,
    worktreeCount: worktreeCounts[meta.slug] ?? 0,
    // The create form's memory, so it opens on what an untouched create
    // would run (see `resolveToolCreateDefaults`).
    ...(meta.lastTool !== undefined ? { lastTool: meta.lastTool } : {}),
    createDefaults: meta.createDefaults,
  }))
}
