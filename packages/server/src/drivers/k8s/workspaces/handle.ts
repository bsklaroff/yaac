import { isPrewarmed, type PodInfo } from '#drivers/k8s/substrate'
import { AGENT_TOOLS, normalizeTool } from '@yaac/shared/types'
import type { RuntimeHandle } from '#drivers/contract'
import type { WorkspaceDeathCause } from '@yaac/shared/types'

/**
 * Map a pod to the contract's `RuntimeHandle`. Code above `drivers/k8s`
 * sees only handles; this is the one place that reads pod labels, phase and
 * terminal state (docs/layered-server.md).
 */
export function runtimeHandleFromPod(pod: PodInfo): RuntimeHandle {
  return {
    workspaceId: pod.workspaceId,
    projectId: pod.projectId,
    jobName: pod.jobName,
    tool: normalizeTool(pod.tool),
    ...((AGENT_TOOLS as readonly string[]).includes(pod.tool)
      ? { declaredTool: normalizeTool(pod.tool) }
      : {}),
    mode: pod.mode === 'acp' ? 'acp' : 'tui',
    running: pod.running,
    state: pod.running ? 'running' : pod.phase.toLowerCase(),
    labels: pod.labels,
    createdAtMs: pod.createdAtMs,
    prewarmed: isPrewarmed(pod),
    terminating: pod.terminating,
    deathCause: deriveDeathCause(pod),
  }
}

/**
 * Why a stopped pod died, from its terminal state (OOMKilled, Evicted, exit
 * code). Only pod-level causes are derived here; others (tmux gone,
 * placeholder pane, orphan unit) come from the code that detects them.
 */
function deriveDeathCause(pod: PodInfo): WorkspaceDeathCause {
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
    // kubelet's generic reason for a nonzero exit is 'Error', which adds
    // nothing over the code.
    const parts = [`exit code ${t.exitCode}`]
    if (t.containerReason && t.containerReason !== 'Error') parts.push(t.containerReason)
    return { reason: 'crashed', detail: parts.join(', ') }
  }
  return { reason: 'pod-stopped' }
}
