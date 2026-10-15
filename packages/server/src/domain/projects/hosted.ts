import { ServerError } from '@yaac/shared/errors'
import { hostedRepoDir, repoDir } from '@yaac/shared/project-paths'
import { getProjectRow, listProjectRows, setProjectDefaultBranchGuard } from '#db'
import { serveGitHttp, setOriginHead } from '#domain/git'
import { isUuid } from '#lib/uuid'
import { authorizeProject, type Actor } from '#domain/access'
import { serverLog } from '#lib/log'
import { fetchProjectOrigin } from './origin'

/**
 * The remote of a project the server hosts itself (docs/hosted-projects.md):
 * who may read and push it, and the default-branch guard.
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
 * may push. A share reaches the repository of the project it was shared
 * from, and a removed share reaches nothing. A push that lands is fetched
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
  if (push && caller.kind === 'user') await authorizeProject(caller.principal, projectId)
  if (!row.hosted) throw new ServerError('NOT_FOUND', `project ${row.name} is not hosted by yaac`)
  const source = row.sharedFrom ?? projectId
  const sourceRow = row.sharedFrom === undefined ? row : await getProjectRow(source)
  return serveGitHttp(hostedRepoDir(source), request, pathInfo, {
    allowPush: push,
    guardDefaultBranch: sourceRow?.guardDefaultBranch ?? true,
    onPushed: (defaultBranch) => {
      listProjectRows().then((rows) => Promise.all(rows
        .filter((r) => r.id === source || (r.sharedFrom === source && !r.shareRevoked))
        .map(async (r) => {
          await fetchProjectOrigin(r.id)
          if (defaultBranch !== null) await setOriginHead(repoDir(r.id), defaultBranch)
        }))).catch((err: unknown) => {
        serverLog(`[git] fetching ${source} after a push: ${(err as Error).message}`)
      })
    },
  })
}

/**
 * Turn a hosted project's default-branch guard on or off: while on, a push
 * that deletes the default branch or rewinds it (a force-push that drops
 * commits) is refused. A project hosted elsewhere is protected at its host,
 * and a share by the owner of the project it was shared from.
 */
export async function setDefaultBranchGuard(principal: Actor, projectId: string, enabled: boolean): Promise<void> {
  const row = isUuid(projectId) ? await getProjectRow(projectId) : undefined
  if (!row) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  await authorizeProject(principal, projectId)
  if (!row.hosted) {
    throw new ServerError('VALIDATION', `"${row.name}" is not hosted by yaac; protect its branches at its git host.`)
  }
  if (row.sharedFrom !== undefined) {
    throw new ServerError('VALIDATION', `"${row.name}" was shared with you; only its owner sets its default-branch guard.`)
  }
  await setProjectDefaultBranchGuard(projectId, enabled)
}
