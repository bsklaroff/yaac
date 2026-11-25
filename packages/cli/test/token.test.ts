import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import { scopeToUser } from '#commands/api'
import { tokenBind, tokenCreate, tokenDelete, tokenList } from '#commands/token'
import { serveProjects, startFakeApi, ADA, type FakeApi } from './fake-api'

/*
 * `yaac token …` against a fake server: what each command sends, and what
 * it refuses before asking the server anything.
 */
let api: FakeApi
let logged: string[]

const BINDING = { id: 'b1', kind: 'pat', label: 'ci', ceiling: 'bypass', createdAt: 0, expiresAt: null, lastUsedAt: null }

beforeAll(async () => {
  api = await startFakeApi()
  vi.stubEnv('YAAC_SERVER_URL', api.url)
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await api.close()
})

beforeEach(() => {
  api.reset()
  logged = []
  vi.spyOn(console, 'log').mockImplementation((msg: unknown) => { logged.push(String(msg)) })
  vi.spyOn(console, 'error').mockImplementation((msg: unknown) => { logged.push(String(msg)) })
  serveProjects(api, [])
  api.on('GET /api/token', { json: { fingerprint: 'sha256//abc', bindings: [BINDING] } })
  api.on('POST /api/token', { json: { binding: { ...BINDING, audience: 'yaac:aud' }, token: 'yaac_pat_x' } })
  api.on('DELETE /api/token/b1', { json: { ok: true } })
})

afterEach(() => {
  vi.restoreAllMocks()
  scopeToUser(undefined)
})

const sent = (route: string): unknown => api.requests.find((r) => r.route === route)?.body

describe('yaac token', () => {
  it('sends a create\'s expiry in minutes and its mode, and prints the token', async () => {
    await tokenCreate('ci', { expires: '1d12h', permissionMode: 'plan' })
    expect(sent('POST /api/token')).toEqual({ kind: 'pat', label: 'ci', expiresInMinutes: 2160, permissionMode: 'plan' })
    expect(logged[0]).toBe('yaac_pat_x')
  })

  it('refuses an expiry, a mode or a claim it cannot read, before asking the server', async () => {
    await expect(tokenCreate('ci', { expires: 'soon' })).rejects.toThrow(/--expires takes a duration/)
    await expect(tokenCreate('ci', { expires: '30s' })).rejects.toThrow(/--expires takes a duration/)
    await expect(tokenCreate('ci', { permissionMode: 'yolo' })).rejects.toThrow(/--permission-mode takes one of/)
    await expect(tokenBind('svc', { issuer: 'https://i.example', subject: 's', claim: ['novalue'] })).rejects.toThrow(/--claim takes <name>=<value>/)
    await expect(tokenBind('svc', { issuer: 'https://i.example', subject: 's', claim: ['=x'] })).rejects.toThrow(/--claim takes/)
    expect(api.requests.filter((r) => r.route === 'POST /api/token')).toEqual([])
  })

  it('sends a bind\'s claims, keeping an = inside a value, and prints the audience', async () => {
    await tokenBind('svc', { issuer: 'https://i.example', subject: 's', claim: ['repository_id=42', 'ref=a=b'] })
    expect(sent('POST /api/token')).toEqual({
      kind: 'oidc', label: 'svc', issuer: 'https://i.example', subject: 's', claims: { repository_id: '42', ref: 'a=b' },
    })
    expect(logged[0]).toBe('yaac:aud')
  })

  it('lists and deletes another user\'s tokens with --user, by label', async () => {
    scopeToUser('ada@example.com')
    await tokenList()
    expect(api.requests.find((r) => r.route === 'GET /api/token')?.query.get('user')).toBe(ADA)
    await tokenDelete('ci')
    expect(api.requests.some((r) => r.route === 'DELETE /api/token/b1')).toBe(true)
    await expect(tokenDelete('nope')).rejects.toThrow(/no token named "nope"/)
  })
})
