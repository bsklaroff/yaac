/**
 * The OAuth refresh swap: a workspace refreshes with the placeholder refresh
 * token, the proxy spends the real one, captures the rotation, and answers
 * with placeholders (docs/workspace-egress.md).
 */

import type http from 'node:http'
import zlib from 'node:zlib'
import type { ProxyObjects } from './object-watch'
import type { ClaudeOAuthBundle, CodexOAuthBundle, RefreshedBundles } from './objects'
import { PLACEHOLDER_ACCESS_TOKEN, PLACEHOLDER_REFRESH_TOKEN } from './injection'

const CODEX_DEFAULT_REFRESH_WINDOW_MS = 28 * 24 * 60 * 60 * 1000

/** Decode a JWT's payload and return `exp` as unix epoch ms, or null. */
function decodeJwtExp(jwt: string): number | null {
  try {
    const parts = jwt.split('.')
    if (parts.length !== 3) return null
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (!payload || typeof payload !== 'object') return null
    const exp = (payload as Record<string, unknown>).exp
    if (typeof exp !== 'number') return null
    return exp * 1000
  } catch {
    return null
  }
}

/** Parse a JSON body, or null if it is not JSON. */
function tryParseJsonBody(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    return null
  }
}

/**
 * Decompress a body by its Content-Encoding, or null for an unknown encoding
 * so the caller can pass the bytes through.
 */
function decodeBody(raw: Buffer, encoding: string | string[] | undefined): Buffer | null {
  if (!encoding) return raw
  const enc = Array.isArray(encoding) ? encoding[0].toLowerCase() : encoding.toLowerCase()
  if (enc === 'identity') return raw
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(raw)
  if (enc === 'br') return zlib.brotliDecompressSync(raw)
  if (enc === 'deflate') return zlib.inflateSync(raw)
  return null
}

/** Re-encode a buffer with the given Content-Encoding. */
function encodeBody(raw: Buffer, encoding: string | string[] | undefined): Buffer {
  if (!encoding) return raw
  const enc = Array.isArray(encoding) ? encoding[0].toLowerCase() : encoding.toLowerCase()
  if (enc === 'identity') return raw
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.gzipSync(raw)
  if (enc === 'br') return zlib.brotliCompressSync(raw)
  if (enc === 'deflate') return zlib.deflateSync(raw)
  return raw
}

type TokenResponseBody = {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  scope?: unknown
  id_token?: unknown
}

/**
 * Replace the real access and refresh tokens in an OAuth token response with
 * placeholders. Other fields pass through, since the tool needs them.
 */
function rewriteTokenResponseBody(parsed: TokenResponseBody): TokenResponseBody {
  const rewritten: TokenResponseBody = { ...parsed }
  if (typeof rewritten.access_token === 'string') {
    rewritten.access_token = PLACEHOLDER_ACCESS_TOKEN
  }
  if (typeof rewritten.refresh_token === 'string') {
    rewritten.refresh_token = PLACEHOLDER_REFRESH_TOKEN
  }
  return rewritten
}

/**
 * The OAuth credential a token-endpoint request would spend, tagged with its
 * tool, which decides how a rotation is captured.
 */
export type RefreshTool = 'claude' | 'codex'
export type HeldBundle =
  | { tool: 'claude'; bundle: ClaudeOAuthBundle }
  | { tool: 'codex'; bundle: CodexOAuthBundle }

/** The bundle a refresh by a workspace of `owner` would spend. */
export function heldBundle(objects: ProxyObjects, owner: string, tool: RefreshTool): HeldBundle | null {
  if (tool === 'claude') {
    const bundle = objects.claudeOAuthBundle(owner)
    return bundle ? { tool, bundle } : null
  }
  const bundle = objects.codexOAuthBundle(owner)
  return bundle ? { tool, bundle } : null
}

