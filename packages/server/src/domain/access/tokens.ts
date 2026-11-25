import { createHash, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { createRemoteJWKSet, customFetch, decodeJwt, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose'
import {
  deleteTokenBinding as deleteRow,
  findTokenBinding,
  getTokenBinding,
  insertTokenBinding,
  listTokenBindings as listRows,
  markTokenBindingUsed,
  recordRefusedSubject,
  type TokenBindingRow,
} from '#db'
import { workspaceDriver } from '#drivers/driver'
import { env, testEnv } from '@yaac/shared/env'
import { ServerError } from '@yaac/shared/errors'

import { tokenTlsDir } from '@yaac/shared/paths'
import { readTokenTlsDir, tokenKeyFingerprint } from '@yaac/shared/token-tls'
import {
  isRankedPermissionMode,
  type Delegate,
  type PermissionMode,
  type TokenBindingCreated,
  type TokenBindingList,
  type TokenBindingSummary,
} from '@yaac/shared/types'
import { personId, type Actor } from './authorize'
import { requireAdmin } from './roles'

/*
 * Token bindings (docs/remote-hosting.md "Token access"): what lets a
 * program on the token listener act as a user, as a delegate with no
 * project of its own. A person makes, lists and deletes their own; an
 * admin lists and deletes anyone's, so a leaked token can be cut off
 * without its owner. No delegate does any of it, so an agent cannot mint a
 * token and a token cannot mint another.
 *
 * A personal access token is known by its SHA-256, which is enough for a
 * 256-bit random secret. An OIDC binding is known by the audience the
 * server gave it: a token names it, which picks the binding before any key
 * is fetched, and is then verified against the binding's issuer, subject
 * and pinned claims.
 */

/** The prefix that tells a personal access token from a JWT. */
const PAT_PREFIX = 'yaac_pat_'
/** A label goes into request logs and refusals, so it is kept plain. */
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** The longest token looked at, and the longest lifetime one may claim. */
const MAX_TOKEN_BYTES = 8 * 1024
const MAX_TOKEN_LIFETIME_S = 60 * 60
const CLOCK_TOLERANCE_S = 60
/** Bounds on an issuer's discovery document and key set. */
const FETCH_TIMEOUT_MS = 5_000
const MAX_FETCHED_BYTES = 256 * 1024
/** Issuers whose subject is built from names someone else can register
 *  again, by origin (GitHub Enterprise Cloud's issuer adds the enterprise
 *  as a path), with the claims a binding must pin to be unambiguous. */
const REQUIRED_CLAIMS: Record<string, string[]> = {
  'https://token.actions.githubusercontent.com': ['repository_id', 'repository_owner_id'],
}

function requiredClaims(issuer: string): string[] {
  try {
    return REQUIRED_CLAIMS[new URL(issuer).origin] ?? []
  } catch {
    return []
  }
}

/** What `POST /token` takes. */
export type NewTokenBindingRequest = {
  label: string
  expiresInMinutes?: number
  permissionMode?: PermissionMode
} & ({ kind: 'pat' } | { kind: 'oidc'; issuer: string; subject: string; claims?: Record<string, string> })

/**
 * The bindings of `userId` (the caller's own when absent), and the token
 * listener's key fingerprint. Another user's are an admin's to list.
 */
export async function listTokenBindings(actor: Actor, userId?: string): Promise<TokenBindingList> {
  const own = personId(actor)
  if (userId !== undefined && userId !== own) await requireAdmin(actor, 'list another user\'s tokens')
  const rows = await listRows(userId ?? own)
  return { fingerprint: await listenerFingerprint(), bindings: rows.map(toSummary) }
}

/**
 * Make a binding for the caller: a personal access token, answered this
 * once, or an OIDC identity, whose issuer is checked first and which is
 * answered with the audience its tokens must name. Its ceiling defaults to
 * the driver's default permission mode.
 */
export async function createTokenBinding(actor: Actor, request: NewTokenBindingRequest): Promise<TokenBindingCreated> {
  const owner = personId(actor)
  if (!LABEL.test(request.label)) {
    throw new ServerError('VALIDATION', 'a token\'s label is 1-64 letters, digits, dots, dashes and underscores, starting with a letter or digit')
  }
  const ceiling = request.permissionMode ?? (workspaceDriver().kind === 'containerless' ? 'accept-edits' : 'bypass')
  if (!isRankedPermissionMode(ceiling)) throw new ServerError('VALIDATION', `unknown permission mode '${ceiling}'`)
  const common = {
    owner,
    label: request.label,
    ceiling,
    ...(request.expiresInMinutes !== undefined ? { expiresAt: new Date(Date.now() + request.expiresInMinutes * 60_000) } : {}),
  }
  if (request.kind === 'pat') {
    const token = `${PAT_PREFIX}${randomBytes(32).toString('base64url')}`
    const row = await insertTokenBinding({ ...common, kind: 'pat', tokenHash: sha256(token) })
    return { binding: toSummary(row), token }
  }
  const claims = request.claims ?? {}
  const empty = Object.entries(claims).filter(([, value]) => value === '').map(([name]) => name)
  if (empty.length > 0) throw new ServerError('VALIDATION', `a pinned claim needs a value: ${empty.join(', ')}`)
  const missing = requiredClaims(request.issuer).filter((name) => claims[name] === undefined)
  if (missing.length > 0) {
    throw new ServerError('VALIDATION', `a binding to ${request.issuer} must also pin ${missing.join(' and ')}, `
      + 'which do not change when a repository is renamed or its name is reused')
  }
  if (request.subject === '') throw new ServerError('VALIDATION', 'name the exact subject the binding accepts')
  await discover(request.issuer)
  const row = await insertTokenBinding({
    ...common,
    kind: 'oidc',
    issuer: request.issuer,
    subject: request.subject,
    claims,
    audience: `yaac:${randomBytes(16).toString('base64url')}`,
  })
  return { binding: toSummary(row) }
}

/**
 * Delete a binding: the caller's own, or as an admin anyone's. To anyone
 * else another user's binding is not found.
 */
export async function deleteTokenBinding(actor: Actor, id: string): Promise<void> {
  const own = personId(actor)
  const row = await getTokenBinding(id)
  if (row !== undefined && row.owner !== own) {
    await requireAdmin(actor).catch(() => { throw notFound(id) })
  }
  if (row === undefined || !await deleteRow(id)) throw notFound(id)
  if (row.issuer !== null) keySets.delete(row.issuer)
}

/**
 * The delegate a bearer token acts as, or undefined for one no binding
 * accepts. A token that names a binding but fails it in a way the caller
 * can act on (an expired binding, an OIDC token for the wrong subject) is
 * refused with why instead.
 */
export async function resolveBearer(token: string): Promise<Delegate | undefined> {
  const found = token.startsWith(PAT_PREFIX) ? await findTokenBinding({ tokenHash: sha256(token) }) : await resolveJwt(token)
  if (found === undefined) return undefined
  const { binding, login } = found
  if (binding.expiresAt !== null && binding.expiresAt.getTime() <= Date.now()) {
    throw new ServerError('UNAUTHENTICATED', `token ${binding.label} expired at ${binding.expiresAt.toISOString()}`)
  }
  await markTokenBindingUsed(binding.id)
  return {
    kind: 'delegate',
    userId: binding.owner,
    login,
    via: { kind: 'token', id: binding.id, label: `token ${binding.label}` },
    ceiling: binding.ceiling,
  }
}

/** The binding an OIDC token is for, once it has proved it. */
async function resolveJwt(token: string): Promise<{ binding: TokenBindingRow; login: string | null } | undefined> {
  if (Buffer.byteLength(token) > MAX_TOKEN_BYTES || token.split('.').length !== 3) return undefined
  let audience: unknown
  try {
    if (decodeProtectedHeader(token).crit !== undefined) return undefined
    audience = decodeJwt(token).aud
  } catch {
    return undefined
  }
  if (Array.isArray(audience) && audience.length === 1) audience = audience[0]
  if (typeof audience !== 'string') return undefined
  const found = await findTokenBinding({ audience })
  if (found === undefined) return undefined
  const { binding } = found
  const issuer = binding.issuer as string
  if (decodeJwt(token).iss !== issuer) return undefined
  let payload: JWTPayload
  try {
    ;({ payload } = await jwtVerify(token, keySet(issuer), {
      algorithms: ['RS256', 'ES256'],
      issuer,
      audience,
      requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat'],
      clockTolerance: CLOCK_TOLERANCE_S,
    }))
  } catch (err) {
    throw new ServerError('UNAUTHENTICATED', `token ${binding.label}: ${err instanceof Error ? err.message : 'did not verify'}`)
  }
  const now = Math.floor(Date.now() / 1000)
  const { iat, exp, sub } = payload as Required<Pick<JWTPayload, 'iat' | 'exp' | 'sub'>>
  if (iat > now + CLOCK_TOLERANCE_S) throw new ServerError('UNAUTHENTICATED', `token ${binding.label}: issued in the future`)
  if (exp - iat > MAX_TOKEN_LIFETIME_S) {
    throw new ServerError('UNAUTHENTICATED', `token ${binding.label}: lives longer than ${MAX_TOKEN_LIFETIME_S / 60} minutes`)
  }
  if (sub !== binding.subject) {
    await recordRefusedSubject(binding.id, sub)
    throw new ServerError('UNAUTHENTICATED', `token ${binding.label}: its subject is not the one this binding accepts`)
  }
  for (const [name, value] of Object.entries(binding.claims ?? {})) {
    if (payload[name] !== value) throw new ServerError('UNAUTHENTICATED', `token ${binding.label}: its ${name} is not the one this binding pins`)
  }
  return found
}

/** How long a failed discovery is answered from memory rather than
 *  fetched again, as jose cools down its own key refetches. */
const DISCOVERY_COOLDOWN_MS = 30_000

/** Each saved issuer's keys, fetched on first use and on an unknown `kid`. */
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

/**
 * The key set of `issuer`, from the `jwks_uri` its discovery document
 * names, fetched when a token first needs it. The discovery is shared by
 * concurrent first requests, and a failed one is kept for a cooldown, so a
 * stream of tokens naming a known audience (which is no secret) cannot make
 * the server fetch the issuer on every request.
 */
function keySet(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  let set = keySets.get(issuer)
  if (set === undefined) {
    let pending: Promise<ReturnType<typeof createRemoteJWKSet>> | undefined
    let failedAt = 0
    const lazy = async (...args: Parameters<ReturnType<typeof createRemoteJWKSet>>) => {
      if (pending === undefined || (failedAt !== 0 && Date.now() - failedAt >= DISCOVERY_COOLDOWN_MS)) {
        failedAt = 0
        pending = discover(issuer).then(
          ({ jwks_uri }) => createRemoteJWKSet(new URL(jwks_uri), { timeoutDuration: FETCH_TIMEOUT_MS, [customFetch]: boundedFetch }),
          (err: unknown) => {
            failedAt = Date.now()
            throw err
          },
        )
      }
      return await (await pending)(...args)
    }
    set = lazy as ReturnType<typeof createRemoteJWKSet>
    keySets.set(issuer, set)
  }
  return set
}

/**
 * Check an issuer and fetch its discovery document: `https` with no
 * userinfo, query or fragment, on a public DNS name, and answering with
 * its own URL as `issuer` and an `https` `jwks_uri`. An IP literal, a
 * single-label name and a cluster-internal name are refused, which keeps
 * out Kubernetes' default issuer, the same on every cluster.
 */
async function discover(issuer: string): Promise<{ jwks_uri: string }> {
  let url: URL
  try {
    url = new URL(issuer)
  } catch {
    throw new ServerError('VALIDATION', `the issuer "${issuer}" is not a URL`)
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new ServerError('VALIDATION', 'the issuer must be an https URL with no user, query or fragment')
  }
  if (isIP(host) !== 0 || !host.includes('.') || /\.(svc|cluster\.local|local|internal)$/i.test(host)) {
    throw new ServerError('VALIDATION', `the issuer's host must be a public DNS name (got ${host})`)
  }
  const where = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`
  let doc: { issuer?: unknown; jwks_uri?: unknown }
  try {
    const res = await boundedFetch(where, {})
    if (!res.ok) throw new Error(`answered ${res.status}`)
    // Parsed here, since a JSON parse error quotes the body.
    doc = await res.json().catch(() => { throw new Error('the response is not JSON') }) as typeof doc
  } catch (err) {
    throw new ServerError('VALIDATION', `could not read ${where}: ${err instanceof Error ? err.message : 'failed'}`)
  }
  if (doc.issuer !== issuer) throw new ServerError('VALIDATION', `${where} names another issuer than "${issuer}"`)
  if (typeof doc.jwks_uri !== 'string' || !doc.jwks_uri.startsWith('https://')) {
    throw new ServerError('VALIDATION', `${where} names no https jwks_uri`)
  }
  return { jwks_uri: doc.jwks_uri }
}

/** A fetch that follows no redirect, gives up after five seconds, and
 *  refuses a body over the cap without reading the rest. Its errors never
 *  quote the body. */
async function boundedFetch(url: string, init: { headers?: HeadersInit; signal?: AbortSignal }): Promise<Response> {
  const stub = testEnv.oidcOrigin
  const target = stub === undefined ? url : `${stub}${new URL(url).pathname}`
  const res = await fetch(target, {
    headers: init.headers,
    redirect: 'error',
    signal: init.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  const reader = res.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const next = reader === undefined ? { done: true as const } : await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > MAX_FETCHED_BYTES) {
      await reader?.cancel()
      throw new Error(`the response is over ${MAX_FETCHED_BYTES / 1024} KiB`)
    }
    chunks.push(next.value)
  }
  return new Response(Buffer.concat(chunks), { status: res.status, headers: res.headers })
}

/** The token listener's key fingerprint, or null when this server has
 *  none, or its certificate has not been written yet. */
async function listenerFingerprint(): Promise<string | null> {
  if (env.tokenListen === undefined) return null
  const pair = await readTokenTlsDir(tokenTlsDir()).catch(() => undefined)
  if (pair === undefined) return null
  try {
    return tokenKeyFingerprint(pair.cert)
  } catch {
    return null
  }
}

function toSummary(row: TokenBindingRow): TokenBindingSummary {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    ceiling: row.ceiling,
    createdAt: row.createdAt.getTime(),
    expiresAt: row.expiresAt?.getTime() ?? null,
    lastUsedAt: row.lastUsedAt?.getTime() ?? null,
    ...(row.kind === 'oidc'
      ? {
        issuer: row.issuer ?? undefined,
        subject: row.subject ?? undefined,
        claims: row.claims ?? {},
        audience: row.audience ?? undefined,
        ...(row.refusedSubject !== null ? { refusedSubject: row.refusedSubject } : {}),
        ...(row.refusedAt !== null ? { refusedAt: row.refusedAt.getTime() } : {}),
      }
      : {}),
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function notFound(id: string): ServerError {
  return new ServerError('NOT_FOUND', `token ${id} not found`)
}
