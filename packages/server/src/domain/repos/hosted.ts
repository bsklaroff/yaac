import fs from 'node:fs/promises'
import { ServerError } from '@yaac/shared/errors'
import { hostedRepoDir, repoDir } from '@yaac/shared/project-paths'
import {
  clearRepoKeepsHostedRepo,
  getProjectRow,
  getRepo,
  setRepoDefaultBranchGuard,
  type RepoRow,
} from '#db'
import { hostedDefaultBranch, serveGitHttp, setHostedDefaultBranch, setOriginHead } from '#domain/git'
import { isUuid } from '#lib/uuid'
import { authorizeProject, systemPrincipal, type Actor } from '#domain/access'
import { serverLog } from '#lib/log'
import { fetchRepoOrigin } from './origin'
import { canUseRepo, ownRepo } from './access'

/**
 * The remote of a repo the server hosts itself (docs/hosted-projects.md):
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

/** Repos nobody may push to while a verb runs that a push would race, with
 *  why (`withRepoHeld`). */
const holds = new Map<string, string>()

/** Run `fn` while every push to the repo is refused as CONFLICT with
 *  `reason`. */
export async function withRepoHeld<T>(repoId: string, reason: string, fn: () => Promise<T>): Promise<T> {
  if (holds.has(repoId)) throw new ServerError('CONFLICT', holds.get(repoId) as string)
  holds.set(repoId, reason)
  try {
    return await fn()
  } finally {
    holds.delete(repoId)
  }
}

/**
 * The repo a hosted URL's id names. An id that is no repo's but a
 * project's names that project's one hosted repo: the checkouts of a
 * project that was a share before repos were shared carry such a URL until
 * their workspace restarts (docs/legacy-compat-shims.md "Hosted URLs naming
 * a share"). A deleted repo's id names nothing, even where a project
 * shares the id.
 */
async function hostedRepo(id: string): Promise<RepoRow> {
  if (isUuid(id)) {
    const repo = await getRepo(id)
    if (repo?.deletedAt === undefined) {
      if (repo) return repo
      const hosted = (await getProjectRow(id))?.repos.filter((l) => l.repo.hosted) ?? []
      if (hosted.length === 1) return hosted[0].repo
    }
  }
  throw new ServerError('NOT_FOUND', `repo ${id} not found`)
}

/**
 * Answer one smart-HTTP request for a hosted repo's remote. A workspace
 * may read and push the repos its project links and no other, and may not
 * push one its project links read-only. Any user may read, as with every
 * other resource (docs/multi-user.md); the owner and the users it is shared
 * with may push. Nobody pushes to a held repo (`withRepoHeld`) or from a
 * held project, such as one moving to another git host, and once the repo
 * has moved, the repository yaac kept is read-only. A push that lands is
 * fetched into the main clone at once, which also refreshes `origin/*` in
 * the running workspaces that have a checkout, and the remote's default
 * branch becomes the main clone's `origin/HEAD`.
 */
export async function serveHostedRepo(
  id: string,
  request: Request,
  pathInfo: string,
  caller: HostedRepoCaller,
): Promise<Response> {
  const repo = await hostedRepo(id)
  const push = pathInfo === '/git-receive-pack'
    || new URL(request.url).searchParams.get('service') === 'git-receive-pack'
  if (caller.kind === 'workspace') {
    const project = await getProjectRow(caller.projectId)
    const link = project?.repos.find((l) => l.repo.id === repo.id)
    if (!project || !link || !await canUseRepo(project.owner, repo)) {
      throw new ServerError('FORBIDDEN', 'a workspace may only reach the repos its project links')
    }
    if (push) {
      await authorizeProject(systemPrincipal, caller.projectId)
      if (link.readOnly) throw new ServerError('FORBIDDEN', `${link.dir} is read-only in this project`)
    }
  } else if (push && caller.principal.kind !== 'system' && !await canUseRepo(caller.principal.userId, repo)) {
    throw new ServerError('FORBIDDEN', 'only the owner of this repo, or a user it is shared with, may push to it')
  }
  if (push && holds.has(repo.id)) throw new ServerError('CONFLICT', holds.get(repo.id) as string)
  if (!repo.hosted && !repo.keepsHostedRepo) throw new ServerError('NOT_FOUND', `${repo.remoteUrl} is not hosted by yaac`)
  if (!repo.hosted && push) {
    throw new ServerError('FORBIDDEN', `the repo moved to ${repo.remoteUrl}; yaac's copy of it is read-only`)
  }
  return serveGitHttp(hostedRepoDir(repo.id), request, pathInfo, {
    allowPush: push,
    guardDefaultBranch: repo.guardDefaultBranch,
    onPushed: () => {
      fetchIntoMainClone(repo.id).catch((err: unknown) => {
        serverLog(`[git] fetching ${repo.id} after a push: ${(err as Error).message}`)
      })
    },
  })
}

