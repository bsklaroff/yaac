import crypto from 'node:crypto'
import { testEnv } from '@yaac/shared/env'

/**
 * The pieces of an OAuth authorization-code grant with PKCE (RFC 7636) that
 * both vendors' sign-ins share.
 */

/** A fresh verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** An unguessable `state`, which ties a redirect to the flow that asked. */
export function oauthState(): string {
  return crypto.randomBytes(32).toString('base64url')
}

/** A vendor URL as the sign-in flows dial it: under test, moved onto the
 *  fake vendor (testEnv.vendorOAuthOrigin) with its path and query kept. */
export function vendorUrl(url: string): string {
  const origin = testEnv.vendorOAuthOrigin
  if (!origin) return url
  const u = new URL(url)
  return `${origin.replace(/\/$/, '')}${u.pathname}${u.search}`
}

/** The error a vendor's non-2xx answer becomes, with whatever reason its
 *  body gives. */
export async function vendorError(what: string, res: Response): Promise<Error> {
  const body = await res.text().catch(() => '')
  let reason = body.slice(0, 300)
  try {
    const parsed = JSON.parse(body) as { error_description?: unknown; error?: unknown }
    const detail = parsed.error_description ?? parsed.error
    if (typeof detail === 'string') reason = detail
    else if (detail && typeof detail === 'object' && 'message' in detail) reason = String(detail.message)
  } catch { /* not JSON */ }
  return new Error(`${what} failed (HTTP ${res.status})${reason ? `: ${reason}` : ''}`)
}
