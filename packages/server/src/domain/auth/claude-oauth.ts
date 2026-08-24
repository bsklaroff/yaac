import { z } from 'zod'
import type { ClaudeOAuthBundle } from '@yaac/shared/types'
import { mayPresentRefreshToken } from './refresh-guard'

/** Claude Code's OAuth token endpoint — the same one session refresh
 *  traffic hits through the proxy. */
export const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'

/** Claude Code's public OAuth client id (PKCE flow, no secret). Baked into
 *  the CLI; refresh grants must present it. */
export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().nullish(),
  /** Lifetime in seconds. */
  expires_in: z.number().nullish(),
  /** Space-separated scope list. */
  scope: z.string().nullish(),
})

/**
 * One refresh_token grant against the Claude OAuth token endpoint. Returns
 * the refreshed bundle, merged the same way the proxy's session-refresh
 * capture merges (fields the response omits keep their stored values).
 * Never throws — null covers every failure, including a bundle that has no
 * refresh token to present (the bare-access-token save path).
 */
export async function refreshClaudeOAuthBundle(
  bundle: ClaudeOAuthBundle,
): Promise<ClaudeOAuthBundle | null> {
  if (!bundle.refreshToken) return null
  if (!mayPresentRefreshToken(bundle.refreshToken)) return null
  try {
    const res = await fetch(CLAUDE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: bundle.refreshToken,
        client_id: CLAUDE_OAUTH_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return null
    const parsed = tokenResponseSchema.safeParse(await res.json())
    if (!parsed.success) return null
    const body = parsed.data
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token || bundle.refreshToken,
      expiresAt: typeof body.expires_in === 'number'
        ? Date.now() + body.expires_in * 1000
        : bundle.expiresAt,
      scopes: typeof body.scope === 'string'
        ? body.scope.split(' ').filter(Boolean)
        : bundle.scopes,
      subscriptionType: bundle.subscriptionType,
    }
  } catch {
    return null
  }
}
