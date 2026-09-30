import { api } from './api'

/**
 * Allow a blocked host for a workspace. `persist: false` changes only the
 * running workspace's allowlist; `persist: true` also writes the host into
 * the project's yaac-config.json so future workspaces inherit it. The server
 * then pushes a snapshot, which updates the blocked-hosts badge.
 */
export async function allowBlockedHost(
  workspaceId: string,
  host: string,
  opts: { persist: boolean },
): Promise<void> {
  await api.workspace[':id']['allow-host'].$post({
    param: { id: workspaceId },
    json: { host, persist: opts.persist },
  })
}
