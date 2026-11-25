import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { resetTokenFailures, tokenListenerApp } from '@yaac/server/main/token-listener'
import { closeDb, getDb } from '@yaac/server/db/client'
import { tokenBindings } from '@yaac/server/db/schema'
import { BUILT_IN_USER_ID } from '@yaac/server/db/user-store'
import { createTokenBinding, deleteTokenBinding } from '@yaac/server/domain/access/tokens'

/**
 * The token listener's app in process (docs/remote-hosting.md "Token
 * access"): `delegateApp` behind the bearer resolver and the failure
 * limit. Only a token admits a caller, whatever else the request claims.
 */
const app = tokenListenerApp({ buildId: 'test' })
const person = { kind: 'local', userId: BUILT_IN_USER_ID } as const
let tmpDir: string
let token: string

/** A request from `source`, as node-server hands it over. */
function call(path: string, opts: { source?: string; headers?: Record<string, string>; method?: string; body?: unknown } = {}): Promise<Response> {
  const init: RequestInit = { method: opts.method ?? 'GET', headers: { ...opts.headers } }
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body)
    init.headers = { ...opts.headers, 'Content-Type': 'application/json' }
  }
  return app.fetch(new Request(`https://10.0.1.2:8443${path}`, init), { incoming: { socket: { remoteAddress: opts.source ?? '10.9.9.9' } } } as never)
}

const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` })

beforeAll(async () => {
  tmpDir = await createTempDataDir()
  token = (await createTokenBinding(person, { kind: 'pat', label: 'ci', permissionMode: 'plan' })).token ?? ''
})

afterAll(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

beforeEach(() => { resetTokenFailures() })

describe('the token listener', () => {
  it('refuses every request without a token, whatever else it claims', async () => {
    const claims: Array<Record<string, string>> = [
      {},
      { Host: '127.0.0.1' },
      { 'Tailscale-User-Login': 'admin@example.com', 'X-Forwarded-For': '100.64.0.1' },
      { Authorization: 'Basic eDp5' },
    ]
    for (const headers of claims) {
      const res = await call('/api/whoami', { headers })
      expect(res.status, JSON.stringify(headers)).toBe(401)
      expect(res.headers.get('WWW-Authenticate')).toBe('Bearer')
    }
    expect((await call('/api/health')).status).toBe(401)
    // A token in the query string is never read.
    expect((await call(`/api/whoami?token=${token}&access_token=${token}`)).status).toBe(401)
  })

  it('answers a token as its user\'s delegate, held to what a delegate may do', async () => {
    const res = await call('/api/whoami', { headers: bearer(token) })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ kind: 'delegate', userId: BUILT_IN_USER_ID, via: { kind: 'token', label: 'token ci' }, ceiling: 'plan' })
    expect((await call('/api/health', { headers: bearer(token) })).status).toBe(200)
    expect((await call('/api/project/list', { headers: bearer(token) })).status).toBe(200)
    // A token can neither list nor mint bindings.
    expect((await call('/api/token', { headers: bearer(token) })).status).toBe(403)
    expect((await call('/api/token', { headers: bearer(token), method: 'POST', body: { kind: 'pat', label: 'more' } })).status).toBe(403)
  })

  it('refuses an expired binding and a deleted one from their next request', async () => {
    const made = await createTokenBinding(person, { kind: 'pat', label: 'short', permissionMode: 'plan' })
    const db = await getDb()
    await db.update(tokenBindings).set({ expiresAt: new Date(0) }).where(eq(tokenBindings.id, made.binding.id))
    const expired = await call('/api/whoami', { headers: bearer(made.token ?? '') })
    expect(expired.status).toBe(401)
    expect(await expired.text()).toMatch(/token short expired/)
    await deleteTokenBinding(person, made.binding.id)
    expect((await call('/api/whoami', { headers: bearer(made.token ?? '') })).status).toBe(401)
  })

  it('answers 429 to an address that keeps failing, but never refuses a valid token from it', async () => {
    for (let i = 0; i < 10; i += 1) expect((await call('/api/whoami', { source: '10.1.1.1', headers: bearer('yaac_pat_wrong') })).status).toBe(401)
    const limited = await call('/api/whoami', { source: '10.1.1.1', headers: bearer('yaac_pat_wrong') })
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect((await call('/api/whoami', { source: '10.1.1.1' })).status).toBe(429)
    // On a cluster every caller can share one source, so a stranger's
    // failures must not lock a token's holder out.
    expect((await call('/api/whoami', { source: '10.1.1.1', headers: bearer(token) })).status).toBe(200)
    expect((await call('/api/whoami', { source: '10.2.2.2', headers: bearer('yaac_pat_wrong') })).status).toBe(401)
  })
})
