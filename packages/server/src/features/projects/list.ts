import { listProjectRows } from '#features/records'
import { herd } from '#herd'

export interface ProjectListEntry {
  slug: string
  remoteUrl: string
  addedAt: string
  sessionCount: number
}

/**
 * Every recorded project, with a live session count from the herd. If the
 * substrate is unavailable we still return the projects — just with
 * `sessionCount: 0`, which is the whole point of the split: which projects
 * exist is the server's own record, and only the count needs a substrate.
 *
 * This is the pure data half of `yaac project list`; the CLI renderer
 * lives in `src/commands/project-list.ts`.
 */
export async function listProjects(): Promise<ProjectListEntry[]> {
  const [rows, sessionCounts] = await Promise.all([
    listProjectRows(),
    herd().workspaces.counts(),
  ])
  return rows.map((meta) => ({
    slug: meta.slug,
    remoteUrl: meta.remoteUrl,
    addedAt: meta.addedAt,
    sessionCount: sessionCounts[meta.slug] ?? 0,
  }))
}
