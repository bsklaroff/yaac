import { getApiClient } from '@yaac/shared/server-api'

/**
 * The command-side API client — a ready-to-use singleton, built by the
 * shared `getApiClient` (lazy target resolution, bearer auth,
 * throw-on-error, unwrap-on-success). The target resolves lazily on the
 * first request, so importing this module never touches the lock/remote
 * files.
 */
export const api = getApiClient()
