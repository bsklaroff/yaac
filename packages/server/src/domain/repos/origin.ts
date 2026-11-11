import { fetchCommit, fetchOrigin, maintainRepo, seedEmptyOrigin } from '#domain/git'
import type { RuntimeSnapshot } from '#drivers/contract'
import { getRepo, listRepos, listWorkspaceReposFor, type RepoRow } from '#db'
import { serverLog } from '#lib/log'
import { hostedRepoDir, repoDir } from '@yaac/shared/project-paths'
import { testEnv } from '@yaac/shared/env'
import { ServerError } from '@yaac/shared/errors'
import { resolveRepoCredential } from './credentials'

/**
 * Keeps every repo's main clone current (docs/server-git.md). Each fetch is
 * followed by a gc of the clone and by whatever the composition root
 * registered: copying the refs into the running workspaces that have a
 * checkout of the repo, and waking the `sites` step. The `origin-refresh`
 * reconcile step also fetches on a timer, so idle repos stay within minutes
 * of origin.
 */

/** How stale the main clone of a repo with running workspaces may get
 *  before the reconcile step fetches it. */
export const ORIGIN_REFRESH_MS = 5 * 60_000

/** When each repo's main clone was last fetched (or tried), by repo id. */
const lastFetchMs = new Map<string, number>()

/** The fetches whose follow-up is already scheduled. */
const followedUp = new WeakSet<Promise<void>>()

const fetchedListeners: Array<(repoId: string) => void> = []

/** Register what runs after each fetch of a repo's origin succeeds. */
export function onOriginFetched(fn: (repoId: string) => void): void {
  fetchedListeners.push(fn)
}

/** Where the server's own git fetches a repo from: its URL, or for a
 *  hosted repo the bare repository on disk. A deleted repo has no remote. */
async function fetchSource(repoId: string): Promise<{ repo: RepoRow; url: string }> {
  const repo = await getRepo(repoId)
  if (!repo) throw new ServerError('NOT_FOUND', `repo ${repoId} not found`)
  if (repo.deletedAt !== undefined) throw new ServerError('VALIDATION', `${repo.remoteUrl} was deleted by its owner`)
  return { repo, url: repo.hosted ? hostedRepoDir(repoId) : repo.remoteUrl }
}

/**
 * Fetch a repo's origin into its main clone, then, in the background, gc it
 * (`maintainRepo`) and tell the listeners. `unlessWithinMs` skips the fetch
 * when one started that recently, so a caller a workspace can repeat cannot
 * keep origin fetching nonstop.
 */
export async function fetchRepoOrigin(repoId: string, opts: { unlessWithinMs?: number } = {}): Promise<void> {
  const now = Date.now()
  if (opts.unlessWithinMs !== undefined && now - (lastFetchMs.get(repoId) ?? 0) < opts.unlessWithinMs) return
  lastFetchMs.set(repoId, now)
  const { repo, url } = await fetchSource(repoId)
  const dir = repoDir(repoId)
  const fetched = fetchOrigin(dir, url, await resolveRepoCredential(repo))
  // Once per fetch; concurrent callers share one.
  if (!followedUp.has(fetched)) {
    followedUp.add(fetched)
    fetched.then(() => {
      maintainRepo(dir).catch((err: unknown) => {
        serverLog(`[git] maintenance of ${repoId}: ${(err as Error).message}`)
      })
      for (const fn of fetchedListeners) fn(repoId)
    }, () => { /* the caller sees it */ })
  }
  await fetched
}

/** Make sure a repo's main clone has a commit, fetching it from origin by
 *  id if it does not (`fetchCommit`). */
export async function fetchRepoCommit(repoId: string, sha: string): Promise<void> {
  const { repo, url } = await fetchSource(repoId)
  await fetchCommit(repoDir(repoId), url, await resolveRepoCredential(repo), sha)
}

/** Give a repo whose origin has no branches its default one, as an empty
 *  commit by `author` (`seedEmptyOrigin`). */
export async function seedRepoOrigin(repoId: string, author: { name: string; email: string }): Promise<void> {
  const { repo, url } = await fetchSource(repoId)
  await seedEmptyOrigin(repoDir(repoId), url, await resolveRepoCredential(repo), author)
}

/**
 * The `origin-refresh` reconcile step: fetch every repo a running workspace
 * has a checkout of that hasn't been fetched (by anything) for
 * `ORIGIN_REFRESH_MS`. Detached from the pass; failures are logged and
 * retried next interval.
 */
export async function refreshRepoOrigins(view: RuntimeSnapshot): Promise<void> {
  if (testEnv.e2eSkipFetch) return
  const now = Date.now()
  const running = (await view.workspaces()).filter((h) => h.running && !h.prewarmed).map((h) => h.workspaceId)
  const repoIds = new Set([...(await listWorkspaceReposFor(running)).values()].flat().map((r) => r.repoId))
  // A deleted repo has no remote to fetch.
  const deleted = new Set((await listRepos()).filter((r) => r.deletedAt !== undefined).map((r) => r.id))
  for (const repoId of repoIds) {
    if (deleted.has(repoId) || now - (lastFetchMs.get(repoId) ?? 0) < ORIGIN_REFRESH_MS) continue
    fetchRepoOrigin(repoId).catch((err: unknown) => {
      serverLog(`[git] origin refresh of ${repoId}: ${(err as Error).message}`)
    })
  }
}
