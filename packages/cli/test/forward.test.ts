import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { forward } from '#commands/forward'
import { LOOPBACK_ONLY_REFUSAL } from '@yaac/shared/port-tunnel-set'
import { startFakeApi, type FakeApi } from './fake-api'

let api: FakeApi

beforeAll(async () => {
  api = await startFakeApi()
  vi.stubEnv('YAAC_SERVER_URL', api.url)
})

afterAll(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await api.close()
})

describe('forward', () => {
  it('binds no port of a public site release beyond loopback, even one named with --port', async () => {
    api.on('GET /api/workspace/rel-1', { json: { workspaceId: 'rel-1' } })
    // `release` without `site`: a release whose site is being deleted.
    api.on('GET /api/workspace/list', { json: { workspaces: [{ workspaceId: 'rel-1', release: true }] } })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    // TEST-NET-1 is never this machine's, so a regression fails to bind at once rather than opening a listener.
    await expect(forward('rel-1', { port: ['3001'], bind: '192.0.2.1' })).rejects.toThrow('no port could be bound')
    expect(errors).toHaveBeenCalledWith(`cannot bind port 3001: ${LOOPBACK_ONLY_REFUSAL}`)
  })
})
