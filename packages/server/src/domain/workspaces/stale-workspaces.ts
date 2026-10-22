import type { RuntimeSnapshot } from '#drivers/contract'
import {
  classifyWorkspaces,
  isWorkspaceTerminating,
  probeAgentPaneState,
  probeTmuxLiveness,
} from '#runtime/status'
import { cleanupWorkspaceDetached } from './cleanup'
import { reapSpare } from './prewarm'
import { inFlightWorkspaceIds } from './provisioning'
import { applyWorkspaceEvent, desiredWorkspaces } from '#db'
import { serverLog } from '#lib/log'
import { testEnv } from '@yaac/shared/env'
import type { StaleWorkspaceInfo } from '@yaac/shared/types'

/**
 * How long a live row must be continuously seen with no pod before it is
 * recorded as dead. In-process creates are exempt, so this covers a create
 * interrupted by a crash; it must exceed the slowest cold create.
 */
const PODLESS_ROW_GRACE_MS = 30 * 60_000

/** `<projectId>/<workspaceId>` → when the row was first seen with no pod.
 *  Cleared as soon as a pod appears. */
const missingSince = new Map<string, number>()

/** Test helper: forget which rows are being watched for a missing pod. */
export function _clearMissingPodTimersForTests(): void {
  missingSince.clear()
}

/**
 * Reconcile step that tears down stale workspaces in every project: stopped
 * pods, dead tmux, agents that never started, stray units, and stuck
 * terminations. Also records long-podless rows as dead. A failed workspace
 * or desired-set read fails the step before anything is reaped; a failed
 * teardown is logged and the next pass retries it.
 *
 * A stale unit still marked prewarmed, a stray one included, goes to
 * `reapSpare` instead, which deletes its files before its unit: a spare has
 * no row, so once the unit is gone nothing says the files were a spare's.
 */
