import { listProjectRows } from '#features/records'
import { countWorkspaces } from '#runtime/k8s/worktrees'

export interface ProjectListEntry {
  slug: string
  remoteUrl: string
  addedAt: string
  worktreeCount: number
}

/**
 * Every recorded project, with a live worktree count. If the substrate is
 * unavailable we still return the projects — just with `worktreeCount: 0`:
 * which projects exist is the server's own record, and only the count needs
 * a substrate.
 *
 * This is the pure data half of `yaac project list`; the CLI renderer
 * lives in `src/commands/project-list.ts`.
 */
export async function listProjects(): Promise<ProjectListEntry[]> {
  const [rows, worktreeCounts] = await Promise.all([
    listProjectRows(),
    countWorkspaces(),
  ])
  return rows.map((meta) => ({
    slug: meta.slug,
    remoteUrl: meta.remoteUrl,
    addedAt: meta.addedAt,
    worktreeCount: worktreeCounts[meta.slug] ?? 0,
  }))
}
