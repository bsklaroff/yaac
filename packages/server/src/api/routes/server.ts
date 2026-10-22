import { Hono } from 'hono'
import { serverUsageReport } from '#domain/workspaces'
import type { ResourceReport } from '@yaac/shared/types'
import type { IdentityEnv } from '#api/http/web-auth'

/**
 * The server health overlay's report (docs/server-health.md), which any
 * user may read. Polled while the overlay is open rather than carried on
 * the snapshot, which re-broadcasts to every client on each change, and
 * these numbers change on every read.
 *
 * A read is shared by every request that arrives while it runs, however
 * long that takes, and its answer for a few seconds after, so several open
 * overlays cost one read between them and a slow cluster never stacks them.
 */

const MEMO_MS = 5_000

/** The read in flight, or the last answer and when it settled. */
interface Memo {
  report: Promise<ResourceReport>
  settledAt?: number
}

let memo: Memo | null = null

function usageReport(): Promise<ResourceReport> {
  if (memo && (memo.settledAt === undefined || Date.now() - memo.settledAt < MEMO_MS)) return memo.report
  const entry: Memo = { report: serverUsageReport() }
  memo = entry
  entry.report.then(
    () => { entry.settledAt = Date.now() },
    // A failure is not kept for the next caller.
    () => { if (memo === entry) memo = null },
  )
  return entry.report
}

export const serverApp = new Hono<IdentityEnv>()
  .get('/usage', async (c) => c.json(await usageReport()))
