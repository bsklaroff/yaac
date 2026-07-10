import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createYaacTestEnv,
  spawnYaacDaemon,
  type YaacTestEnv,
  type SpawnedDaemon,
} from '@test/helpers/cli'
import { makeDaemonRpcClient } from '@test/helpers/rpc'
import { clusterAvailable } from '@test/helpers/setup'

/**
 * HTTP-surface tests for the spawned daemon. These don't exercise the
 * CLI directly — they hit the daemon's bearer-guarded endpoints via
 * the typed RPC client to verify the response shapes the CLI relies on.
 *
 * The daemon itself boots without a cluster (its bootstrap is
 * best-effort), so most cases run anywhere; the few routes whose
 * NOT_FOUND path requires a pod listing are skipped when no cluster is
 * reachable.
 */
const haveCluster = await clusterAvailable()
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

  it('rejects /project/list without a bearer token or cookie', async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.lock.port}/project/list`)
    expect(res.status).toBe(401)
    const body = await res.json() as unknown as { error: { code: string } }
    // No credential at all → the generic code (a wrong bearer gets
    // BAD_BEARER instead, tested below).
    expect(body.error.code).toBe('UNAUTHENTICATED')
  })

  it('rejects a wrong bearer with BAD_BEARER', async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.lock.port}/project/list`, {
      headers: { authorization: 'Bearer not-the-secret' },
    })
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

  // Session resolution lists pods via kubectl, so this NOT_FOUND path
  // needs a reachable cluster (without one it maps to RUNTIME_UNAVAILABLE).
  it.skipIf(!haveCluster)('GET /session/:id/blocked-hosts returns 404 for an unknown session', async () => {
    const res = await client.session[':id']['blocked-hosts'].$get({ param: { id: 'deadbeef' } })
    expect(res.status).toBe(404)
  })

  it('GET /prewarm is gone (removed with the kubernetes migration)', async () => {
    // The route was deleted along with the prewarm feature; the typed RPC
    // client no longer exposes it, so hit the path raw and expect the
    // uniform 404.
    const res = await fetch(`http://127.0.0.1:${daemon.lock.port}/prewarm`, {
      headers: { authorization: `Bearer ${daemon.lock.secret}` },
    })
    expect(res.status).toBe(404)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('GET /tool/get returns {tool:null} when no default is configured', async () => {
    const res = await client.tool.get.$get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tool: null })
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
