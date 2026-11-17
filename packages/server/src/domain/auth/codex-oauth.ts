import { z } from 'zod'
import type { CodexOAuthBundle } from '@yaac/shared/types'
import { CODEX_DEFAULT_REFRESH_WINDOW_MS, decodeJwtExp, decodeJwtPayload } from '@yaac/shared/tool-auth-interactive'
import { mayPresentRefreshToken } from './refresh-guard'
import { vendorError, vendorUrl } from './oauth-pkce'

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

/** Codex's OAuth issuer, which hosts its authorize page and device flow. */
const CODEX_ISSUER = 'https://auth.openai.com'

/** The loopback redirect `codex login` registers: a fixed port. */
export const CODEX_LOOPBACK_REDIRECT_URI = 'http://127.0.0.1:1455/auth/callback'

/** The redirect a device-code grant's exchange names. */
const CODEX_DEVICE_REDIRECT_URI = `${CODEX_ISSUER}/deviceauth/callback`

/** The authorize URL `codex login` opens, with the same parameters. */
export function codexAuthorizeUrl(opts: { challenge: string; state: string }): string {
  const url = new URL(vendorUrl(`${CODEX_ISSUER}/oauth/authorize`))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', CODEX_OAUTH_CLIENT_ID)
  url.searchParams.set('redirect_uri', CODEX_LOOPBACK_REDIRECT_URI)
  url.searchParams.set('code_challenge', opts.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', opts.state)
  url.searchParams.set('scope', 'openid profile email offline_access api.connectors.read api.connectors.invoke')
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('originator', 'codex_cli_rs')
  return url.toString()
}

const exchangeResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  id_token: z.string().min(1),
})

/** Trade an authorization code for the bundle Codex stores, as `codex
 *  login` does (a form-encoded grant). Throws with the vendor's reason. */
async function exchangeCodexCode(opts: { code: string; verifier: string; redirectUri: string }): Promise<CodexOAuthBundle> {
  const res = await fetch(vendorUrl(CODEX_TOKEN_URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: opts.redirectUri,
      client_id: CODEX_OAUTH_CLIENT_ID,
      code_verifier: opts.verifier,
    }).toString(),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw await vendorError('Codex sign-in', res)
  const parsed = exchangeResponseSchema.safeParse(await res.json())
  if (!parsed.success) throw new Error('Codex sign-in returned no tokens.')
  const body = parsed.data
  // Codex keeps the id_token's ChatGPT account id as `tokens.account_id`.
  const claims = decodeJwtPayload(body.id_token)?.['https://api.openai.com/auth']
  const accountId = claims && typeof claims === 'object' && 'chatgpt_account_id' in claims
    && typeof claims.chatgpt_account_id === 'string' ? claims.chatgpt_account_id : undefined
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    idTokenRawJwt: body.id_token,
    expiresAt: decodeJwtExp(body.access_token) ?? (Date.now() + CODEX_DEFAULT_REFRESH_WINDOW_MS),
    lastRefresh: new Date().toISOString(),
    accountId,
  }
}

/** Exchange the code a loopback redirect carried. */
export function exchangeCodexLoopbackCode(code: string, verifier: string): Promise<CodexOAuthBundle> {
  return exchangeCodexCode({ code, verifier, redirectUri: CODEX_LOOPBACK_REDIRECT_URI })
}

/** A device code to show the user, and how to ask whether they entered it. */
export interface CodexDeviceCode {
  deviceAuthId: string
  userCode: string
  /** The page the user enters `userCode` on. */
  verificationUrl: string
  /** How long to wait between polls. */
  intervalMs: number
}

const userCodeSchema = z.object({
  device_auth_id: z.string().min(1),
  user_code: z.string().min(1).optional(),
  usercode: z.string().min(1).optional(),
  interval: z.union([z.number(), z.string()]).optional(),
})

/** Start Codex's device-code sign-in (`codex login --device-auth`). Throws
 *  when Codex refuses, which it does for an account with device codes off. */
export async function requestCodexDeviceCode(): Promise<CodexDeviceCode> {
  const res = await fetch(vendorUrl(`${CODEX_ISSUER}/api/accounts/deviceauth/usercode`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const err = await vendorError('Requesting a Codex device code', res)
    throw new Error(`${err.message}. Device-code sign-in may be turned off for this account in ChatGPT's `
      + 'security settings; signing in from the yaac desktop app or `yaac auth update` on a laptop needs no device code.')
  }
  const parsed = userCodeSchema.safeParse(await res.json())
  const userCode = parsed.data?.user_code ?? parsed.data?.usercode
  if (!parsed.success || !userCode) throw new Error('Codex returned no device code.')
  // Seconds; floored so a bad answer can't make the poll spin.
  const interval = Number(parsed.data.interval ?? 5)
  return {
    deviceAuthId: parsed.data.device_auth_id,
    userCode,
    verificationUrl: vendorUrl(`${CODEX_ISSUER}/codex/device`),
    intervalMs: Math.max(Number.isFinite(interval) ? interval : 5, 0.25) * 1000,
  }
}

const deviceTokenSchema = z.object({
  authorization_code: z.string().min(1),
  code_verifier: z.string().min(1),
})

/** One poll of a device code: the bundle once the user has entered it,
 *  null while they haven't. Throws on any other answer. */
export async function pollCodexDeviceCode(device: CodexDeviceCode): Promise<CodexOAuthBundle | null> {
  const res = await fetch(vendorUrl(`${CODEX_ISSUER}/api/accounts/deviceauth/token`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
    signal: AbortSignal.timeout(30_000),
  })
  // Codex answers 403 or 404 until the code is entered.
  if (res.status === 403 || res.status === 404) return null
  if (!res.ok) throw await vendorError('Codex device sign-in', res)
  const parsed = deviceTokenSchema.safeParse(await res.json())
  if (!parsed.success) throw new Error('Codex device sign-in returned no authorization code.')
  return exchangeCodexCode({
    code: parsed.data.authorization_code,
    verifier: parsed.data.code_verifier,
    redirectUri: CODEX_DEVICE_REDIRECT_URI,
  })
}
