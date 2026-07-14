import { getApiClient } from '@yaac/shared/server-api'
import { authUpdate } from '#commands/auth-update'

/**
 * The command-side API client — a ready-to-use singleton. Built by the shared
 * `getApiClient` (lazy target resolution, bearer auth, throw-on-error,
 * unwrap-on-success) with the interactive `authUpdate` flow pre-wired as the
 * server's AUTH_REQUIRED recovery handler: shared cannot reference
 * `#commands/auth-update` directly (a `shared → commands` value edge the lint
 * rule blocks), so the injection happens here. The target resolves lazily on
 * the first request, so importing this module never touches the lock/remote
 * files.
 */
export const api = getApiClient({ onAuthRequired: authUpdate })
