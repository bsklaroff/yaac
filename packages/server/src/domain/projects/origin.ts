import { fetchOrigin, maintainRepo } from '#domain/git'
import { workspaceDriver } from '#drivers/driver'
import type { RuntimeSnapshot } from '#drivers/contract'
import { serverLog } from '#log'
import { buildOriginRefreshExec } from '#runtime/agents'
import { repoDir } from '@yaac/shared/project-paths'
import { testEnv } from '@yaac/shared/env'
import { resolveProjectCredential } from './credentials'
import { projectRemoteUrl } from './detail'

/**
 * Keeps every workspace's `origin/*` current (docs/server-git.md). Each
 * workspace is a clone with its own refs, so after every server fetch
 * `fetchProjectOrigin` copies the refs into the project's running
 * workspaces. The `origin-refresh` reconcile step also fetches on a timer,
 * so idle projects stay within minutes of origin.
 */

/** How stale the main clone of a project with running workspaces may get
 *  before the reconcile step fetches it. */
export const ORIGIN_REFRESH_MS = 5 * 60_000

/** How many workspaces one fan-out refreshes at once. */
const FAN_OUT_CONCURRENCY = 4

/** When each project's main clone was last fetched (or tried), by project id. */
const lastFetchMs = new Map<string, number>()

/** The fetches whose gc and fan-out are already scheduled. */
const followedUp = new WeakSet<Promise<void>>()

/** Per project, a running fan-out and whether another was requested
 *  meanwhile. */
const fanOuts = new Map<string, { again: boolean }>()

/**
 * Fetch a project's origin into its main clone, then, in the background, gc
 * it (`maintainRepo`) and update every running workspace's `origin/*`
 * (`propagateOrigin`). `unlessWithinMs` skips the fetch when one started
 * that recently, so a caller a workspace can repeat cannot keep origin
 * fetching nonstop.
 */
export async function fetchProjectOrigin(projectId: string, opts: { unlessWithinMs?: number } = {}): Promise<void> {
  const now = Date.now()
  if (opts.unlessWithinMs !== undefined && now - (lastFetchMs.get(projectId) ?? 0) < opts.unlessWithinMs) return
  lastFetchMs.set(projectId, now)
  const repo = repoDir(projectId)
  const fetched = fetchOrigin(repo, await projectRemoteUrl(projectId), await resolveProjectCredential(projectId))
  // Once per fetch; concurrent callers share one.
  if (!followedUp.has(fetched)) {
    followedUp.add(fetched)
    fetched.then(() => {
      maintainRepo(repo).catch((err: unknown) => {
        serverLog(`[git] maintenance of ${projectId}: ${(err as Error).message}`)
      })
      propagateOrigin(projectId)
    }, () => { /* the caller sees it */ })
  }
  await fetched
}

/**
 * Refresh `origin/*` in every running workspace of the project. Requests
 * during a run make it loop once more, so a burst costs at most two rounds.
 */
function propagateOrigin(projectId: string): void {
  const running = fanOuts.get(projectId)
  if (running) {
    running.again = true
    return
  }
  const state = { again: false }
  fanOuts.set(projectId, state)
  void (async () => {
    try {
      do {
        state.again = false
        await fanOut(projectId).catch((err: unknown) => {
          serverLog(`[git] origin fan-out for ${projectId}: ${(err as Error).message}`)
        })
      } while (state.again)
    } finally {
      fanOuts.delete(projectId)
    }
  })()
}

async function fanOut(projectId: string): Promise<void> {
  const driver = workspaceDriver()
  const queue = (await driver.list(projectId).catch(() => []))
    .filter((h) => h.running && !h.terminating)
  const repoGitDir = `${repoDir(projectId)}/.git`
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
 * The `origin-refresh` reconcile step: fetch every project with a running
 * workspace that hasn't been fetched (by anything) for `ORIGIN_REFRESH_MS`.
 * Detached from the pass; failures are logged and retried next interval.
 */
export async function refreshProjectOrigins(view: RuntimeSnapshot): Promise<void> {
  if (testEnv.e2eSkipFetch) return
  const now = Date.now()
  const projectIds = new Set((await view.workspaces())
    .filter((h) => h.running && !h.prewarmed)
    .map((h) => h.projectId))
  for (const projectId of projectIds) {
    if (now - (lastFetchMs.get(projectId) ?? 0) < ORIGIN_REFRESH_MS) continue
    fetchProjectOrigin(projectId).catch((err: unknown) => {
      serverLog(`[git] origin refresh of ${projectId}: ${(err as Error).message}`)
    })
  }
}
