import path from 'node:path'
import { workspaceDriver } from '#drivers/driver'
import { listRepoHolders } from '#db'
import { serverLog } from '#lib/log'
import { repoDir } from '@yaac/shared/project-paths'
import { buildOriginRefreshExec } from '@yaac/shared/git'
import { spareSettings } from './prewarm'

/*
 * Keeps every running workspace's `origin/*` current (docs/server-git.md).
 * Each checkout is a clone with its own refs, so after every fetch of a
 * repo's main clone its refs are copied into each running workspace and
 * spare that has a checkout of the repo, in any project.
 */

/** How many checkouts one fan-out refreshes at once. */
const FAN_OUT_CONCURRENCY = 4

/** Per repo, a running fan-out and whether another was requested
 *  meanwhile. */
const fanOuts = new Map<string, { again: boolean }>()

/**
 * Refresh `origin/*` in every running checkout of a repo, in the
 * background. Requests during a run make it loop once more, so a burst
 * costs at most two rounds.
 */
export function propagateOrigin(repoId: string): void {
  const running = fanOuts.get(repoId)
  if (running) {
    running.again = true
    return
  }
  const state = { again: false }
  fanOuts.set(repoId, state)
  void (async () => {
    try {
      do {
        state.again = false
        await fanOut(repoId).catch((err: unknown) => {
          serverLog(`[git] origin fan-out for ${repoId}: ${(err as Error).message}`)
        })
      } while (state.again)
    } finally {
      fanOuts.delete(repoId)
    }
  })()
}

async function fanOut(repoId: string): Promise<void> {
  const driver = workspaceDriver()
  const held = new Map((await listRepoHolders(repoId)).map((h) => [h.workspaceId, h.path]))
  // A spare has no row yet; what it was warmed with says where its
  // checkouts are.
  const pathIn = (workspaceId: string): string | undefined =>
    held.get(workspaceId) ?? spareSettings.get(workspaceId)?.repos.find((r) => r.repoId === repoId)?.path
  const queue = (await driver.list().catch(() => []))
    .filter((h) => h.running && !h.terminating)
    .flatMap((h) => {
      const at = pathIn(h.workspaceId)
      return at !== undefined ? [{ jobName: h.jobName, at }] : []
    })
  const repoGitDir = `${repoDir(repoId)}/.git`
  const worker = async (): Promise<void> => {
    for (let h = queue.shift(); h !== undefined; h = queue.shift()) {
      const cmd = buildOriginRefreshExec(repoGitDir, path.posix.join(driver.workspacePaths(h.jobName).workspaceDir, h.at))
      // A failure is retried by the next fetch's fan-out.
      await driver.exec(h.jobName, cmd, { maxAttempts: 1 }).catch(() => {})
    }
  }
  await Promise.all(Array.from({ length: FAN_OUT_CONCURRENCY }, worker))
}
