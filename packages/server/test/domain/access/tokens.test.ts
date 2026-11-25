import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from 'jose'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import type { ServerError } from '@yaac/shared/errors'
import { ensureTokenTlsDir } from '@yaac/shared/token-tls'
import { closeDb, getDb } from '#db/client'
import { tokenBindings } from '#db/schema'
import { getTokenBinding, recordAccessMode, seeTailnetUser } from '#db'
import { createTokenBinding, deleteTokenBinding, listTokenBindings, resolveBearer, type Actor } from '#domain/access'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'
import { workspaceDelegate } from '#test/support/delegate'

const ISSUER = 'https://issuer.example'
const JWKS_URI = 'https://issuer.example/jwks'

function user(userId: string): Actor {
  return { kind: 'tailnet', userId, login: `${userId}@example.com`, name: userId }
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(() => undefined, (err: unknown) => (err as ServerError).code)
}

let tmpDir: string
let admin: string
let member: string

/** The issuer's published keys, by kid; what the fake network serves. */
const published: JWK[] = []
let discovery: Record<string, unknown> = { issuer: ISSUER, jwks_uri: JWKS_URI }
let fetches: string[] = []
let unreachable = false

/** The process boundary: the issuer's discovery document and key set. */
function fakeFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input)
  fetches.push(url)
  if (unreachable) return Promise.reject(new Error('connect ECONNREFUSED'))
  if (url === `${ISSUER}/.well-known/openid-configuration`) return Promise.resolve(Response.json(discovery))
  if (url === JWKS_URI) return Promise.resolve(Response.json({ keys: published }))
  return Promise.resolve(new Response('not found', { status: 404 }))
}

async function newKey(kid: string): Promise<CryptoKey> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true })
  published.push({ ...await exportJWK(publicKey), kid, alg: 'ES256', use: 'sig' })
  return privateKey
}

