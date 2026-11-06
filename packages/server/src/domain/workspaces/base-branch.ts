/**
 * A workspace's base branch (`workspaces.baseBranch`): the branch on origin
 * its changes are compared against (as `origin/<branch>`) and what a
 * workspace queued under it forks from. Set at create, and moved later by
 * the webapp's Commits pane or `yaac-mama set-base`, as when the work is
 * stacked on another PR's branch. The checkout itself is the agent's to
 * rebase.
 */
import { authorizeProject, type Actor } from '#domain/access'
import { remoteBranchExists } from '#domain/git'
import { fetchProjectOrigin } from '#domain/projects'
import { applyWorkspaceEvent, findWorkspaceRow } from '#db'
import { workspaceDriver } from '#drivers/driver'
import { ServerError } from '@yaac/shared/errors'
import { testEnv } from '@yaac/shared/env'
import { buildOriginRefreshExec, isBranchName } from '@yaac/shared/git'
import { repoDir } from '@yaac/shared/project-paths'
import { resolveWorkspaceId } from './resolve'

/** How long after one fetch of origin a base change may start another. */
const FETCH_INTERVAL_MS = 10_000

/**
 * Base a workspace on `branch`, a branch on origin. Only branch names are
 * taken, never revisions like `main~1`. A branch the main clone lacks may
 * have just been pushed, so origin is fetched before it is refused, at most
 * once per `FETCH_INTERVAL_MS`. A running workspace's own `origin/*` is
 * brought up to the main clone's before this returns, so its next changes
 * read finds `origin/<branch>`.
 */
export async function setWorkspaceBase(
  principal: Actor,
  idOrPrefix: string,
  branch: string,
): Promise<{ workspaceId: string; baseBranch: string }> {
  // From the row, so a stopped workspace can be rebased too, and the
  // runtime is never asked before the owner check.
  const row = await findWorkspaceRow(await resolveWorkspaceId(idOrPrefix))
  if (!row) throw new ServerError('NOT_FOUND', `workspace ${idOrPrefix} not found`)
  const { projectId, workspaceId } = row
  await authorizeProject(principal, projectId)
  const name = branch.trim()
  if (name === '') throw new ServerError('VALIDATION', 'a base branch is required')
  if (!isBranchName(name)) throw new ServerError('VALIDATION', `"${name}" is not a branch name`)
  const repo = repoDir(projectId)
  if (!await remoteBranchExists(repo, name)) {
    if (!testEnv.e2eSkipFetch) await fetchProjectOrigin(projectId, { unlessWithinMs: FETCH_INTERVAL_MS })
    if (!await remoteBranchExists(repo, name)) {
      throw new ServerError(
        'VALIDATION',
        `branch "${name}" not found on origin (pushed just now? retry in ${FETCH_INTERVAL_MS / 1000}s)`,
      )
    }
  }
  await applyWorkspaceEvent({ type: 'base-branch-resolved', projectId, workspaceId, baseBranch: name })
  const driver = workspaceDriver()
  const jobName = (await driver.find(workspaceId).catch(() => undefined))?.jobName
  if (jobName !== undefined) {
    await driver.exec(jobName, buildOriginRefreshExec(`${repo}/.git`, driver.workspacePaths(jobName).workspaceDir), { maxAttempts: 1 })
      .catch(() => { /* the next fan-out retries */ })
  }
  return { workspaceId, baseBranch: name }
}