/**
 * Fetch a hosted repo into its main clone, which also refreshes `origin/*`
 * in the running workspaces that have a checkout, then make the
 * repository's default branch the clone's `origin/HEAD`, which creates fork
 * from. The default is read after the fetch, so a change of default that
 * lands meanwhile is not overwritten with the old one.
 */
async function fetchIntoMainClone(repoId: string): Promise<void> {
  await fetchRepoOrigin(repoId)
  const head = await hostedDefaultBranch(hostedRepoDir(repoId))
  if (head !== null) await setOriginHead(repoDir(repoId), head)
}

/** A hosted repo whose settings (`what`) the principal may change: its
 *  owner's. */
async function ownHostedRepo(principal: Actor, repoId: string, what: string): Promise<RepoRow> {
  const repo = await ownRepo(principal, repoId)
  if (!repo.hosted) {
    throw new ServerError('VALIDATION', `${repo.remoteUrl} is not hosted by yaac; set its ${what} at its git host.`)
  }
  return repo
}

/**
 * Make `branch`, which must exist, a hosted repo's default branch: the one
 * a clone checks out, creates fork from, and the guard protects. The main
 * clone follows before this answers, so the next create forks from
 * `branch`; a failure to follow is logged rather than failing a change the
 * repository has already made.
 */
export async function setDefaultBranch(principal: Actor, repoId: string, branch: string): Promise<void> {
  await ownHostedRepo(principal, repoId, 'default branch')
  if (!await setHostedDefaultBranch(hostedRepoDir(repoId), branch)) {
    throw new ServerError('VALIDATION', `the repo has no branch "${branch}".`)
  }
  await fetchIntoMainClone(repoId).catch((err: unknown) => {
    serverLog(`[git] fetching ${repoId} into its main clone: ${(err as Error).message}`)
  })
}

/**
 * Turn a hosted repo's default-branch guard on or off: while on, a push
 * that deletes the default branch or rewinds it (a force-push that drops
 * commits) is refused. A repo hosted elsewhere is protected at its host.
 */
export async function setDefaultBranchGuard(principal: Actor, repoId: string, enabled: boolean): Promise<void> {
  await ownHostedRepo(principal, repoId, 'default-branch guard')
  await setRepoDefaultBranchGuard(repoId, enabled)
}

/**
 * Delete the repository yaac kept when the repo moved to another git host
 * (docs/hosted-projects.md "Moving to a git host"), once its owner has
 * checked the new remote has everything. The repository goes before the
 * flag, so a failed delete can be retried.
 */
export async function removeKeptHostedRepo(principal: Actor, repoId: string): Promise<void> {
  const repo = await ownRepo(principal, repoId)
  if (!repo.keepsHostedRepo) throw new ServerError('VALIDATION', `yaac keeps no old repository for ${repo.remoteUrl}.`)
  await fs.rm(hostedRepoDir(repoId), { recursive: true, force: true })
  await clearRepoKeepsHostedRepo(repoId)
}
