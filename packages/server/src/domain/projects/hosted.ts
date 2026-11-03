import fs from 'node:fs/promises'
import { ServerError } from '@yaac/shared/errors'
import { hostedRepoDir, repoDir } from '@yaac/shared/project-paths'
import { clearProjectKeepsHostedRepo, getProjectRow, listProjectRows, setProjectDefaultBranchGuard, type ProjectRow } from '#db'
import { hostedDefaultBranch, serveGitHttp, setHostedDefaultBranch, setOriginHead } from '#domain/git'
import { isUuid } from '#lib/uuid'
import { authorizeProject, systemPrincipal, type Actor } from '#domain/access'
import { serverLog } from '#lib/log'
import { fetchProjectOrigin } from './origin'

/**
 * The remote of a project the server hosts itself (docs/hosted-projects.md):
 * who may read and push it, its default branch, and the default-branch
 * guard.
 */

/**
 * Who is asking for a hosted remote: a user on the API origin, or a
 * workspace, identified by its yaac-mama token or by the egress proxy.
 */
type HostedRepoCaller =
  | { kind: 'user'; principal: Actor }
  | { kind: 'workspace'; projectId: string }

/**
 * Answer one smart-HTTP request for a hosted project's remote. A workspace
 * may read and push its own project's remote and no other. Any user may
 * read, as with every other resource (docs/multi-user.md); only the owner
 * may push. Nobody pushes to a held project (`withProjectsHeld`), such as
 * one moving to another git host, and once it has moved, the repository
 * yaac kept is read-only. A share reaches the repository of the project it
 * was shared from, and a removed share reaches nothing. A push that lands is fetched
 * into the main clone of every project on the repository at once, which
 * also refreshes `origin/*` in their running workspaces, and the remote's
 * default branch becomes each main clone's `origin/HEAD`.
 */
export async function serveHostedRepo(
  projectId: string,
  request: Request,
  pathInfo: string,
  caller: HostedRepoCaller,
): Promise<Response> {
  const row = isUuid(projectId) ? await getProjectRow(projectId) : undefined
  if (!row) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  if (caller.kind === 'workspace' && caller.projectId !== projectId) {
    throw new ServerError('FORBIDDEN', "a workspace may only reach its own project's repository")
  }
  if (row.shareRevoked) throw new ServerError('FORBIDDEN', `${row.name} is no longer shared with its owner`)
  const push = pathInfo === '/git-receive-pack'
    || new URL(request.url).searchParams.get('service') === 'git-receive-pack'
  if (push) await authorizeProject(caller.kind === 'user' ? caller.principal : systemPrincipal, projectId)
  if (!row.hosted && !row.keepsHostedRepo) throw new ServerError('NOT_FOUND', `project ${row.name} is not hosted by yaac`)
  if (!row.hosted && push) {
    throw new ServerError('FORBIDDEN', `${row.name} moved to ${row.remoteUrl}; yaac's copy of its repository is read-only`)
  }
  const source = row.sharedFrom ?? projectId
  const sourceRow = row.sharedFrom === undefined ? row : await getProjectRow(source)
  return serveGitHttp(hostedRepoDir(source), request, pathInfo, {
    allowPush: push,
    guardDefaultBranch: sourceRow?.guardDefaultBranch ?? true,
    onPushed: () => {
      fetchIntoMainClones(source).catch((err: unknown) => {
        serverLog(`[git] fetching ${source} after a push: ${(err as Error).message}`)
      })
    },
  })
}

/**
 * Fetch the repository of hosted project `source` into the main clone of
 * every project on it (the source and its active shares), which also
 * refreshes `origin/*` in their running workspaces, then make the
 * repository's default branch that clone's `origin/HEAD`, which creates
 * fork from. The default is read after each fetch, so a change of default
 * that lands meanwhile is not overwritten with the old one. A clone that
 * cannot take it is logged and left behind until the next push or change
 * of default, so one stuck share never fails a change the repository has
 * already made.
 */
async function fetchIntoMainClones(source: string): Promise<void> {
  const rows = await listProjectRows()
  await Promise.all(rows
    .filter((r) => r.id === source || (r.sharedFrom === source && !r.shareRevoked))
    .map(async (r) => {
      try {
        await fetchProjectOrigin(r.id)
        const head = await hostedDefaultBranch(hostedRepoDir(source))
        if (head !== null) await setOriginHead(repoDir(r.id), head)
      } catch (err) {
        serverLog(`[git] fetching ${source} into the main clone of ${r.id}: ${(err as Error).message}`)
      }
    }))
}

/**
 * The row of a hosted project whose repository settings (`what`) the
 * principal may change: its owner's, and not a share, whose repository
 * belongs to the project it was shared from.
 */
async function ownHostedRepoRow(principal: Actor, projectId: string, what: string): Promise<ProjectRow> {
  const row = isUuid(projectId) ? await getProjectRow(projectId) : undefined
  if (!row) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  await authorizeProject(principal, projectId)
  if (!row.hosted) {
    throw new ServerError('VALIDATION', `"${row.name}" is not hosted by yaac; set its ${what} at its git host.`)
  }
  if (row.sharedFrom !== undefined) {
    throw new ServerError('VALIDATION', `"${row.name}" was shared with you; only its owner sets its ${what}.`)
  }
  return row
}

/**
 * Make `branch`, which must exist, a hosted project's default branch: the
 * one a clone checks out, creates fork from, and the guard protects. Every
 * main clone on the repository follows before this answers, so the next
 * create in the project or a share of it forks from `branch`; one that
 * cannot is logged rather than failing the change (`fetchIntoMainClones`).
 */
export async function setDefaultBranch(principal: Actor, projectId: string, branch: string): Promise<void> {
  const row = await ownHostedRepoRow(principal, projectId, 'default branch')
  if (!await setHostedDefaultBranch(hostedRepoDir(projectId), branch)) {
    throw new ServerError('VALIDATION', `"${row.name}" has no branch "${branch}".`)
  }
  await fetchIntoMainClones(projectId)
}

/**
 * Turn a hosted project's default-branch guard on or off: while on, a push
 * that deletes the default branch or rewinds it (a force-push that drops
 * commits) is refused. A project hosted elsewhere is protected at its host,
 * and a share by the owner of the project it was shared from.
 */
export async function setDefaultBranchGuard(principal: Actor, projectId: string, enabled: boolean): Promise<void> {
  await ownHostedRepoRow(principal, projectId, 'default-branch guard')
  await setProjectDefaultBranchGuard(projectId, enabled)
}

/**
 * Delete the repository yaac kept when the project moved to another git
 * host (docs/hosted-projects.md "Moving to a git host"), once its owner has
 * checked the new remote has everything. The repository goes before the
 * flag, so a failed delete can be retried.
 */
export async function removeKeptHostedRepo(principal: Actor, projectId: string): Promise<void> {
  const row = isUuid(projectId) ? await getProjectRow(projectId) : undefined
  if (!row) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  await authorizeProject(principal, projectId)
  if (!row.keepsHostedRepo) throw new ServerError('VALIDATION', `yaac keeps no old repository for "${row.name}".`)
  await fs.rm(hostedRepoDir(projectId), { recursive: true, force: true })
  await clearProjectKeepsHostedRepo(projectId)
}
