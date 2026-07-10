import { api } from '@/frontend/lib/apiClient'

/**
 * Nudge the daemon to refresh plan usage now — fired when the usage popover
 * opens. The daemon ignores nudges within a minute of its last refresh, and
 * the refreshed numbers arrive via the pushed snapshot (not this response).
 */
export function requestUsageRefresh(): Promise<void> {
  return api.post<void>('/auth/claude/usage/refresh')
}
