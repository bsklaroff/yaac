import { isPrewarmed, type PodInfo } from '#drivers/k8s/substrate'
import { AGENT_TOOLS, normalizeTool } from '@yaac/shared/types'
import type { RuntimeHandle } from '#drivers/contract'
import type { WorktreeDeathCause } from '@yaac/shared/types'

/**
 * Where a pod becomes contract vocabulary — the k8s runtime's one boundary
 * mapper (docs/layered-server.md).
 *
 * Above `drivers/k8s`, a workspace is a `RuntimeHandle` and nothing else;
 * this is the only place that knows one is really a pod carrying label
 * strings, a phase and kubelet's terminal state. It sits outside the sealed
 * folders because both the observation folder and the pass snapshot need
 * it, and putting it in either would make the other import across a seal.
 */
export function runtimeHandleFromPod(pod: PodInfo): RuntimeHandle {
  return {
    workspaceId: pod.worktreeId,
    projectSlug: pod.projectSlug,
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
 * Why a stopped pod died, from its captured terminal state.
 *
 * Derived here, with the rest of the mapping, because the raw evidence is
 * shaped like Kubernetes — an OOMKilled container reason, an Evicted pod
 * reason, a container exit code — and the reaper above wants the verdict,
 * not the vocabulary. Only the pod-stopped family is derived; the
 * classifications a pod cannot express (tmux gone, placeholder pane, orphan
 * unit) are supplied by the sites that detect them.
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
