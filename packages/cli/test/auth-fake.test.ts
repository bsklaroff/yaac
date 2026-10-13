import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { authFake } from '#commands/auth-fake'
import { startFakeApi, type FakeApi } from './fake-api'

let api: FakeApi

beforeAll(async () => {
  api = await startFakeApi()
  vi.stubEnv('YAAC_SERVER_URL', api.url)
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterAll(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await api.close()
})

beforeEach(() => {
  api.reset()
})

describe('authFake', () => {
  it('posts every kind in one request, each once', async () => {
    api.on('POST /api/auth/fake', {})
    await authFake(['pi-openrouter', 'claude-oauth', 'pi-openrouter'])
    expect(api.requests.map((r) => r.body)).toEqual([{ kinds: ['pi-openrouter', 'claude-oauth'] }])
  })

  it('throws when the server returns an error response', async () => {
    api.on('POST /api/auth/fake', { status: 500, json: { error: { code: 'INTERNAL', message: 'server error' } } })
    await expect(authFake(['pi-openrouter'])).rejects.toThrow('server error')
  })
})
