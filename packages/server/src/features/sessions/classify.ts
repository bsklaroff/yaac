import { type SessionPod } from '#platform/k8s'
import { isSessionStreamHealthy } from '#features/sessions/status-store'
import { isSessionTerminating, deriveDeathCause } from '#features/sessions/state'
import type { TmuxLiveness } from '#features/sessions/cleanup'
import type { StaleSessionInfo } from '@yaac/shared/types'

/**
 * Split the pod list into the ones the renderer should show as active
 * sessions, the ones the caller should tear down, and implicitly (by
 * omission) the ones that are still inside the startup grace window.
 * Production callers pass `testEnv.startingGraceMs` for `graceMs`.
 */
export async function classifySessionPods(
  pods: SessionPod[],
  nowMs: number,
  probeLiveness: (slug: string, sessionId: string) => Promise<TmuxLiveness>,
  graceMs: number,
): Promise<{
  running: SessionPod[]
  stale: StaleSessionInfo[]
  indeterminate: SessionPod[]
  terminating: SessionPod[]
}> {
  const running: SessionPod[] = []
  const stale: StaleSessionInfo[] = []
  const indeterminate: SessionPod[] = []
  const terminating: SessionPod[] = []
  for (const p of pods) {
    // A pod on its way out (deletionTimestamp set, or a delete just issued)
    // is neither active nor stale: it renders as a "terminating…" row and is
    // already being torn down, so keep it out of both the probe path and the
    // reaper's targets.
    if (p.terminating || (!!p.sessionId && isSessionTerminating(p.sessionId))) {
      terminating.push(p)
      continue
    }
    if (p.running && p.projectSlug && p.sessionId) {
      const liveness = await probeLiveness(p.projectSlug, p.sessionId)
      if (liveness === 'alive') {
        running.push(p)
        continue
      }
      if (liveness === 'unknown') {
        // Inconclusive probe on a still-running pod — keep it. Reaping
        // here on a transient kubectl-exec failure would destroy a
        // healthy session (Job + vcluster, no recovery). It stays in the
        // running bucket; a genuinely dead pod is still caught later by
        // the pod-phase (running=false) and orphan-Job paths.
        running.push(p)
        indeterminate.push(p)
        continue
      }
      // liveness === 'dead' — fall through to stale classification.
    }

    const ageMs = p.createdAtMs > 0 ? nowMs - p.createdAtMs : Infinity
    if (ageMs < graceMs) continue

    // Classify the death while the evidence still exists: a zombie's pod is
    // healthy (only tmux died), a stopped pod carries terminal state.
    const zombie = p.running
    stale.push({
      jobName: p.jobName,
      projectSlug: p.projectSlug,
      sessionId: p.sessionId,
      zombie,
      deathCause: zombie ? { reason: 'agent-exited' } : deriveDeathCause(p),
    })
  }
  return { running, stale, indeterminate, terminating }
}

/**
 * Display-path tmux liveness, fed by the status watchers instead of a
 * probe: a healthy control-mode stream is conclusive proof the in-pod
 * tmux server is up; anything else is merely `unknown` (watcher still
 * connecting, respawning after a blip, server just started). Never
 * `dead` — display must not drop a session on stream state. Genuinely
 * dead sessions leave the list when their pod goes away (pod watch) or
 * when the stale reaper — which keeps its own conclusive probes —
 * tears them down.
 */
export function watcherDisplayLiveness(slug: string, sessionId: string): Promise<TmuxLiveness> {
  return Promise.resolve(isSessionStreamHealthy(slug, sessionId) ? 'alive' : 'unknown')
}
