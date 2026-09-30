import { fetchOrigin, maintainRepo } from '#domain/git'
import { worktreeDriver } from '#drivers/driver'
import type { RuntimeSnapshot } from '#drivers/contract'
import { serverLog } from '#log'
import { buildOriginRefreshExec } from '#runtime/agents'
import { repoDir } from '@yaac/shared/project-paths'
import { testEnv } from '@yaac/shared/env'
import { resolveProjectCredential } from './credentials'
import { projectRemoteUrl } from './detail'

/**
 * Keeping every worktree's `origin/*` current (docs/server-git.md). A
 * worktree is a clone with refs of its own, so a server fetch into the
 * main clone reaches it only when something copies the refs over: every
 * fetch the server makes goes through `fetchProjectOrigin`, which fans the
 * result out to the project's running workspaces, and the `origin-refresh`
 * reconcile step fetches on a timer, so a project nobody creates in still
 * trails origin by minutes rather than indefinitely.
 */

/** How stale the main clone of a project with running worktrees may get
 *  before the reconcile step fetches it. */
export const ORIGIN_REFRESH_MS = 5 * 60_000

/** How many workspaces one fan-out refreshes at once. */
const FAN_OUT_CONCURRENCY = 4

/** When each project's main clone was last fetched (or tried), by slug. */
const lastFetchMs = new Map<string, number>()

/** The fetches whose gc and fan-out are already scheduled. */
const followedUp = new WeakSet<Promise<void>>()

/** Per project, a fan-out in flight, and whether another was asked for
 *  while it ran. */
const fanOuts = new Map<string, { again: boolean }>()

/**
 * Fetch a project's origin into its main clone, then — without the caller
 * waiting on either — gc the main clone (`maintainRepo`) and bring every
 * running workspace's `origin/*` up to it (`propagateOrigin`).
 */
export async function fetchProjectOrigin(slug: string): Promise<void> {
  lastFetchMs.set(slug, Date.now())
  const repo = repoDir(slug)
  const fetched = fetchOrigin(repo, await projectRemoteUrl(slug), await resolveProjectCredential(slug))
  // Once per fetch, not per caller: callers that arrive together share one.
  if (!followedUp.has(fetched)) {
    followedUp.add(fetched)
    fetched.then(() => {
      maintainRepo(repo).catch((err: unknown) => {
        serverLog(`[git] maintenance of ${slug}: ${(err as Error).message}`)
      })
      propagateOrigin(slug)
    }, () => { /* the caller sees it */ })
  }
  await fetched
}

/**
 * Refresh `origin/*` in every running workspace of the project. Coalesced:
 * one asked for while another runs marks the project, and the running one
 * goes round exactly once more when it finishes, so a burst of fetches
 * costs at most two rounds of execs.
 */
function propagateOrigin(slug: string): void {
  const running = fanOuts.get(slug)
  if (running) {
    running.again = true
    return
  }
  const state = { again: false }
  fanOuts.set(slug, state)
  void (async () => {
    try {
      do {
        state.again = false
        await fanOut(slug).catch((err: unknown) => {
          serverLog(`[git] origin fan-out for ${slug}: ${(err as Error).message}`)
        })
      } while (state.again)
    } finally {
      fanOuts.delete(slug)
    }
  })()
}

async function fanOut(slug: string): Promise<void> {
  const driver = worktreeDriver()
  const queue = (await driver.list(slug).catch(() => []))
    .filter((h) => h.running && !h.terminating)
  const repoGitDir = `${repoDir(slug)}/.git`
  const worker = async (): Promise<void> => {
    for (let h = queue.shift(); h !== undefined; h = queue.shift()) {
      const cmd = buildOriginRefreshExec(repoGitDir, driver.workspacePaths(h.jobName))
      // A failure is retried by the next fetch's fan-out.
      await driver.exec(h.jobName, cmd, { maxAttempts: 1 }).catch(() => {})
    }
  }
  await Promise.all(Array.from({ length: FAN_OUT_CONCURRENCY }, worker))
}

/**
 * The `origin-refresh` reconcile step: fetch every project that has a
 * running worktree and has not been fetched for `ORIGIN_REFRESH_MS`. A
 * fetch a create, a claim or the branch picker made counts. Detached from
 * the pass, which does not wait on the network; a failure is logged and
 * tried again an interval later, and never reaches a worktree — a stale
 * `origin/*` is all it costs.
 */
export async function refreshProjectOrigins(view: RuntimeSnapshot): Promise<void> {
  if (testEnv.e2eSkipFetch) return
  const now = Date.now()
  const slugs = new Set((await view.workspaces())
    .filter((h) => h.running && !h.prewarmed)
    .map((h) => h.projectSlug))
  for (const slug of slugs) {
    if (now - (lastFetchMs.get(slug) ?? 0) < ORIGIN_REFRESH_MS) continue
    fetchProjectOrigin(slug).catch((err: unknown) => {
      serverLog(`[git] origin refresh of ${slug}: ${(err as Error).message}`)
    })
  }
}
