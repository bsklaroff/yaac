import { isWorkspaceStreamHealthy } from './status-store'
import { isWorkspaceTerminating } from './terminating'
import type { ProbeTarget, TmuxLiveness } from './liveness'
import type { RuntimeHandle } from '#drivers/contract'
import type { StaleWorkspaceInfo } from '@yaac/shared/types'

/**
 * Split the workspace list into the ones the renderer should show as active
 * workspaces, the ones the caller should tear down, and implicitly (by
 * omission) the ones that are still inside the startup grace window.
 * Production callers pass `testEnv.startingGraceMs` for `graceMs`.
 */
export async function classifyWorkspaces(
  workspaces: RuntimeHandle[],
  nowMs: number,
  probeLiveness: (target: ProbeTarget) => Promise<TmuxLiveness>,
  graceMs: number,
): Promise<{
  running: RuntimeHandle[]
  stale: StaleWorkspaceInfo[]
  indeterminate: RuntimeHandle[]
  terminating: RuntimeHandle[]
}> {
  const running: RuntimeHandle[] = []
  const stale: StaleWorkspaceInfo[] = []
  const indeterminate: RuntimeHandle[] = []
  const terminating: RuntimeHandle[] = []
  for (const p of workspaces) {
    // A workspace on its way out (deletionTimestamp set, or a delete just issued)
    // is neither active nor stale: it renders as a "terminating…" row and is
    // already being torn down, so keep it out of both the probe path and the
    // reaper's targets.
    if (p.terminating || (!!p.workspaceId && isWorkspaceTerminating(p.workspaceId))) {
      terminating.push(p)
      continue
    }
    if (p.running && p.projectSlug && p.workspaceId) {
      const liveness = await probeLiveness(p)
      if (liveness === 'alive') {
        running.push(p)
        continue
      }
      if (liveness === 'unknown') {
        // Inconclusive probe on a still-running pod — keep it. Reaping
        // here on a transient kubectl-exec failure would destroy a
        // healthy workspace (Job and all, no recovery). It stays in the
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

    // Classify the death while the evidence still exists: a zombie's runtime
    // is healthy (only tmux died), a stopped one carries a derived cause.
    const zombie = p.running
    stale.push({
      jobName: p.jobName,
      projectSlug: p.projectSlug,
      workspaceId: p.workspaceId,
      zombie,
      deathCause: zombie ? { reason: 'agent-exited' } : p.deathCause,
    })
  }
  return { running, stale, indeterminate, terminating }
}

/**
 * Display-path tmux liveness, fed by the status watchers instead of a
 * probe: a healthy control-mode stream is conclusive proof the in-pod
 * tmux server is up; anything else is merely `unknown` (watcher still
 * connecting, respawning after a blip, server just started). Never
 * `dead` — display must not drop a workspace on stream state. Genuinely
 * dead workspaces leave the list when their pod goes away (pod watch) or
 * when the stale reaper — which keeps its own conclusive probes —
 * tears them down.
 */
export function watcherDisplayLiveness(target: ProbeTarget): Promise<TmuxLiveness> {
  return Promise.resolve(
    isWorkspaceStreamHealthy(target.projectSlug, target.workspaceId) ? 'alive' : 'unknown',
  )
}
