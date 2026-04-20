import { getRpcClient as getRpcClientRaw, type GetClientOptions } from '@/shared/daemon-client'
import { authUpdate } from '@/commands/auth-update'

export { toClientError, exitOnClientError } from '@/shared/daemon-client'

/**
 * Command-side RPC client. Identical to `getRpcClient` from shared,
 * but pre-wires the interactive `authUpdate` flow as the daemon's
 * AUTH_REQUIRED recovery handler. Shared cannot reference
 * `@/commands/auth-update` directly (it would create a
 * `shared → commands` value edge blocked by the lint rule), so the
 * injection happens here.
 */
export function getRpcClient(opts: GetClientOptions = {}) {
  return getRpcClientRaw({
    onAuthRequired: authUpdate,
    ...opts,
  })
}
