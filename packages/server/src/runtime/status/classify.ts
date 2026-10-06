import { isWorkspaceStreamHealthy } from './status-store'
import { isWorkspaceTerminating } from './terminating'
import type { ProbeTarget, TmuxLiveness } from './liveness'
import type { RuntimeHandle } from '#drivers/contract'
import type { StaleWorkspaceInfo } from '@yaac/shared/types'

/**
 * Split workspaces into those to show as active and those to tear down;
 * the rest (omitted) are still in the startup grace window. Production
 * passes `testEnv.startingGraceMs` as `graceMs`.
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
    // A terminating workspace is shown as "terminating…" and already being
    // torn down, so it is neither probed nor reaped.
    if (p.terminating || (!!p.workspaceId && isWorkspaceTerminating(p.workspaceId))) {
      terminating.push(p)
      continue
    }
    if (p.running && p.projectId && p.workspaceId) {
      const liveness = await probeLiveness(p)
      if (liveness === 'alive') {
        running.push(p)
        continue
      }
      if (liveness === 'unknown') {
        // Inconclusive probe on a running pod: keep it. Reaping on a transient
        // exec failure would destroy a healthy workspace; a really dead pod
        // is still caught by the pod-phase and orphan-Job paths.
        running.push(p)
        indeterminate.push(p)
        continue
      }
      // liveness === 'dead': classify as stale below.
    }

    const ageMs = p.createdAtMs > 0 ? nowMs - p.createdAtMs : Infinity
    if (ageMs < graceMs) continue

    // Record the cause while the evidence exists: a zombie's runtime is
    // healthy (only tmux died); a stopped one has a derived cause.
    const zombie = p.running
    stale.push({
      jobName: p.jobName,
      projectId: p.projectId,
      workspaceId: p.workspaceId,
      zombie,
      deathCause: zombie ? { reason: 'agent-exited' } : p.deathCause,
    })
  }
  return { running, stale, indeterminate, terminating }
}

/**
 * tmux liveness for display, from the status watchers rather than a probe:
 * a healthy control-mode stream proves tmux is up; anything else is
 * `unknown`. Never `dead`, so display never drops a workspace on stream
 * state; dead ones leave when their pod goes or the stale reaper (which runs
 * its own probes) removes them.
 */
export function watcherDisplayLiveness(target: ProbeTarget): Promise<TmuxLiveness> {
  return Promise.resolve(
    isWorkspaceStreamHealthy(target.projectId, target.workspaceId) ? 'alive' : 'unknown',
  )
}
