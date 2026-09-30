import { api } from './api'

/**
 * Allow a previously-blocked host for a workspace. `persist: false` widens only
 * the running workspace's live allowlist; `persist: true` also writes the host
 * into the project's yaac-config.json so future workspaces inherit it. Either way
 * the proxy unblocks the host immediately and the server pushes a fresh
 * snapshot, so the blocked-hosts badge updates on its own.
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
