import { listSessionJobs, listSessionPods } from '#platform/k8s/pods'
import type { TickSnapshot } from '#platform/k8s/tick-snapshot'
import { classifySessionPods } from '#features/sessions/classify'
import { probeAgentPaneState, probeTmuxLiveness, cleanupSessionDetached } from '#features/sessions/cleanup'
import { isSessionTerminating } from '#features/sessions/state'
import { listDeletedInfo } from '#features/sessions/deleted-store'
import { serverLog } from '#log'
import { testEnv } from '@yaac/shared/env'
import type { StaleSessionInfo } from '@yaac/shared/types'

/**
 * Tear down stale session Jobs (pod stopped, or running with a dead
 * tmux session) across every project. Swallows individual failures so
 * one broken session can't block the rest; designed to be called from
 * the server background loop.
 */
export async function reconcileStaleSessions(snapshot?: TickSnapshot): Promise<void> {
  let pods
  try {
    pods = await (snapshot ? snapshot.pods() : listSessionPods())
  } catch {
    return
  }
  const nowMs = Date.now()
  const graceMs = testEnv.startingGraceMs
  const { running, stale, indeterminate, terminating } = await classifySessionPods(pods, nowMs, probeTmuxLiveness, graceMs)

  // Surface the near-miss: a running pod we deliberately did NOT reap
  // because its tmux probe was inconclusive (transient kubectl-exec
  // failure) — historically the main false-positive source. Without this
  // line the avoided reap is invisible, so a flapping probe looks like
  // nothing happened.
  for (const p of indeterminate) {
    serverLog(
      `[server] stale-reaper: keeping session=${p.sessionId} job=${p.jobName}`
      + ' (tmux probe inconclusive; pod still running)',
    )
  }

  // Half-provisioned zombie sweep: a create killed between opening tmux
  // (the `sleep infinity` placeholder window) and respawning the agent —
  // e.g. a server restart mid-create — leaves a pod whose tmux is alive
  // but whose agent will never start. The liveness probe above calls that
  // healthy forever, so additionally require the agent pane to have left
  // the placeholder once the grace window has passed. Only a conclusive
  // `placeholder` verdict reaps; `unknown` keeps the session.
  const placeholderStale: StaleSessionInfo[] = []
  await Promise.all(running.map(async (p) => {
    if (!p.projectSlug || !p.sessionId) return
    const ageMs = p.createdAtMs > 0 ? nowMs - p.createdAtMs : Infinity
    if (ageMs < graceMs) return
    if (await probeAgentPaneState(p.projectSlug, p.sessionId) !== 'placeholder') return
    placeholderStale.push({
      jobName: p.jobName, projectSlug: p.projectSlug, sessionId: p.sessionId, zombie: true,
    })
  }))

  // Orphan-Job sweep: a Job whose pod was evicted/deleted out-of-band is
  // invisible to the pod-based classifier, so cross-reference the Job
  // list and reap any job past the grace window with no backing pod.
  const orphanTargets: Array<{ jobName: string; projectSlug: string; sessionId: string }> = []
  try {
    const jobs = await (snapshot ? snapshot.jobs() : listSessionJobs())
    const podSessionIds = new Set(pods.map((p) => p.sessionId))
    for (const j of jobs) {
      if (podSessionIds.has(j.sessionId)) continue
      if (nowMs - j.createdAtMs < graceMs) continue
      orphanTargets.push({ jobName: j.jobName, projectSlug: j.projectSlug, sessionId: j.sessionId })
    }
  } catch {
    // Job list unavailable — the pod-based sweep below still runs.
  }

  // Stuck-terminating sweep: a pod carrying a deletionTimestamp that this
  // process isn't currently marking, stuck past the grace window — an external
  // `kubectl delete pod`, or a yaac delete whose in-memory mark was lost
  // (server restart, TTL). Re-issuing the idempotent Job delete resumes the
  // teardown either way; the cause split below (ours vs out-of-band) is
  // decided from the durable deleted-store, not the mark. Deletes we're still
  // marking stay skipped here.
  const stuckTerminating: Array<{ jobName: string; projectSlug: string; sessionId: string }> = []
  for (const p of terminating) {
    if (!p.terminating || !p.projectSlug || !p.sessionId) continue
    if (isSessionTerminating(p.sessionId)) continue
    const ageMs = p.createdAtMs > 0 ? nowMs - p.createdAtMs : Infinity
    if (ageMs < graceMs) continue
    stuckTerminating.push({ jobName: p.jobName, projectSlug: p.projectSlug, sessionId: p.sessionId })
  }

  // A stuck-terminating pod that yaac itself deleted (its in-memory mark was
  // lost to a server restart or the TTL while teardown dragged) looks, by pod
  // state alone, exactly like a real out-of-band `kubectl delete`. The durable
  // tell is the deleted-store row yaac writes when it issues a delete: a
  // session with a record was ours, so resume its (idempotent) teardown but
  // preserve the recorded cause — restamping it "removed outside yaac" would
  // clobber a plain user delete (or an earlier reaped death). Only a
  // record-less terminating pod is genuinely out-of-band.
  const ourStuck: typeof stuckTerminating = []
  const externalStuck: typeof stuckTerminating = []
  if (stuckTerminating.length > 0) {
    const deletedBySlug = new Map(await Promise.all(
      [...new Set(stuckTerminating.map((t) => t.projectSlug))].map(async (slug) =>
        [slug, await listDeletedInfo(slug).catch((): Map<string, unknown> => new Map())] as const),
    ))
    for (const t of stuckTerminating) {
      if (deletedBySlug.get(t.projectSlug)?.has(t.sessionId)) ourStuck.push(t)
      else externalStuck.push(t)
    }
  }

  const targets = [
    ...stale.map((s) => ({
      jobName: s.jobName,
      projectSlug: s.projectSlug,
      sessionId: s.sessionId,
      cause: s.deathCause,
    })),
    ...placeholderStale.map((s) => ({
      jobName: s.jobName,
      projectSlug: s.projectSlug,
      sessionId: s.sessionId,
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
  // teardown runs, so a session disappearing is always explained. The
  // derived cause rides along (cleanupSessionDetached echoes it too) so
  // the log alone answers "why did this session die".
  for (const s of stale) {
    const reason = s.zombie
      ? 'tmux gone, pod still running'
      : `pod stopped: ${s.deathCause?.reason ?? 'unknown'}`
        + (s.deathCause?.detail ? ` (${s.deathCause.detail})` : '')
    serverLog(`[server] stale-reaper: reaping session=${s.sessionId} job=${s.jobName} (${reason})`)
  }
  for (const s of placeholderStale) {
    serverLog(`[server] stale-reaper: reaping session=${s.sessionId} job=${s.jobName} (agent never started; placeholder pane past grace)`)
  }
  for (const o of orphanTargets) {
    serverLog(`[server] stale-reaper: reaping session=${o.sessionId} job=${o.jobName} (orphan Job, no backing pod)`)
  }
  for (const t of externalStuck) {
    serverLog(`[server] stale-reaper: reaping session=${t.sessionId} job=${t.jobName} (terminating out-of-band past grace)`)
  }
  for (const t of ourStuck) {
    serverLog(`[server] stale-reaper: resuming teardown session=${t.sessionId} job=${t.jobName} (terminating mark lost; yaac-issued delete)`)
  }

  await Promise.all(targets.map((t) =>
    cleanupSessionDetached(t).catch(() => { /* best-effort */ }),
  ))
}
