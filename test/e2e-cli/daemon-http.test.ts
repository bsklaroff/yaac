import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createYaacTestEnv,
  spawnYaacDaemon,
  type YaacTestEnv,
  type SpawnedDaemon,
} from '@test/helpers/cli'

/**
 * HTTP-surface tests for the spawned daemon. These don't exercise the
 * CLI directly — they hit the daemon's bearer-guarded endpoints via
 * fetch to verify the response shapes the CLI client relies on. They
 * sit next to the e2e-cli tests because they share the same
 * spawn-a-real-daemon pattern.
 */
describe('yaac daemon HTTP surface (real daemon)', () => {
  let testEnv: YaacTestEnv
  let daemon: SpawnedDaemon

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
    daemon = await spawnYaacDaemon(testEnv.env)
  })

  afterEach(async () => {
    await daemon.stop()
    await testEnv.cleanup()
  })

  async function authedFetch(url: string): Promise<Response> {
    return fetch(url, { headers: { authorization: `Bearer ${daemon.lock.secret}` } })
  }

  it('rejects /project/list without a bearer token', async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.lock.port}/project/list`)
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('BAD_BEARER')
  })

  it('returns the empty project list with the correct bearer', async () => {
    const res = await authedFetch(`http://127.0.0.1:${daemon.lock.port}/project/list`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('GET /session/list?project=missing returns 404 NOT_FOUND', async () => {
    const res = await authedFetch(`http://127.0.0.1:${daemon.lock.port}/session/list?project=missing`)
    expect(res.status).toBe(404)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('GET /session/:id/blocked-hosts returns 404 for an unknown session', async () => {
    const res = await authedFetch(`http://127.0.0.1:${daemon.lock.port}/session/deadbeef/blocked-hosts`)
    expect(res.status).toBe(404)
  })

  it('GET /prewarm returns {} on a clean data dir', async () => {
    const res = await authedFetch(`http://127.0.0.1:${daemon.lock.port}/prewarm`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })

  it('GET /tool/get returns {tool:null} when no default is configured', async () => {
    const res = await authedFetch(`http://127.0.0.1:${daemon.lock.port}/tool/get`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tool: null })
  })

  it('GET /auth/list returns empty arrays when nothing is configured', async () => {
    const res = await authedFetch(`http://127.0.0.1:${daemon.lock.port}/auth/list`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ githubTokens: [], toolAuth: [] })
  })

  it('GET /project/:slug 404s for an unknown project', async () => {
    const res = await authedFetch(`http://127.0.0.1:${daemon.lock.port}/project/nope`)
    expect(res.status).toBe(404)
  })
})
