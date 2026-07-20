/**
 * Background-loop step that fires cron schedules: for each `schedules` row
 * whose cron spec has come due, start one headless session in the row's
 * project with the row's prompt typed into the agent (exactly how the
 * prewarm reconciler creates spares — no terminal, no progress stream).
 *
 * At-most-once over restarts: `lastFiredAt` is persisted BEFORE the create
 * task detaches, so a crash between the two loses the fire rather than
 * doubling it. A schedule due while the daemon is down fires once on the
 * next tick after start — any number of missed occurrences coalesce into
 * that single catch-up fire.
 */
import { Cron } from 'croner'
import { listSchedules, markFired } from '#lib/project/schedules'
import { getDefaultTool } from '#lib/project/preferences'
import { createSession, type SessionCreateOptions, type SessionCreateResult } from '#session-create'
import { serverLog } from '#log'
import type { ScheduleEntry } from '@yaac/shared/types'

export interface ScheduleReconcileDeps {
  now?: () => Date
  createSessionFn?: (slug: string, opts: SessionCreateOptions) => Promise<SessionCreateResult>
  markFiredFn?: (id: string, at: Date) => Promise<void>
}

/**
 * Whether a cron spec is due: true iff its first occurrence strictly after
 * `after` is at or before `now`. Evaluated in server-local time (croner's
 * default, DST-aware). Pure — exported for unit tests.
 */
export function cronDue(spec: string, after: Date, now: Date): boolean {
  // No callback → inert pattern holder, no timer scheduled.
  const next = new Cron(spec).nextRun(after)
  return next !== null && next.getTime() <= now.getTime()
}

/** Sweep schedules once, firing a detached session create per due row. */
export async function reconcileSchedules(deps: ScheduleReconcileDeps = {}): Promise<void> {
  const now = deps.now?.() ?? new Date()

  let rows: ScheduleEntry[]
  try {
    rows = await listSchedules()
  } catch {
    // DB not ready (e.g. mid-migration on a fresh start) — next tick retries.
    return
  }

  for (const row of rows) {
    try {
      const after = new Date(row.lastFiredAt ?? row.createdAt)
      if (!cronDue(row.spec, after, now)) continue
      // Persist the fire before detaching: a failed create is a lost fire
      // (logged below), never a double fire on the next tick or restart.
      await (deps.markFiredFn ?? markFired)(row.id, now)
      void fireSession(row, deps)
    } catch (err) {
      serverLog(`[schedules] ${row.id} (${row.projectSlug}): ${String(err)}`)
    }
  }
}

async function fireSession(row: ScheduleEntry, deps: ScheduleReconcileDeps): Promise<void> {
  try {
    const tool = row.tool ?? (await getDefaultTool()) ?? 'claude'
    await (deps.createSessionFn ?? createSession)(row.projectSlug, {
      tool,
      initialPrompt: row.prompt,
    })
    serverLog(`[schedules] ${row.id}: started scheduled session in ${row.projectSlug}`)
  } catch (err) {
    serverLog(`[schedules] ${row.id}: scheduled session create failed (fire lost): ${String(err)}`)
  }
}
