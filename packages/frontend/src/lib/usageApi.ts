import { api } from './api'

/**
 * Ask the server to refresh plan usage, when the usage popover opens. The
 * server ignores requests within a minute of its last refresh. New numbers
 * arrive in the snapshot, not in this response.
 */
export async function requestUsageRefresh(): Promise<void> {
  await api.auth.claude.usage.refresh.$post()
}
