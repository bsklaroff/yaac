import type { SessionPod } from '#lib/k8s/pods'
import type { SessionDeathCause } from '@yaac/shared/types'

/**
 * Derive why a stopped session pod died from its captured terminal state
 * (`SessionPod.terminal`). This runs at reap time — the last moment the
 * evidence exists, since the reaper's own teardown deletes the Job and pod.
 * Only the pod-stopped family is derived here; reap classifications the
 * pod can't express (tmux gone, placeholder pane, orphan Job) are supplied
 * directly by the reap sites that detected them.
 */
export function deriveDeathCause(pod: SessionPod): SessionDeathCause {
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
