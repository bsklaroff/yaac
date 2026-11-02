import type { WorkspaceDeathReason } from '#types'

/** Display text for workspace death reasons, shared by the frontend and CLI. */
const DEATH_REASON_COPY: Record<WorkspaceDeathReason, string> = {
  'oom': 'out of memory (hit the workspace memory limit)',
  'evicted': 'evicted by the node',
  'crashed': 'crashed',
  'pod-stopped': 'container stopped',
  // Its tmux server exited. A session's agent exiting never ends its
  // workspace (docs/sessions.md); the key predates that.
  'agent-exited': 'its tmux server exited',
  'never-started': 'its setup never finished',
  'orphaned': 'removed outside yaac',
}

export function describeWorkspaceDeathReason(
  reason: WorkspaceDeathReason,
  detail?: string,
): string {
  const copy = DEATH_REASON_COPY[reason] ?? reason
  return detail ? `${copy} — ${detail}` : copy
}
