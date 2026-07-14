import { api } from './api'

/**
 * Allow a previously-blocked host for a session. `persist: false` widens only
 * the running session's live allowlist; `persist: true` also writes the host
 * into the project's yaac-config.json so future sessions inherit it. Either way
 * the proxy unblocks the host immediately and the server pushes a fresh
 * snapshot, so the blocked-hosts badge updates on its own.
 */
export async function allowBlockedHost(
  sessionId: string,
  host: string,
  opts: { persist: boolean },
): Promise<void> {
  await api.session[':id']['allow-host'].$post({
    param: { id: sessionId },
    json: { host, persist: opts.persist },
  })
}
