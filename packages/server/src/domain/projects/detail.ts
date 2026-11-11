import { getProjectRow, listProjectRows, type ProjectRow } from '#db'
import { workspaceDriver } from '#drivers/driver'
import { ServerError } from '@yaac/shared/errors'
import { resolveProjectRef } from '@yaac/shared/project-name'

export interface ProjectDetail {
  id: string
  name: string
  addedAt: string
  /** Its repos, in order: each one's folder and remote. */
  repos: Array<{ id: string; dir: string; remoteUrl: string; hosted: boolean }>
  workspaceCount: number
}

async function loadProjectMeta(projectId: string): Promise<ProjectRow> {
  const meta = await getProjectRow(projectId)
  if (!meta) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  return meta
}

/** Throw NOT_FOUND unless the project exists. */
export async function assertProjectExists(projectId: string): Promise<void> {
  await loadProjectMeta(projectId)
}

/** Resolve what a client typed for a project, among every user's, to its
 *  id (`resolveProjectRef`). */
export async function resolveProjectId(ref: string): Promise<string> {
  return resolveProjectRef(await listProjectRows(), ref)
}

/** The project's row and live workspace count. */
export async function getProjectDetail(projectId: string): Promise<ProjectDetail> {
  const meta = await loadProjectMeta(projectId)
  const workspaceCount = await workspaceDriver().count()
  return {
    id: meta.id,
    name: meta.name,
    addedAt: meta.addedAt,
    repos: meta.repos.map((l) => ({ id: l.repo.id, dir: l.dir, remoteUrl: l.repo.remoteUrl, hosted: l.repo.hosted })),
    workspaceCount: workspaceCount[projectId] ?? 0,
  }
}
