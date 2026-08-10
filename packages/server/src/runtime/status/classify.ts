import { type PodInfo } from '#platform/k8s'
import { isWorktreeStreamHealthy } from './status-store'
import { isWorktreeTerminating } from './terminating'
import type { TmuxLiveness } from './liveness'
import type { WorktreeDeathCause, StaleWorktreeInfo } from '@yaac/shared/types'

/**
 * Derive why a stopped worktree pod died from its captured terminal state
 * (`PodInfo.terminal`). This runs at reap time — the last moment the
 * evidence exists, since the reaper's own teardown deletes the Job and pod.
 * Only the pod-stopped family is derived here; reap classifications the
 * pod can't express (tmux gone, placeholder pane, orphan Job) are supplied
 * directly by the reap sites that detected them.
 */
function deriveDeathCause(pod: PodInfo): WorktreeDeathCause {
  const t = pod.terminal
  if (t?.containerReason === 'OOMKilled') {
    return {
      reason: 'oom',
      ...(t.exitCode !== undefined ? { detail: `exit code ${t.exitCode}` } : {}),
    }
  }
  if (t?.podReason === 'Evicted') {
    return { reason: 'evicted', ...(t.podMessage ? { detail: t.podMessage } : {}) }
  }
  if (t?.exitCode !== undefined && t.exitCode !== 0) {
    // kubelet's generic terminated reason for a nonzero exit is 'Error' —
    // it adds nothing over the exit code; any other reason is kept.
    const parts = [`exit code ${t.exitCode}`]
    if (t.containerReason && t.containerReason !== 'Error') parts.push(t.containerReason)
    return { reason: 'crashed', detail: parts.join(', ') }
  }
  return { reason: 'pod-stopped' }
}

/**
 * Split the pod list into the ones the renderer should show as active
 * worktrees, the ones the caller should tear down, and implicitly (by
 * omission) the ones that are still inside the startup grace window.
 * Production callers pass `testEnv.startingGraceMs` for `graceMs`.
 */
export async function classifyWorktreePods(
  pods: PodInfo[],
  nowMs: number,
  probeLiveness: (slug: string, worktreeId: string) => Promise<TmuxLiveness>,
  graceMs: number,
): Promise<{
  running: PodInfo[]
  stale: StaleWorktreeInfo[]
  indeterminate: PodInfo[]
  terminating: PodInfo[]
}> {
  const running: PodInfo[] = []
  const stale: StaleWorktreeInfo[] = []
  const indeterminate: PodInfo[] = []
  const terminating: PodInfo[] = []
  for (const p of pods) {
    // A pod on its way out (deletionTimestamp set, or a delete just issued)
    // is neither active nor stale: it renders as a "terminating…" row and is
    // already being torn down, so keep it out of both the probe path and the
    // reaper's targets.
    if (p.terminating || (!!p.worktreeId && isWorktreeTerminating(p.worktreeId))) {
      terminating.push(p)
      continue
    }
    if (p.running && p.projectSlug && p.worktreeId) {
      const liveness = await probeLiveness(p.projectSlug, p.worktreeId)
      if (liveness === 'alive') {
        running.push(p)
        continue
      }
      if (liveness === 'unknown') {
        // Inconclusive probe on a still-running pod — keep it. Reaping
        // here on a transient kubectl-exec failure would destroy a
        // healthy worktree (Job + vcluster, no recovery). It stays in the
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
      worktreeId: p.worktreeId,
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
 * `dead` — display must not drop a worktree on stream state. Genuinely
 * dead worktrees leave the list when their pod goes away (pod watch) or
 * when the stale reaper — which keeps its own conclusive probes —
 * tears them down.
 */
export function watcherDisplayLiveness(slug: string, worktreeId: string): Promise<TmuxLiveness> {
  return Promise.resolve(isWorktreeStreamHealthy(slug, worktreeId) ? 'alive' : 'unknown')
}
