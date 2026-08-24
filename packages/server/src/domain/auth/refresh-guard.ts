import { testEnv } from '@yaac/shared/env'
import { PLACEHOLDER_REFRESH_TOKEN } from '@yaac/shared/tool-auth'
import { serverLog } from '#log'

/**
 * Whether this server may present `refreshToken` in an OAuth refresh grant.
 *
 * A refresh grant is the one upstream call that MUTATES the credential: the
 * old refresh token is spent and a new one issued. Whoever holds the old copy
 * and does not learn the new one is signed out. That makes "may we send this
 * at all" a question worth asking before every grant, and asking it here —
 * at the two grants themselves — rather than at their callers, so a future
 * caller cannot reintroduce the hazard by not knowing about it.
 *
 * Two answers are no.
 *
 * A sentinel refresh token is never ours to spend. It means the real
 * credential belongs to an install above this one, which hands this server a
 * placeholder and swaps it on the way out (docs/containerless-driver.md, and
 * `buildFakeClaudeOAuthBundle` for the chained yaac-in-yaac case). Presenting
 * it would make the OUTER install's proxy substitute the real token and
 * rotate it — while this server, which receives sentinels back, learns
 * nothing and stores nothing. The outer store keeps the spent token and every
 * worktree using it fails on its next refresh. Refreshing a credential we do
 * not own is the upstream install's job, never ours.
 *
 * Under test, no grant may go out at all. The reason is the same mechanism
 * seen from the other side: the proxy rewrites the `refresh_token` body param
 * of anything POSTed to a token endpoint without checking what the request
 * carried, so a suite running inside a mediated worktree rotates the real
 * credential no matter how obviously fake the token it presented. Fixture
 * expiries are not a defense — they only decide WHETHER a refresh is
 * attempted, and any attempt is already the damage.
 */
export function mayPresentRefreshToken(refreshToken: string): boolean {
  if (refreshToken === PLACEHOLDER_REFRESH_TOKEN) {
    serverLog(
      '[server] declining an OAuth refresh: the stored credential is a placeholder, '
      + 'so the real one belongs to the install that swaps it.',
    )
    return false
  }
  if (testEnv.noTokenRefresh) {
    serverLog('[server] declining an OAuth refresh: YAAC_E2E_NO_TOKEN_REFRESH is set.')
    return false
  }
  return true
}
