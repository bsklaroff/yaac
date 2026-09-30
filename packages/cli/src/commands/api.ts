import { getApiClient } from '@yaac/shared/server-api'

/**
 * The API client every command uses. The server target resolves on the first
 * request, so importing this module reads no files.
 */
export const api = getApiClient()
