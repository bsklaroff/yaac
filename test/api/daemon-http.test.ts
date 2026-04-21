import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createYaacTestEnv,
  spawnYaacDaemon,
  type YaacTestEnv,
  type SpawnedDaemon,
} from '@test/helpers/cli'
import { makeDaemonRpcClient } from '@test/helpers/rpc'

/**
 * HTTP-surface tests for the spawned daemon. These don't exercise the
 * CLI directly — they hit the daemon's bearer-guarded endpoints via
 * the typed RPC client to verify the response shapes the CLI relies on.
 */
describe('yaac daemon HTTP surface (real daemon)', () => {
  let testEnv: YaacTestEnv
  let daemon: SpawnedDaemon
  let client: ReturnType<typeof makeDaemonRpcClient>

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
    daemon = await spawnYaacDaemon(testEnv.env)
    client = makeDaemonRpcClient(daemon)
  })

  afterEach(async () => {
    await daemon.stop()
    await testEnv.cleanup()
  })

  it('rejects /project/list without a bearer token', async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.lock.port}/project/list`)
    expect(res.status).toBe(401)
    const body = await res.json() as unknown as { error: { code: string } }
    expect(body.error.code).toBe('BAD_BEARER')
  })

  it('returns the empty project list with the correct bearer', async () => {
    const res = await client.project.list.$get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('GET /session/list?project=missing returns 404 NOT_FOUND', async () => {
    const res = await client.session.list.$get({ query: { project: 'missing' } })
    expect(res.status).toBe(404)
    const body = await res.json() as unknown as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('GET /session/:id/blocked-hosts returns 404 for an unknown session', async () => {
    const res = await client.session[':id']['blocked-hosts'].$get({ param: { id: 'deadbeef' } })
    expect(res.status).toBe(404)
  })

  it('GET /prewarm returns {} on a clean data dir', async () => {
    const res = await client.prewarm.$get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })

  it('GET /tool/get returns {tool:null} when no default is configured', async () => {
    const res = await client.tool.get.$get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tool: null })
  })

  it('GET /auth/list returns empty arrays when nothing is configured', async () => {
    const res = await client.auth.list.$get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ githubTokens: [], toolAuth: [] })
  })

  it('GET /project/:slug 404s for an unknown project', async () => {
    const res = await client.project[':slug'].$get({ param: { slug: 'nope' } })
    expect(res.status).toBe(404)
  })
})
