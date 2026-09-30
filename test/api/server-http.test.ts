import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import {
  createYaacTestEnv,
  spawnYaacServer,
  type YaacTestEnv,
  type SpawnedServer,
} from '@yaac/test-utils/cli'
import { makeServerApiClient } from '@yaac/test-utils/api'
import { clusterAvailable } from '@yaac/test-utils/setup'

/**
 * Response shapes the CLI relies on, checked through the typed RPC client
 * against a spawned server. The server boots without a cluster, so most
 * cases run anywhere; those needing a pod listing are skipped without one.
 */
const haveCluster = await clusterAvailable()
describe('yaac server HTTP surface (real server)', () => {
  let testEnv: YaacTestEnv
  let server: SpawnedServer
  let client: ReturnType<typeof makeServerApiClient>

  // One server for the file; no case mutates state. It admits a tailnet
  // name, so requests reach the identity gate instead of the Host guard.
  beforeAll(async () => {
    testEnv = await createYaacTestEnv()
    server = await spawnYaacServer({ ...testEnv.env, YAAC_ALLOWED_HOSTS: 'srv.tailnet.ts.net' })
    client = makeServerApiClient(server)
  })

  afterAll(async () => {
    await server.stop()
    await testEnv.cleanup()
  })

  it('refuses /project/list to a caller it cannot identify', async () => {
    // A tailnet name without tailscale serve has no identity. A raw
    // request, because fetch() silently drops a Host override.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: server.lock.port, path: '/api/project/list',
        headers: { host: 'srv.tailnet.ts.net' },
      }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(401)
  })

  it('returns the empty project list to a local caller', async () => {
    const res = await client.project.list.$get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('GET /workspace/list?project=missing returns 404 NOT_FOUND', async () => {
    const res = await client.workspace.list.$get({ query: { project: 'missing' } })
    expect(res.status).toBe(404)
    const body = await res.json() as unknown as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })

  // Without a cluster this answers RUNTIME_UNAVAILABLE instead.
  it.skipIf(!haveCluster)('GET /workspace/:id/blocked-hosts returns 404 for an unknown workspace', async () => {
    const res = await client.workspace[':id']['blocked-hosts'].$get({ param: { id: 'deadbeef' } })
    expect(res.status).toBe(404)
  })

  it('GET /prewarm is gone (removed with the kubernetes migration)', async () => {
    // The typed client has no such route, so request the path raw.
    const res = await fetch(`http://127.0.0.1:${server.lock.port}/prewarm`)
    expect(res.status).toBe(404)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('GET /auth/list returns empty arrays when nothing is configured', async () => {
    const res = await client.auth.list.$get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ gitCredentials: [], toolAuth: [] })
  })

  it('GET /project/:slug 404s for an unknown project', async () => {
    const res = await client.project[':slug'].$get({ param: { slug: 'nope' } })
    expect(res.status).toBe(404)
  })
})
