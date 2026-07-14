/**
 * Mint a one-time exchange token — the same POST /tokens call `yaac open`
 * makes. Runs on the shared typed client, so target resolution (enabled
 * remote.json, else the local lock), the bearer header, and BAD_BEARER
 * re-resolve/retry all come from @yaac/shared/server-api — minus the
 * build-id checks (`requireBuildMatch: false`): the shell is a pure
 * client with no build identity of its own.
 */
import { getApiClient, type ApiClientOptions } from '@yaac/shared/server-api'

export async function mintWebToken(opts: ApiClientOptions = {}): Promise<string> {
  // Forced off, not defaulted: the shell ships no server code, so no
  // caller of this package ever has a build id to match.
  const client = getApiClient({ ...opts, requireBuildMatch: false })
  const { token } = await client.tokens.$post({ json: { kind: 'one-time' } })
  return token
}
