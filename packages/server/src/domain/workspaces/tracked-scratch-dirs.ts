import { repoDir } from '@yaac/shared/project-paths'
import { applyWorkspaceEvent, findWorkspaceRow, forgetWorkspaceScratchDirs, getProjectRow, setProjectScratchDirs } from '#db'
import { authorizeProject, type Actor } from '#domain/access'
import { ServerError } from '@yaac/shared/errors'
import { getDefaultBranch, listTrackedPaths } from '#domain/git'
import { errorText, serverLog } from '#lib/log'

/**
 * Record which of a starting workspace's scratch dirs git tracks, at its
 * base branch or at its own branch once pushed, as the main clone has them
 * after the start's fetch. Those paths' tracked files show as deleted in the
 * workspace, which the webapp warns about. The server never runs git on the
 * checkout itself, so the workspace's unpushed commits are not seen.
 * Best-effort: a failure, such as a base branch origin no longer has,
 * leaves what the last start found.
 */
export async function recordTrackedScratchDirs(
  projectId: string,
  workspaceId: string,
  baseBranch: string | undefined,
  paths: string[],
): Promise<void> {
  try {
    const repo = repoDir(projectId)
    const base = baseBranch ?? await getDefaultBranch(repo)
    const found = new Set([
      ...await listTrackedPaths(repo, `refs/remotes/origin/${base}`, paths),
      // Absent until the workspace pushes its branch.
      ...await listTrackedPaths(repo, `refs/remotes/origin/agent/${workspaceId}`, paths).catch(() => []),
    ])
    await applyWorkspaceEvent({
      type: 'tracked-scratch-dirs-found',
      projectId,
      workspaceId,
      paths: paths.filter((p) => found.has(p)),
    })
  } catch (err) {
    serverLog(`[workspace] reading tracked scratch dirs of ${workspaceId} failed: ${errorText(err)}`)
  }
}

/**
 * Keep `paths` in a workspace's checkout from now on: take them off its
 * project's scratch dirs, and off the ones the workspace was started with,
 * so the stop of the restart that follows leaves what git tracks there.
 */
export async function keepScratchDirsInCheckout(principal: Actor, workspaceId: string, paths: string[]): Promise<void> {
  const row = await findWorkspaceRow(workspaceId)
  if (!row) throw new ServerError('NOT_FOUND', `workspace ${workspaceId} not found`)
  const { projectId } = row
  await authorizeProject(principal, projectId)
  const dirs = (await getProjectRow(projectId))?.scratchDirs.dirs ?? []
  await setProjectScratchDirs(projectId, { dirs: dirs.filter((d) => !paths.includes(d.path)) })
  await forgetWorkspaceScratchDirs(projectId, workspaceId, paths)
}
