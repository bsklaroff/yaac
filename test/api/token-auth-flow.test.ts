import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  createYaacTestEnv,
  spawnYaacServer,
  type YaacTestEnv,
  type SpawnedServer,
} from '@yaac/test-utils/cli'

/**
 * The durable-token lifecycle over the real server HTTP surface: mint
 * with the lock secret (the loopback bootstrap path), authenticate with
 * the token instead of the secret, revoke, and observe the token die
 * while the lock secret keeps working. Also pins persistence: the server
 * DB directory lands in the data dir at 0700 (tokens are plaintext inside).
 */
describe('durable token auth flow (real server)', () => {
  let testEnv: YaacTestEnv
  let server: SpawnedServer

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
    server = await spawnYaacServer(testEnv.env)
  })

  afterEach(async () => {
    await server.stop()
    await testEnv.cleanup()
  })

  function url(p: string): string {
    return `http://127.0.0.1:${server.lock.port}${p}`
  }

  it('mint → authenticate → list masked → revoke → token rejected', async () => {
    const create = await fetch(url('/tokens'), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${server.lock.secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'laptop' }),
    })
    expect(create.status).toBe(201)
    const entry = await create.json() as { name: string; token: string }
    expect(entry.token).toMatch(/^[0-9a-f]{64}$/)

    // The token authenticates a protected route.
    const viaToken = await fetch(url('/project/list'), {
      headers: { authorization: `Bearer ${entry.token}` },
    })
    expect(viaToken.status).toBe(200)

    // Persisted for the next server boot: the DB dir exists at 0700 (the
    // server is a separate process holding the single-process PGlite, so
    // the rows themselves are asserted via behavior, not read here).
    const stat = await fs.stat(path.join(testEnv.dataDir, 'db'))
    expect(stat.isDirectory()).toBe(true)
    expect(stat.mode & 0o777).toBe(0o700)

    // List (via the token itself) masks the value. Alongside the durable
    // token sits the one-time entry the server's start banner minted.
    const list = await fetch(url('/tokens'), {
      headers: { authorization: `Bearer ${entry.token}` },
    })
    expect(list.status).toBe(200)
    const listBody = await list.json() as { tokens: Array<{ name: string; kind: string; masked: string }> }
    expect(listBody.tokens.filter((t) => t.kind === 'durable')).toHaveLength(1)
    expect(listBody.tokens.filter((t) => t.kind === 'one-time')).toHaveLength(1)
    expect(JSON.stringify(listBody)).not.toContain(entry.token)

    // Revoke, then the token is a BAD_BEARER while the lock secret works.
    const del = await fetch(url('/tokens/laptop'), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${server.lock.secret}` },
    })
    expect(del.status).toBe(204)

    const revoked = await fetch(url('/project/list'), {
      headers: { authorization: `Bearer ${entry.token}` },
    })
    expect(revoked.status).toBe(401)
    const body = await revoked.json() as { error: { code: string } }
    expect(body.error.code).toBe('BAD_BEARER')

    const viaSecret = await fetch(url('/project/list'), {
      headers: { authorization: `Bearer ${server.lock.secret}` },
    })
    expect(viaSecret.status).toBe(200)
  })

  it('duplicate names conflict and unknown revokes 404', async () => {
    const mk = (): Promise<Response> => fetch(url('/tokens'), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${server.lock.secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'dev' }),
    })
    expect((await mk()).status).toBe(201)
    const dup = await mk()
    expect(dup.status).toBe(409)

    const missing = await fetch(url('/tokens/ghost'), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${server.lock.secret}` },
    })
    expect(missing.status).toBe(404)
  })
})