export async function reconcileStaleWorkspaces(view: RuntimeSnapshot): Promise<void> {
  // Read fresh each pass. A stale set could miss a new create and destroy
  // uncommitted work.
  const desired = await desiredWorkspaces()
  const pods = await view.workspaces()
  const nowMs = Date.now()
  const graceMs = testEnv.startingGraceMs
  const { running, stale: staleAll, indeterminate, terminating } =
    await classifyWorkspaces(pods, nowMs, probeTmuxLiveness, graceMs)

  // Workspaces still being created are exempt from every sweep, whatever
  // their age: reaping mid-create would delete dirs the pod is about to
  // mount. (A pod not yet Running reads as stopped to the classifier.)
  const provisioningIds = new Set(inFlightWorkspaceIds(view.takenAtMs))

  const stale = staleAll.filter((s) => !s.workspaceId || !provisioningIds.has(s.workspaceId))

  // Log pods kept because the tmux probe was inconclusive, so a flapping
  // probe is visible.
  for (const p of indeterminate) {
    serverLog(
      `[server] stale-reaper: keeping session=${p.workspaceId} job=${p.jobName}`
      + ' (tmux probe inconclusive; pod still running)',
    )
  }

  // A create interrupted after tmux started but before the agent replaced
  // the placeholder window leaves a pod tmux reports as healthy forever.
  // Past the grace window, reap only on a conclusive `placeholder` verdict.
  const placeholderStale: StaleWorkspaceInfo[] = []
  await Promise.all(running.map(async (p) => {
    if (!p.projectId || !p.workspaceId) return
    if (provisioningIds.has(p.workspaceId)) return
    const ageMs = p.createdAtMs > 0 ? nowMs - p.createdAtMs : Infinity
    if (ageMs < graceMs) return
    if (await probeAgentPaneState(p) !== 'placeholder') return
    placeholderStale.push({
      jobName: p.jobName, projectId: p.projectId, workspaceId: p.workspaceId, zombie: true,
    })
  }))

  // Units with no workspace (evicted or deleted out-of-band), from the same
  // snapshot.
  // A failed read stops only this sweep: the workspaces already read are
  // still conclusive.
  const orphanTargets: Array<{ jobName: string; projectId: string; workspaceId: string }> = []
  const strays = await view.strayUnits().catch((err: unknown) => {
    serverLog(`[server] stale-reaper: skipping the orphan sweep: ${String(err)}`)
    return []
  })
  for (const u of strays) {
    if (provisioningIds.has(u.workspaceId)) continue
    if (nowMs - u.createdAtMs < graceMs) continue
    orphanTargets.push({
      jobName: u.unitName, projectId: u.projectId, workspaceId: u.workspaceId,
    })
  }

  // Pods terminating past the grace window with no in-memory mark: an
  // external delete, or ours with the mark lost (server restart, TTL).
  // Re-issuing the idempotent teardown resumes either. The `orphaned` cause
  // lands only on a live row; one yaac stopped keeps its recorded stop.
  const stuckTerminating: Array<{ jobName: string; projectId: string; workspaceId: string }> = []
  for (const p of terminating) {
    if (!p.terminating || !p.projectId || !p.workspaceId) continue
    if (isWorkspaceTerminating(p.workspaceId)) continue
    // A failed create leaves this shape while it tears its launch down.
    if (provisioningIds.has(p.workspaceId)) continue
    const ageMs = p.createdAtMs > 0 ? nowMs - p.createdAtMs : Infinity
    if (ageMs < graceMs) continue
    stuckTerminating.push({ jobName: p.jobName, projectId: p.projectId, workspaceId: p.workspaceId })
  }

  // Live rows with no pod (a create killed before launch) are recorded as
  // stopped. Timed from when the pod was first seen missing, not the row's
  // age, so one empty or partial listing cannot condemn every workspace.
  const livePodIds = new Set(pods.map((p) => p.workspaceId))
  {
    const seen = new Set<string>()
    for (const row of desired.live) {
      const rowKey = `${row.projectId}/${row.workspaceId}`
      seen.add(rowKey)
      if (livePodIds.has(row.workspaceId) || provisioningIds.has(row.workspaceId)) {
        missingSince.delete(rowKey)
        continue
      }
      const since = missingSince.get(rowKey)
      if (since === undefined) {
        missingSince.set(rowKey, nowMs)
        continue
      }
      if (nowMs - since < PODLESS_ROW_GRACE_MS) continue
      missingSince.delete(rowKey)
      // `ran`: an agent ran, so the unit went away out-of-band.
      const cause = row.ran
        ? { reason: 'orphaned' as const, detail: 'Job and pod deleted out-of-band' }
        : { reason: 'never-started' as const, detail: 'session create did not complete' }
      serverLog(
        `[server] stale-reaper: recording workspace=${row.workspaceId} as ${cause.reason}`
        + ` (no pod for ${Math.round((nowMs - since) / 60_000)} min)`,
      )
      await applyWorkspaceEvent({
        type: 'workspace-stopped',
        projectId: row.projectId,
        workspaceId: row.workspaceId,
        cause,
      }).catch((err: unknown) => {
        serverLog(`[server] stale-reaper: recording workspace=${row.workspaceId} failed: ${String(err)}`)
      })
    }
    // Forget timers for rows no longer live.
    for (const rowKey of missingSince.keys()) {
      if (!seen.has(rowKey)) missingSince.delete(rowKey)
    }
  }

  // Each with the reason it is reaped, logged since the detached teardown
  // is silent.
  const targets = [
    ...stale.map((s) => ({
      jobName: s.jobName,
      projectId: s.projectId,
      workspaceId: s.workspaceId,
      cause: s.deathCause,
      why: s.zombie
        ? 'tmux gone, pod still running'
        : `pod stopped: ${s.deathCause?.reason ?? 'unknown'}`
          + (s.deathCause?.detail ? ` (${s.deathCause.detail})` : ''),
    })),
    ...placeholderStale.map((s) => ({
      jobName: s.jobName,
      projectId: s.projectId,
      workspaceId: s.workspaceId,
      cause: { reason: 'never-started' as const },
      why: 'agent never started; placeholder pane past grace',
    })),
    ...orphanTargets.map((o) => ({
      ...o, cause: { reason: 'orphaned' as const }, why: 'orphan Job, no backing pod',
    })),
    ...stuckTerminating.map((t) => ({
      ...t,
      cause: { reason: 'orphaned' as const, detail: 'pod deleted out-of-band' },
      why: 'terminating past grace: out-of-band delete, or a teardown whose mark was lost',
    })),
  ]
  const spares = new Set([...pods, ...strays].filter((u) => u.prewarmed).map((u) => u.workspaceId))
  for (const { why, ...t } of targets.filter((t) => spares.has(t.workspaceId))) {
    serverLog(`[server] stale-reaper: reaping spare=${t.workspaceId} job=${t.jobName} (${why})`)
    reapSpare(t)
  }
  await Promise.all(targets.filter((t) => !spares.has(t.workspaceId)).map(({ why, ...t }) => {
    serverLog(`[server] stale-reaper: reaping session=${t.workspaceId} job=${t.jobName} (${why})`)
    return cleanupWorkspaceDetached(t).catch((err: unknown) => {
      serverLog(`[server] stale-reaper: teardown of session=${t.workspaceId} failed: ${String(err)}`)
    })
  }))
}