/** The bundle a successful token response rotated `held` into. */
export function rotationFrom(held: HeldBundle, body: TokenResponseBody & { access_token: string }): RefreshedBundles {
  const refreshToken = typeof body.refresh_token === 'string' && body.refresh_token
    ? body.refresh_token
    : held.bundle.refreshToken
  if (held.tool === 'claude') {
    return {
      claude: {
        accessToken: body.access_token,
        refreshToken,
        expiresAt: typeof body.expires_in === 'number'
          ? Date.now() + body.expires_in * 1000
          : held.bundle.expiresAt,
        scopes: typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : held.bundle.scopes,
        subscriptionType: held.bundle.subscriptionType,
      },
    }
  }
  // Codex's response carries `id_token` rather than `expires_in`/`scope`;
  // expiry comes from the new access token's own JWT.
  return {
    codex: {
      accessToken: body.access_token,
      refreshToken,
      idTokenRawJwt: typeof body.id_token === 'string' && body.id_token ? body.id_token : held.bundle.idTokenRawJwt,
      expiresAt: decodeJwtExp(body.access_token) ?? (Date.now() + CODEX_DEFAULT_REFRESH_WINDOW_MS),
      lastRefresh: new Date().toISOString(),
      accountId: held.bundle.accountId,
    },
  }
}

/** A fully read token-endpoint reply, sent to the request that drove the
 *  refresh and to every request that joined it. */
export type TokenReply = {
  status: number
  headers: http.OutgoingHttpHeaders
  body: Buffer
  /** The refresh token upstream rotated the credential to (the body then
   *  carries placeholders), or null when it did not rotate it. */
  rotatedTo: string | null
}

export function errorReply(status: number, message: string): TokenReply {
  return { status, headers: { 'content-type': 'text/plain' }, body: Buffer.from(message), rotatedTo: null }
}

export function writeTokenReply(res: http.ServerResponse, reply: TokenReply): void {
  res.writeHead(reply.status, { ...reply.headers, 'content-length': String(reply.body.length) })
  res.end(reply.body)
}

/**
 * Buffer a token-endpoint response, hand the rotation it carries to
 * `capture`, and return a copy with placeholders in place of the real
 * tokens. A response that is not a decodable success passes through
 * unchanged.
 */
export function collectTokenReply(
  upstreamRes: http.IncomingMessage,
  held: HeldBundle,
  capture: (bundles: RefreshedBundles) => void,
  done: (reply: TokenReply) => void,
): void {
  const chunks: Buffer[] = []
  upstreamRes.on('data', (c: Buffer) => chunks.push(c))
  upstreamRes.on('end', () => {
    const raw = Buffer.concat(chunks)
    const encoding = upstreamRes.headers['content-encoding']
    // Sent as one buffer with a fixed length, so no chunked framing.
    const headers: http.OutgoingHttpHeaders = { ...upstreamRes.headers }
    delete headers['transfer-encoding']
    const status = upstreamRes.statusCode ?? 200
    const passThrough = (): void => { done({ status, headers, body: raw, rotatedTo: null }) }

    let decoded: Buffer | null
    try {
      decoded = decodeBody(raw, encoding)
    } catch (err) {
      console.error(`[proxy] Failed to decode ${held.tool} token response body:`, (err as Error).message)
      passThrough()
      return
    }
    if (!decoded) {
      passThrough()
      return
    }
    const parsed = tryParseJsonBody(decoded) as TokenResponseBody | null
    if (!parsed || typeof parsed !== 'object' || typeof parsed.access_token !== 'string') {
      passThrough()
      return
    }
    const body = parsed as TokenResponseBody & { access_token: string }
    const rotation = rotationFrom(held, body)
    const fresh = (rotation.claude ?? rotation.codex)!
    capture(rotation)
    console.log(`[proxy] Captured refreshed ${held.tool} OAuth tokens (expires in ${Math.floor((fresh.expiresAt - Date.now()) / 1000)}s)`)

    const rewrittenJson = Buffer.from(JSON.stringify(rewriteTokenResponseBody(body)), 'utf8')
    let out: Buffer
    try {
      out = encodeBody(rewrittenJson, encoding)
    } catch (err) {
      console.error(`[proxy] Failed to re-encode ${held.tool} token response body:`, (err as Error).message)
      out = rewrittenJson
      delete headers['content-encoding']
    }
    done({ status, headers, body: out, rotatedTo: fresh.refreshToken })
  })
}
