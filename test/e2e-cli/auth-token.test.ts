import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createYaacTestEnv,
  spawnYaacServer,
  runYaac,
  type YaacTestEnv,
  type SpawnedServer,
} from '@yaac/test-utils/cli'

describe('yaac auth token (real CLI + real server)', () => {
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

  it('create prints the token once, list masks it, revoke removes it', async () => {
    const create = await runYaac(testEnv.env, 'auth', 'token', 'create', 'laptop')
    expect(create.exitCode, create.stderr).toBe(0)
    const token = create.stdout.trim()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(create.stderr).toMatch(/shown only once/i)

    const list = await runYaac(testEnv.env, 'auth', 'token', 'list')
    expect(list.exitCode, list.stderr).toBe(0)
    expect(list.stdout).toContain('laptop')
    expect(list.stdout).toContain(`${token.slice(0, 8)}…`)
    expect(list.stdout).not.toContain(token)

    const revoke = await runYaac(testEnv.env, 'auth', 'token', 'revoke', 'laptop')
    expect(revoke.exitCode, revoke.stderr).toBe(0)
    expect(revoke.stdout).toMatch(/Revoked token 'laptop'/)

    // The start banner always mints a one-time exchange token, so the
    // list is never empty — assert the durable token is gone instead.
    const empty = await runYaac(testEnv.env, 'auth', 'token', 'list')
    expect(empty.exitCode).toBe(0)
    expect(empty.stdout).not.toContain('laptop')
    expect(empty.stdout).not.toMatch(/durable/)
  })

  it('duplicate create fails with the conflict message', async () => {
    expect((await runYaac(testEnv.env, 'auth', 'token', 'create', 'dev')).exitCode).toBe(0)
    const dup = await runYaac(testEnv.env, 'auth', 'token', 'create', 'dev')
    expect(dup.exitCode).toBe(1)
    expect(dup.stderr).toMatch(/already exists/)
  })

  it('revoking an unknown token exits 1 with NOT_FOUND messaging', async () => {
    const res = await runYaac(testEnv.env, 'auth', 'token', 'revoke', 'ghost')
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toMatch(/no token named 'ghost'/)
  })

  it('an invalid name is rejected by the server validation', async () => {
    const res = await runYaac(testEnv.env, 'auth', 'token', 'create', 'bad name!')
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toMatch(/invalid token name/)
  })
})
