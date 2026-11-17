import { z } from 'zod'
import type { ClaudeOAuthBundle } from '@yaac/shared/types'
import { mayPresentRefreshToken } from './refresh-guard'
import { vendorError, vendorUrl } from './oauth-pkce'
import { CLAUDE_PROFILE_URL } from './usage'

/** Claude Code's OAuth token endpoint, also used by in-workspace refreshes
 *  through the proxy. */
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
 * the refreshed bundle, keeping stored values for fields the response omits
 * (as the proxy's refresh capture does). Never throws: null covers every
 * failure, including a bundle with no refresh token.
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

/** Claude Code's authorize page for a Claude subscription sign-in. */
const CLAUDE_AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize'

/** The redirect that shows the user a `code#state` to paste back, for a
 *  browser with no loopback listener on its machine. */
export const CLAUDE_MANUAL_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback'

/** A loopback redirect: Claude's client takes any port. */
export function claudeLoopbackRedirectUri(port: number): string {
  return `http://localhost:${port}/callback`
}

/** The scopes `claude auth login` asks for. */
const CLAUDE_SCOPES = [
  'org:create_api_key', 'user:profile', 'user:inference', 'user:sessions:claude_code',
  'user:mcp_servers', 'user:file_upload', 'user:plugins',
]

/** Claude's `organization_type` to the CLI's subscriptionType. */
const SUBSCRIPTION_TYPES: Record<string, string> = {
  claude_max: 'max',
  claude_pro: 'pro',
  claude_enterprise: 'enterprise',
  claude_team: 'team',
}

/** The authorize URL `claude auth login` opens, with the same parameters. */
export function claudeAuthorizeUrl(opts: { challenge: string; state: string; redirectUri: string }): string {
  const url = new URL(vendorUrl(CLAUDE_AUTHORIZE_URL))
  url.searchParams.set('code', 'true')
  url.searchParams.set('client_id', CLAUDE_OAUTH_CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', opts.redirectUri)
  url.searchParams.set('scope', CLAUDE_SCOPES.join(' '))
  url.searchParams.set('code_challenge', opts.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', opts.state)
  return url.toString()
}

const profileSchema = z.object({
  organization: z.object({ organization_type: z.string().nullish() }).nullish(),
})

/** The plan the token's org is on, as Claude Code records it; undefined
 *  when the profile can't say, which Claude Code tolerates. */
async function claudeSubscriptionType(accessToken: string): Promise<string | undefined> {
  try {
    const res = await fetch(vendorUrl(CLAUDE_PROFILE_URL), {
      headers: { 'Authorization': `Bearer ${accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return undefined
    const type = profileSchema.safeParse(await res.json()).data?.organization?.organization_type
    return type ? SUBSCRIPTION_TYPES[type] : undefined
  } catch {
    return undefined
  }
}

/** Trade an authorization code for the bundle Claude Code stores. Throws
 *  with the vendor's reason. */
export async function exchangeClaudeCode(opts: {
  code: string
  state: string
  verifier: string
  redirectUri: string
}): Promise<ClaudeOAuthBundle> {
  const res = await fetch(vendorUrl(CLAUDE_TOKEN_URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: opts.redirectUri,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      code_verifier: opts.verifier,
      state: opts.state,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw await vendorError('Claude sign-in', res)
  const parsed = tokenResponseSchema.safeParse(await res.json())
  if (!parsed.success) throw new Error('Claude sign-in returned no access token.')
  const body = parsed.data
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? '',
    expiresAt: Date.now() + (body.expires_in ?? 8 * 60 * 60) * 1000,
    scopes: body.scope ? body.scope.split(' ').filter(Boolean) : CLAUDE_SCOPES,
    subscriptionType: await claudeSubscriptionType(body.access_token),
  }
}
