import { z } from 'zod'
import type { CodexOAuthBundle } from '@yaac/shared/types'
import { mayPresentRefreshToken } from './refresh-guard'

/** Codex's ChatGPT OAuth token endpoint — the same one the CLI (and, through
 *  the proxy, running sessions) hit to refresh. */
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'

/** Codex's public OAuth client id (PKCE flow, no secret). Baked into the
 *  CLI; refresh grants must present it. */
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

/** Codex's proactive-refresh window — the fallback expiry when a refreshed
 *  access token carries no decodable `exp`, matching the proxy's capture. */
const CODEX_DEFAULT_REFRESH_WINDOW_MS = 28 * 24 * 60 * 60 * 1000

const tokenResponseSchema = z.object({
  access_token: z.string().nullish(),
  refresh_token: z.string().nullish(),
  /** Codex's token response carries an id_token instead of expires_in/scope;
   *  expiry is derived from the new access token's JWT `exp` claim. */
  id_token: z.string().nullish(),
})

/** Read the `exp` claim (seconds since epoch) from a JWT and return it as
 *  epoch ms. Null for anything unparseable or missing. */
function decodeJwtExpMs(jwt: string): number | null {
  const parts = jwt.split('.')
  if (parts.length < 2) return null
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (payload && typeof payload === 'object') {
      const exp = (payload as Record<string, unknown>).exp
      if (typeof exp === 'number' && Number.isFinite(exp)) return exp * 1000
    }
  } catch {
    // fall through
  }
  return null
}

/**
 * One refresh_token grant against Codex's OAuth token endpoint. Returns the
 * refreshed bundle, merged the way the proxy's session-refresh capture
 * merges (fields the response omits keep their stored values). Never throws
 * — null covers every failure.
 *
 * Unlike Claude's bundle, a stored Codex bundle always carries a refresh
 * token (codexOAuthBundleSchema requires a non-empty one), so there is no
 * bare-access-token case to guard against here.
 *
 * Codex refresh tokens rotate (single-use); the caller only invokes this
 * reactively on a 401, so it never races a running session's own refresh
 * (which keeps the host token fresh through the proxy).
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
      expiresAt: decodeJwtExpMs(accessToken) ?? (Date.now() + CODEX_DEFAULT_REFRESH_WINDOW_MS),
      lastRefresh: new Date().toISOString(),
      accountId: bundle.accountId,
    }
  } catch {
    return null
  }
}
