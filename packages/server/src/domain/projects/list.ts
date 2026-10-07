import { listProjectRows } from '#db'
import { workspaceDriver } from '#drivers/driver'
import { projectCredentialNames } from './credentials'
import type { ProjectSummary } from '@yaac/shared/types'

/**
 * Every recorded project, with a live workspace count from the runtime.
 * The data behind `yaac project list` (rendered by
 * packages/cli/src/commands/project-list.ts).
 */
export async function listProjects(): Promise<ProjectSummary[]> {
  const [rows, workspaceCounts] = await Promise.all([
    listProjectRows(),
    workspaceDriver().count(),
  ])
  const credentials = await projectCredentialNames(rows)
  return rows.map((meta) => ({
    id: meta.id,
    name: meta.name,
    remoteUrl: meta.remoteUrl,
    addedAt: meta.addedAt,
    owner: meta.owner,
    workspaceCount: workspaceCounts[meta.id] ?? 0,
    // Remembered create defaults, so the create form opens on what an
    // untouched create would run (see `resolveToolCreateDefaults`).
    ...(meta.lastTool !== undefined ? { lastTool: meta.lastTool } : {}),
    ...(meta.lastBranch !== undefined ? { lastBranch: meta.lastBranch } : {}),
    createDefaults: meta.createDefaults,
    gitCredential: credentials.get(meta.id) ?? null,
  }))
}
