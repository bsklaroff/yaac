import { testEnv } from '@yaac/shared/env'
import { PLACEHOLDER_REFRESH_TOKEN } from '@yaac/shared/tool-auth'
import { serverLog } from '#log'

/**
 * Whether this server may present `refreshToken` in an OAuth refresh grant.
 * A grant spends the old refresh token, so anyone still holding it is signed
 * out. The check lives at the grants themselves so no caller can skip it.
 *
 * Refused in two cases:
 *
 * A placeholder refresh token means the real credential belongs to an outer
 * install that swaps it in on the way out (docs/containerless-driver.md;
 * `buildFakeClaudeOAuthBundle` for yaac-in-yaac). Presenting it would make
 * the outer proxy rotate the real token while this server learns nothing,
 * breaking every workspace that uses it.
 *
 * Under test, no grant goes out. The proxy rewrites `refresh_token` in any
 * POST to a token endpoint, so a suite inside a mediated workspace would
 * rotate the real credential even with a fake token.
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
