import { api } from './api'

/**
 * Nudge the server to refresh plan usage now — fired when the usage popover
 * opens. The server ignores nudges within a minute of its last refresh, and
 * the refreshed numbers arrive via the pushed snapshot (not this response).
 */
export async function requestUsageRefresh(): Promise<void> {
  await api.auth.claude.usage.refresh.$post()
}
