import type { SessionDeathReason } from '#types'

/**
 * The one human-copy mapping for session death reasons, shared by the
 * frontend and the CLI so both render identical text. `detail` (exit code,
 * eviction message, …) is appended after an em-dash when present.
 */
const DEATH_REASON_COPY: Record<SessionDeathReason, string> = {
  'oom': 'out of memory (hit the session memory limit)',
  'evicted': 'evicted by the node',
  'crashed': 'crashed',
  'pod-stopped': 'container stopped',
  'agent-exited': 'agent exited',
  'never-started': 'agent never started',
  'orphaned': 'removed outside yaac',
}

export function describeSessionDeathReason(
  reason: SessionDeathReason,
  detail?: string,
): string {
  const copy = DEATH_REASON_COPY[reason] ?? reason
  return detail ? `${copy} — ${detail}` : copy
}
