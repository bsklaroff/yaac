import { posix } from 'node:path'
import { repoDir } from '@yaac/shared/project-paths'
import { applyWorkspaceEvent, findWorkspaceRow, forgetWorkspaceScratchDirs, getProjectRow, listWorkspaceRepos, setProjectScratchDirs } from '#db'
import { authorizeProject, type Actor } from '#domain/access'
import { ServerError } from '@yaac/shared/errors'
import { getDefaultBranch, listTrackedPaths } from '#domain/git'
import { errorText, serverLog } from '#lib/log'
import { FULL_COMMIT_PATTERN } from '@yaac/shared/steps'

/**
 * Record which of a starting workspace's scratch dirs git tracks, in each
 * checkout: at its base branch (or the commit it was created at) or at the
 * workspace's own branch once pushed, as the main clone has them after the
 * start's fetch. Those paths' tracked files show as deleted in the
 * workspace, which the webapp warns about. The server never runs git on the
 * checkout itself, so the workspace's unpushed commits are not seen.
 * `dirs` are relative to each checkout; what is recorded is relative to
 * the workspace root. Best-effort: a failure, such as a base branch origin
 * no longer has, leaves what the last start found.
 */
export async function recordTrackedScratchDirs(
  projectId: string,
  workspaceId: string,
  checkouts: Array<{ repoId: string; path: string; base: string | undefined }>,
  dirs: string[],
): Promise<void> {
  try {
    const tracked = await Promise.all(checkouts.map(async ({ repoId, path, base }) => {
      const repo = repoDir(repoId)
      const ref = base !== undefined && FULL_COMMIT_PATTERN.test(base)
        ? base
        : `refs/remotes/origin/${base ?? await getDefaultBranch(repo)}`
      const found = new Set([
        ...await listTrackedPaths(repo, ref, dirs),
        // Absent until the workspace pushes its branch.
        ...await listTrackedPaths(repo, `refs/remotes/origin/agent/${workspaceId}`, dirs).catch(() => []),
      ])
      return dirs.filter((d) => found.has(d)).map((d) => posix.join(path, d))
    }))
    await applyWorkspaceEvent({ type: 'tracked-scratch-dirs-found', projectId, workspaceId, paths: tracked.flat() })
  } catch (err) {
    serverLog(`[workspace] reading tracked scratch dirs of ${workspaceId} failed: ${errorText(err)}`)
  }
}

/**
 * Keep `paths` in a workspace's checkouts from now on. Each is relative to
 * the workspace dir, as its tracked scratch dirs are listed; the project
 * setting it comes from is relative to every checkout, so that dir comes
 * off the project's scratch dirs, and off the ones the workspace was
 * started with in each of its checkouts, so the stop of the restart that
 * follows leaves what git tracks there.
 */
export async function keepScratchDirsInCheckout(principal: Actor, workspaceId: string, paths: string[]): Promise<void> {
  const row = await findWorkspaceRow(workspaceId)
  if (!row) throw new ServerError('NOT_FOUND', `workspace ${workspaceId} not found`)
  const { projectId } = row
  await authorizeProject(principal, projectId)
  const checkouts = (await listWorkspaceRepos(workspaceId)).map((r) => r.path)
  const kept = new Set(paths.map((p) => {
    const checkout = checkouts.find((c) => c !== '' && p.startsWith(`${c}/`)) ?? ''
    return posix.relative(checkout, p)
  }))
  const dirs = (await getProjectRow(projectId))?.scratchDirs.dirs ?? []
  await setProjectScratchDirs(projectId, { dirs: dirs.filter((d) => !kept.has(d.path)) })
  await forgetWorkspaceScratchDirs(projectId, workspaceId, checkouts.flatMap((c) => [...kept].map((d) => posix.join(c, d))))
}
