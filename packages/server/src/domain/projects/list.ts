import { listProjectRows } from '#db'
import { workspaceDriver } from '#drivers/driver'
import { projectCredentialNames } from './credentials'
import type { ProjectSummary } from '@yaac/shared/types'

/**
 * Every recorded project, with a live workspace count. If the substrate is
 * unavailable we still return the projects — just with `workspaceCount: 0`:
 * which projects exist is the server's own record, and only the count needs
 * a substrate.
 *
 * This is the pure data half of `yaac project list`; the CLI renderer
 * lives in `src/commands/project-list.ts`.
 */
export async function listProjects(): Promise<ProjectSummary[]> {
  const [rows, workspaceCounts] = await Promise.all([
    listProjectRows(),
    workspaceDriver().count(),
  ])
  const credentials = await projectCredentialNames(rows)
  return rows.map((meta) => ({
    slug: meta.slug,
    remoteUrl: meta.remoteUrl,
    addedAt: meta.addedAt,
    workspaceCount: workspaceCounts[meta.slug] ?? 0,
    // The create form's memory, so it opens on what an untouched create
    // would run (see `resolveToolCreateDefaults`).
    ...(meta.lastTool !== undefined ? { lastTool: meta.lastTool } : {}),
    ...(meta.lastBranch !== undefined ? { lastBranch: meta.lastBranch } : {}),
    createDefaults: meta.createDefaults,
    gitCredential: credentials.get(meta.slug) ?? null,
  }))
}
