import { z } from 'zod'
import type { CodexOAuthBundle } from '@yaac/shared/types'
import { CODEX_DEFAULT_REFRESH_WINDOW_MS, decodeJwtExp } from '@yaac/shared/tool-auth-interactive'
import { mayPresentRefreshToken } from './refresh-guard'

/** Codex's ChatGPT OAuth token endpoint, which the CLI (and running
 *  workspaces, through the proxy) use to refresh. */
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'

/** Codex's public OAuth client id (PKCE flow, no secret). Baked into the
 *  CLI; refresh grants must present it. */
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

const tokenResponseSchema = z.object({
  access_token: z.string().nullish(),
  refresh_token: z.string().nullish(),
  /** Codex returns an id_token instead of expires_in/scope; expiry comes
   *  from the access token's JWT `exp` claim. */
  id_token: z.string().nullish(),
})

/**
 * One refresh_token grant against Codex's OAuth token endpoint. Returns the
 * refreshed bundle, keeping stored values for fields the response omits.
 * Never throws: null covers every failure. (A stored Codex bundle always has
 * a refresh token, per codexOAuthBundleSchema.)
 *
 * Codex refresh tokens are single-use, so callers invoke this only after a
 * 401, to avoid racing a running workspace's own refresh through the proxy.
 */
export async function refreshCodexOAuthBundle(
  bundle: CodexOAuthBundle,
): Promise<CodexOAuthBundle | null> {
  if (!mayPresentRefreshToken(bundle.refreshToken)) return null
  try {
    const res = await fetch(CODEX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: bundle.refreshToken,
        client_id: CODEX_OAUTH_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return null
    const parsed = tokenResponseSchema.safeParse(await res.json())
    if (!parsed.success) return null
    const body = parsed.data
    const accessToken = body.access_token
    if (!accessToken) return null
    return {
      accessToken,
      refreshToken: body.refresh_token || bundle.refreshToken,
      idTokenRawJwt: body.id_token || bundle.idTokenRawJwt,
      expiresAt: decodeJwtExp(accessToken) ?? (Date.now() + CODEX_DEFAULT_REFRESH_WINDOW_MS),
      lastRefresh: new Date().toISOString(),
      accountId: bundle.accountId,
    }
  } catch {
    return null
  }
}