/** A token from the fake issuer, signed with `key`, for `aud`. */
async function mint(key: CryptoKey, kid: string, aud: string, claims: JWTPayload = {}, opts: { iat?: number; exp?: number | null } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const jwt = new SignJWT({ sub: 'svc-1', ...claims })
    .setProtectedHeader({ alg: 'ES256', kid })
    .setIssuer(typeof claims.iss === 'string' ? claims.iss : ISSUER)
    .setAudience(aud)
    .setIssuedAt(opts.iat ?? now)
  if (opts.exp !== null) jwt.setExpirationTime(opts.exp ?? now + 600)
  return await jwt.sign(key)
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

beforeAll(async () => {
  tmpDir = await createTempDataDir()
  await recordAccessMode('tailnet', { admins: ['admin@example.com'] })
  admin = await seeTailnetUser('admin@example.com', 'Admin')
  member = await seeTailnetUser('member@example.com', 'Member')
})

afterAll(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

beforeEach(async () => {
  installFakeWorkspaceDriver({ kind: 'containerless' })
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
  fetches = []
  unreachable = false
  discovery = { issuer: ISSUER, jwks_uri: JWKS_URI }
  const db = await getDb()
  await db.delete(tokenBindings)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('listTokenBindings', () => {
  it('lists the caller\'s own, another user\'s for an admin only, and the listener\'s fingerprint', async () => {
    await createTokenBinding(user(member), { kind: 'pat', label: 'mine' })
    expect(await listTokenBindings(user(member))).toMatchObject({ fingerprint: null, bindings: [{ label: 'mine', kind: 'pat' }] })
    expect(await codeOf(listTokenBindings(user(member), admin))).toBe('FORBIDDEN')
    expect((await listTokenBindings(user(admin), member)).bindings.map((b) => b.label)).toEqual(['mine'])
    expect(await codeOf(listTokenBindings(workspaceDelegate(member, 'w1')))).toBe('FORBIDDEN')

    const dir = path.join(tmpDir, 'token-tls-test')
    const fingerprint = await ensureTokenTlsDir(dir, '127.0.0.1')
    vi.stubEnv('YAAC_TOKEN_LISTEN', '127.0.0.1:8443')
    vi.stubEnv('YAAC_TOKEN_TLS_DIR', dir)
    expect((await listTokenBindings(user(member))).fingerprint).toBe(fingerprint)
  })
})

describe('createTokenBinding', () => {
  it('makes a personal access token shown once, at the driver\'s default mode unless named', async () => {
    const { token, binding } = await createTokenBinding(user(member), { kind: 'pat', label: 'ci', expiresInMinutes: 60 })
    expect(token).toMatch(/^yaac_pat_[A-Za-z0-9_-]{43}$/)
    expect(binding).toMatchObject({ label: 'ci', ceiling: 'accept-edits', lastUsedAt: null })
    expect(binding.expiresAt).toBeGreaterThan(Date.now())
    expect((await createTokenBinding(user(member), { kind: 'pat', label: 'wide', permissionMode: 'bypass' })).binding.ceiling).toBe('bypass')
    expect(await codeOf(createTokenBinding(user(member), { kind: 'pat', label: 'ci' }))).toBe('CONFLICT')
    expect(await codeOf(createTokenBinding(user(member), { kind: 'pat', label: 'no spaces' }))).toBe('VALIDATION')
    // An agent cannot mint one for its owner.
    expect(await codeOf(createTokenBinding(workspaceDelegate(member, 'w1'), { kind: 'pat', label: 'agent' }))).toBe('FORBIDDEN')
  })

  it('checks an OIDC issuer on save and answers a fresh audience', async () => {
    const oidc = { kind: 'oidc' as const, subject: 'svc-1' }
    for (const issuer of ['http://issuer.example', 'https://10.0.0.1', 'https://kubernetes.default.svc', 'https://intranet', 'https://u@issuer.example', 'https://issuer.example/?x=1']) {
      expect(await codeOf(createTokenBinding(user(member), { ...oidc, label: 'bad', issuer })), issuer).toBe('VALIDATION')
    }
    expect(fetches).toEqual([])
    discovery = { issuer: 'https://someone-else.example', jwks_uri: JWKS_URI }
    await expect(createTokenBinding(user(member), { ...oidc, label: 'bad', issuer: ISSUER })).rejects.toThrow(/another issuer/)
    discovery = { issuer: ISSUER, jwks_uri: 'http://issuer.example/jwks' }
    await expect(createTokenBinding(user(member), { ...oidc, label: 'bad', issuer: ISSUER })).rejects.toThrow(/https jwks_uri/)
    await expect(createTokenBinding(user(member), {
      ...oidc, label: 'gh', issuer: 'https://token.actions.githubusercontent.com', subject: 'repo:o/r:environment:prod',
    })).rejects.toThrow(/repository_id and repository_owner_id/)
    await expect(createTokenBinding(user(member), {
      ...oidc, label: 'gh', issuer: 'https://token.actions.githubusercontent.com', subject: 'repo:o/r:environment:prod',
      claims: { repository_id: '', repository_owner_id: '1' },
    })).rejects.toThrow(/pinned claim needs a value: repository_id/)
    // GitHub Enterprise Cloud's issuer adds the enterprise as a path.
    await expect(createTokenBinding(user(member), {
      ...oidc, label: 'ghe', issuer: 'https://token.actions.githubusercontent.com/octocat-inc', subject: 'repo:o/r:environment:prod',
    })).rejects.toThrow(/repository_id and repository_owner_id/)

    discovery = { issuer: ISSUER, jwks_uri: JWKS_URI }
    const a = await createTokenBinding(user(member), { ...oidc, label: 'a', issuer: ISSUER })
    // The same identity may be bound twice; the audience tells them apart.
    const b = await createTokenBinding(user(admin), { ...oidc, label: 'b', issuer: ISSUER })
    expect(a.binding.audience).toMatch(/^yaac:[A-Za-z0-9_-]{22}$/)
    expect(a.binding.audience).not.toBe(b.binding.audience)
    expect(a.token).toBeUndefined()
  })
})

describe('deleteTokenBinding', () => {
  it('deletes the caller\'s own, anyone\'s for an admin, and hides another\'s from a member', async () => {
    const mine = (await createTokenBinding(user(member), { kind: 'pat', label: 'm' })).binding
    const theirs = (await createTokenBinding(user(admin), { kind: 'pat', label: 'a' })).binding
    expect(await codeOf(deleteTokenBinding(user(member), theirs.id))).toBe('NOT_FOUND')
    expect(await codeOf(deleteTokenBinding(workspaceDelegate(admin, 'w1'), theirs.id))).toBe('FORBIDDEN')
    await deleteTokenBinding(user(admin), mine.id)
    expect(await getTokenBinding(mine.id)).toBeUndefined()
    await deleteTokenBinding(user(admin), theirs.id)
    expect(await codeOf(deleteTokenBinding(user(admin), theirs.id))).toBe('NOT_FOUND')
  })
})

describe('resolveBearer', () => {
  it('resolves a personal access token to its owner\'s delegate until it expires or is deleted', async () => {
    const { token, binding } = await createTokenBinding(user(member), { kind: 'pat', label: 'ci', permissionMode: 'plan' })
    expect(await resolveBearer(token ?? '')).toEqual({
      kind: 'delegate',
      userId: member,
      login: 'member@example.com',
      via: { kind: 'token', id: binding.id, label: 'token ci' },
      ceiling: 'plan',
    })
    expect((await getTokenBinding(binding.id))?.lastUsedAt).toBeInstanceOf(Date)
    expect(await resolveBearer(`${token ?? ''}x`)).toBeUndefined()

    const db = await getDb()
    await db.update(tokenBindings).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(tokenBindings.id, binding.id))
    await expect(resolveBearer(token ?? '')).rejects.toThrow(/token ci expired/)
    await deleteTokenBinding(user(member), binding.id)
    expect(await resolveBearer(token ?? '')).toBeUndefined()
  })

  it('verifies an OIDC token against its binding and refuses every way one can be wrong', async () => {
    const k1 = await newKey('k1')
    const { binding } = await createTokenBinding(user(member), {
      kind: 'oidc', label: 'svc', issuer: ISSUER, subject: 'svc-1', claims: { repository_id: '42' },
    })
    const aud = binding.audience ?? ''
    fetches = []

    // A token naming no binding costs no network I/O.
    expect(await resolveBearer(await mint(k1, 'k1', 'yaac:unknown', { repository_id: '42' }))).toBeUndefined()
    expect(fetches).toEqual([])

    const good = await mint(k1, 'k1', aud, { repository_id: '42' })
    expect(await resolveBearer(good)).toMatchObject({ userId: member, via: { kind: 'token', label: 'token svc' } })

    const refused = async (token: string, why: RegExp | undefined): Promise<void> => {
      if (why === undefined) expect(await resolveBearer(token)).toBeUndefined()
      else await expect(resolveBearer(token)).rejects.toThrow(why)
    }
    const now = Math.floor(Date.now() / 1000)
    const header = b64({ alg: 'ES256', kid: 'k1' })
    const body = b64({ iss: ISSUER, sub: 'svc-1', aud, iat: now, exp: now + 60, repository_id: '42' })
    await refused(await mint(k1, 'k1', aud, { repository_id: '7' }), /repository_id is not the one/)
    await refused(await mint(k1, 'k1', aud, { repository_id: '42', iss: 'https://other.example' }), undefined)
    await refused(`${b64({ alg: 'none' })}.${body}.`, /token svc/)
    await refused(await new SignJWT({ sub: 'svc-1', repository_id: '42' }).setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER).setAudience(aud).setIssuedAt().setExpirationTime('5m').sign(new Uint8Array(32)), /token svc/)
    await refused(await mint(k1, 'k1', aud, { repository_id: '42' }, { exp: null }), /exp/)
    await refused(await mint(k1, 'k1', aud, { repository_id: '42' }, { iat: now + 600, exp: now + 900 }), /future/)
    await refused(await mint(k1, 'k1', aud, { repository_id: '42' }, { iat: now, exp: now + 2 * 3600 }), /longer than 60 minutes/)
    const noIat = `${header}.${b64({ iss: ISSUER, sub: 'svc-1', aud, exp: now + 60 })}.sig`
    await refused(noIat, /token svc/)
    await refused(`${header}.${'a'.repeat(9000)}.sig`, undefined)
    await refused(`${header}.${body}.a.b.c`, undefined)
    await refused(`${b64({ alg: 'ES256', kid: 'k1', crit: ['x'], x: 1 })}.${body}.sig`, undefined)

    // A verified token for another subject is refused, and recorded.
    await refused(await mint(k1, 'k1', aud, { sub: 'svc-2', repository_id: '42' }), /subject is not the one/)
    expect((await getTokenBinding(binding.id))?.refusedSubject).toBe('svc-2')

    // An unknown kid refetches the keys, at most once per cooldown.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
    vi.setSystemTime(Date.now() + 31_000)
    const k2 = await newKey('k2')
    const keyFetches = (): number => fetches.filter((u) => u === JWKS_URI).length
    const before = keyFetches()
    expect(await resolveBearer(await mint(k2, 'k2', aud, { repository_id: '42' }))).toMatchObject({ userId: member })
    expect(keyFetches()).toBe(before + 1)
    const k3 = await newKey('k3')
    await refused(await mint(k3, 'k3', aud, { repository_id: '42' }), /token svc/)
    expect(keyFetches()).toBe(before + 1)
    vi.useRealTimers()
  })

  it('fails closed when the issuer cannot be reached, without fetching it again on every token', async () => {
    // An issuer of its own, so no earlier case has cached its keys.
    const other = 'https://down.example'
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(Response.json({ issuer: other, jwks_uri: `${other}/jwks` }))))
    const { binding } = await createTokenBinding(user(member), { kind: 'oidc', label: 'down', issuer: other, subject: 'svc-1' })
    const down = vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED')))
    vi.stubGlobal('fetch', down)
    const token = await new SignJWT({ sub: 'svc-1' }).setProtectedHeader({ alg: 'ES256', kid: 'k' }).setIssuer(other)
      .setAudience(binding.audience ?? '').setIssuedAt().setExpirationTime('5m').sign(await newKey('k-down'))
    await Promise.all([resolveBearer(token), resolveBearer(token)].map((p) => expect(p).rejects.toThrow(/token down/)))
    await expect(resolveBearer(token)).rejects.toThrow(/token down/)
    expect(down).toHaveBeenCalledTimes(1)
  })

  it('never quotes an issuer\'s answer in a refusal', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('<html><body>secret page</body></html>'))))
    await expect(createTokenBinding(user(member), { kind: 'oidc', label: 'html', issuer: ISSUER, subject: 's' }))
      .rejects.toThrow(/could not read .*: the response is not JSON$/)
  })
})
