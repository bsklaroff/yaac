import { worktreeDriver } from '#drivers/driver'
import type { RuntimeSnapshot } from '#drivers/contract'
import {
  classifyWorkspaces,
  isWorktreeTerminating,
  probeAgentPaneState,
  probeTmuxLiveness,
} from '#runtime/status'
import { cleanupWorktreeDetached } from './cleanup'
import { inFlightWorktreeIds } from './provisioning'
import { applyWorktreeEvent, desiredWorktrees } from '#db'
import { serverLog } from '#log'
import { testEnv } from '@yaac/shared/env'
import type { StaleWorktreeInfo } from '@yaac/shared/types'

/**
 * How long a recorded worktree must be CONTINUOUSLY observed with no pod
 * before the reaper records it as dead. Must clear the slowest legitimate
 * create — a cold image build and pod start — since the row is
 * written before any of that starts. In-process creates are exempt via the
 * provisioning registry, so this only bounds the crash case.
 */
const PODLESS_ROW_GRACE_MS = 30 * 60_000

/** `<projectSlug>/<worktreeId>` → epoch ms the row was first seen with no
 *  pod. Cleared the moment a pod shows up, so only a sustained absence ever
 *  reaches the grace. */
const missingSince = new Map<string, number>()

/** Test helper: forget which rows are being watched for a missing pod. */
export function _clearMissingPodTimersForTests(): void {
  missingSince.clear()
}

/**
 * Tear down stale worktree Jobs (pod stopped, or running with a dead
 * tmux session) across every project. Swallows individual failures so
 * one broken worktree can't block the rest; designed to be called from
 * the server reconciler.
 */
