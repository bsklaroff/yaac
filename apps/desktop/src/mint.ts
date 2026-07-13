/**
 * Mint a one-time exchange token — the same POST /tokens call `yaac open`
 * makes. Runs on the shared typed client, so target resolution (enabled
 * remote.json, else the local lock), the bearer header, and BAD_BEARER
 * re-resolve/retry all come from @yaac/shared/server-client — minus the
 * build-id checks (`requireBuildMatch: false`): the shell is a pure
 * client with no build identity of its own.
 */
import { getRpcClient, type GetClientOptions } from '@yaac/shared/server-client'

export async function mintWebToken(opts: GetClientOptions = {}): Promise<string> {
  // Forced off, not defaulted: the shell ships no server code, so no
  // caller of this package ever has a build id to match.
  const client = await getRpcClient({ ...opts, requireBuildMatch: false })
  const { token } = await client.tokens.$post({ json: { kind: 'one-time' } }).then((r) => r.json())
  return token
}