export async function reconcileStaleWorktrees(snapshot?: RuntimeSnapshot): Promise<void> {
  const view = snapshot ?? worktreeDriver().snapshot()
  // What the server records as existing, read at the top of THIS pass —
  // so absence is only ever judged against a set from the same pass, by
  // construction. A failed read stands every sweep down (reap nothing, say
  // nothing): an exemption set that is even one pass stale can miss a
  // create started since, and reaping on a guess destroys uncommitted work
  // that exists in no other copy. The next pass retries.
  const desired = await desiredWorktrees().catch(() => undefined)
  if (desired === undefined) return

  let pods
  try {
    pods = await view.workspaces()
  } catch {
    return
  }
  const nowMs = Date.now()
  const graceMs = testEnv.startingGraceMs
  const { running, stale: staleAll, indeterminate, terminating } =
    await classifyWorkspaces(pods, nowMs, probeTmuxLiveness, graceMs)

  // Worktrees the server is still creating, read from the provisioning
  // registry (which excludes failed creates: their rollback tore down what
  // they left, so they shield nothing). A create owns its pod's whole
  // lifecycle, so every sweep below exempts one regardless of age: the
  // grace window alone bounds nothing on a host where the image pull or
  // the hostPath mounts outlast it, and reaping mid-create deletes the
  // staged worktree dir out from under the starting pod — after which its
  // Job can never mount and create fails on every retry.
  const provisioningIds = new Set(inFlightWorktreeIds())

  // A pod that has not reached Running yet — pulling its image, mounting its
  // hostPaths — reads as stopped to the classifier, which derives
  // `pod-stopped` from the terminal state it does not have.
  const stale = staleAll.filter((s) => !s.worktreeId || !provisioningIds.has(s.worktreeId))

  // Surface the near-miss: a running pod we deliberately did NOT reap
  // because its tmux probe was inconclusive (transient kubectl-exec
  // failure) — historically the main false-positive source. Without this
  // line the avoided reap is invisible, so a flapping probe looks like
  // nothing happened.
  for (const p of indeterminate) {
    serverLog(
      `[server] stale-reaper: keeping session=${p.workspaceId} job=${p.jobName}`
      + ' (tmux probe inconclusive; pod still running)',
    )
  }

  // Half-provisioned zombie sweep: a create killed between opening tmux
  // (the `sleep infinity` placeholder window) and respawning the agent —
  // e.g. a server restart mid-create — leaves a pod whose tmux is alive
  // but whose agent will never start. The liveness probe above calls that
  // healthy forever, so additionally require the agent pane to have left
  // the placeholder once the grace window has passed. Only a conclusive
  // `placeholder` verdict reaps; `unknown` keeps the worktree. A create
  // this process is still running is exempt regardless of age — its pane
  // is legitimately the placeholder for as long as provisioning takes,
  // and the grace only bounds the crashed-create case.
  const placeholderStale: StaleWorktreeInfo[] = []
  await Promise.all(running.map(async (p) => {
    if (!p.projectSlug || !p.workspaceId) return
    if (provisioningIds.has(p.workspaceId)) return
    const ageMs = p.createdAtMs > 0 ? nowMs - p.createdAtMs : Infinity
    if (ageMs < graceMs) return
    if (await probeAgentPaneState(p) !== 'placeholder') return
    placeholderStale.push({
      jobName: p.jobName, projectSlug: p.projectSlug, worktreeId: p.workspaceId, zombie: true,
    })
  }))

  // Stray-unit sweep: a runtime unit whose workspace was evicted or deleted
  // out-of-band is invisible to the workspace classifier, so ask the pass
  // view for the units it is still holding with no workspace behind them —
  // computed off the same instant, so "no workspace" is never a comparison
  // across two views. A create in flight is exempt here too: between the
  // unit being applied and the workspace being admitted, a slow create looks
  // exactly like an orphan.
  const orphanTargets: Array<{ jobName: string; projectSlug: string; worktreeId: string }> = []
  try {
    for (const u of await view.strayUnits()) {
      if (provisioningIds.has(u.workspaceId)) continue
      if (nowMs - u.createdAtMs < graceMs) continue
      orphanTargets.push({
        jobName: u.unitName, projectSlug: u.projectSlug, worktreeId: u.workspaceId,
      })
    }
  } catch {
    // Unit list unavailable — the workspace-based sweep below still runs.
  }

  // Stuck-terminating sweep: a pod carrying a deletionTimestamp that this
  // process isn't currently marking, stuck past the grace window — an external
  // `kubectl delete pod`, or a yaac delete whose in-memory mark was lost
  // (server restart, TTL). Re-issuing the idempotent Job delete resumes the
  // teardown either way; the cause split below (ours vs out-of-band) is
  // decided from the worktree row's recorded deletion, not the mark. Deletes
  // we're still marking stay skipped here.
  const stuckTerminating: Array<{ jobName: string; projectSlug: string; worktreeId: string }> = []
  for (const p of terminating) {
    if (!p.terminating || !p.projectSlug || !p.workspaceId) continue
    if (isWorktreeTerminating(p.workspaceId)) continue
    // create's retry loop deletes the half-started Job itself before the next
    // attempt, which leaves exactly this shape: a terminating pod nothing is
    // marking. Tearing it down here runs the full teardown — worktree dir
    // included — against a create that is about to retry into it.
    if (provisioningIds.has(p.workspaceId)) continue
    const ageMs = p.createdAtMs > 0 ? nowMs - p.createdAtMs : Infinity
    if (ageMs < graceMs) continue
    stuckTerminating.push({ jobName: p.jobName, projectSlug: p.projectSlug, worktreeId: p.workspaceId })
  }

  // A stuck-terminating pod that yaac itself deleted (its in-memory mark was
  // lost to a server restart or the TTL while teardown dragged) looks, by pod
  // state alone, exactly like a real out-of-band `kubectl delete`. The durable
  // tell is the `deletedAt` yaac stamps when it issues a delete: a worktree
  // carrying one was ours, so resume its (idempotent) teardown but
  // preserve the recorded cause — restamping it "removed outside yaac" would
  // clobber a plain user delete (or an earlier reaped death). Only a
  // record-less terminating pod is genuinely out-of-band.
  const ourStuck: typeof stuckTerminating = []
  const externalStuck: typeof stuckTerminating = []
  if (stuckTerminating.length > 0) {
    const recorded = new Set(desired.stopped)
    for (const t of stuckTerminating) {
      if (recorded.has(`${t.projectSlug}/${t.worktreeId}`)) ourStuck.push(t)
      else externalStuck.push(t)
    }
  }

  // Rows with no pod: the row is written before the Job, so a create killed
  // in between (server crash, kill -9) leaves a worktree recorded as live
  // with nothing backing it — invisible to the pod-driven list and absent
  // from the deleted listing, but permanently on the capture step's work
  // list.
  //
  // The window is measured from when the pod was first OBSERVED missing,
  // never from the row's age. A pod listing that succeeds while empty or
  // partial (an informer cache before its initial sync, say) would
  // otherwise condemn every worktree older than the grace in a single tick,
  // while their pods are running — and nothing un-marks a death but a
  // restart. Requiring the same row to look podless across the whole window
  // makes one bad listing cost nothing. The map is in-memory, so a server
  // restart re-arms every timer, which errs toward not recording.
  const livePodIds = new Set(pods.map((p) => p.workspaceId))
  {
    const seen = new Set<string>()
    for (const row of desired.live) {
      const rowKey = `${row.projectSlug}/${row.worktreeId}`
      seen.add(rowKey)
      if (livePodIds.has(row.worktreeId) || provisioningIds.has(row.worktreeId)) {
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
      // A row with a captured prompt or a linked agent session had an
      // agent running, so its Job went away out-of-band; one with neither
      // never got that far.
      const cause = row.ran
        ? { reason: 'orphaned' as const, detail: 'Job and pod deleted out-of-band' }
        : { reason: 'never-started' as const, detail: 'session create did not complete' }
      serverLog(
        `[server] stale-reaper: recording worktree=${row.worktreeId} as ${cause.reason}`
        + ` (no pod for ${Math.round((nowMs - since) / 60_000)} min)`,
      )
      await applyWorktreeEvent({
        type: 'worktree-stopped',
        projectSlug: row.projectSlug,
        worktreeId: row.worktreeId,
        cause,
      }).catch(() => { /* best-effort; the next tick retries */ })
    }
    // Forget timers for rows that are no longer live (deleted, restarted,
    // or their project removed), so the map tracks only what it watches.
    for (const rowKey of missingSince.keys()) {
      if (!seen.has(rowKey)) missingSince.delete(rowKey)
    }
  }

  const targets = [
    ...stale.map((s) => ({
      jobName: s.jobName,
      projectSlug: s.projectSlug,
      worktreeId: s.worktreeId,
      cause: s.deathCause,
    })),
    ...placeholderStale.map((s) => ({
      jobName: s.jobName,
      projectSlug: s.projectSlug,
      worktreeId: s.worktreeId,
      cause: { reason: 'never-started' as const },
    })),
    ...orphanTargets.map((o) => ({ ...o, cause: { reason: 'orphaned' as const } })),
    ...externalStuck.map((t) => ({
      ...t,
      cause: { reason: 'orphaned' as const, detail: 'pod deleted out-of-band' },
    })),
    ...ourStuck.map((t) => ({ ...t, preserveDeletedRecord: true as const })),
  ]
  if (targets.length === 0) return

  // Audit each reap with its reason before the (detached, silent)
  // teardown runs, so a worktree disappearing is always explained. The
  // derived cause rides along (cleanupWorktreeDetached echoes it too) so
  // the log alone answers "why did this worktree die".
  for (const s of stale) {
    const reason = s.zombie
      ? 'tmux gone, pod still running'
      : `pod stopped: ${s.deathCause?.reason ?? 'unknown'}`
        + (s.deathCause?.detail ? ` (${s.deathCause.detail})` : '')
    serverLog(`[server] stale-reaper: reaping session=${s.worktreeId} job=${s.jobName} (${reason})`)
  }
  for (const s of placeholderStale) {
    serverLog(`[server] stale-reaper: reaping session=${s.worktreeId} job=${s.jobName} (agent never started; placeholder pane past grace)`)
  }
  for (const o of orphanTargets) {
    serverLog(`[server] stale-reaper: reaping session=${o.worktreeId} job=${o.jobName} (orphan Job, no backing pod)`)
  }
  for (const t of externalStuck) {
    serverLog(`[server] stale-reaper: reaping session=${t.worktreeId} job=${t.jobName} (terminating out-of-band past grace)`)
  }
  for (const t of ourStuck) {
    serverLog(`[server] stale-reaper: resuming teardown session=${t.worktreeId} job=${t.jobName} (terminating mark lost; yaac-issued delete)`)
  }

  await Promise.all(targets.map((t) =>
    cleanupWorktreeDetached(t).catch(() => { /* best-effort */ }),
  ))
}
