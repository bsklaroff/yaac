import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  createYaacTestEnv,
  spawnYaacServer,
  runYaac,
  type YaacTestEnv,
  type SpawnedServer,
} from '@yaac/test-utils/cli'

/**
 * Durable tokens and the remote path that consumes them, against one
 * shared server.
 *
 * The remote path needs no second machine: `yaac remote set` points at
 * the spawned server's own loopback origin, authenticated by a durable
 * token instead of the lock secret. The Host header the CLI sends is
 * loopback, which the host check allows unconditionally, so this is the
 * full remote code path minus the network in between — which is also why
 * the two halves share a fixture: the tokens minted below are the ones
 * the remote cases authenticate with.
 *
 * Every test shares one data dir, so state-sensitive ones reset first
 * (see `resetRemote`) and each mints its token under a distinct name.
 */
describe('yaac auth token + remote (real CLI + shared server)', () => {
  let testEnv: YaacTestEnv
  let server: SpawnedServer

  beforeAll(async () => {
    testEnv = await createYaacTestEnv()
    server = await spawnYaacServer(testEnv.env)
  })

  afterAll(async () => {
    await server.stop()
    await testEnv.cleanup()
  })

  async function mintToken(name: string): Promise<string> {
    const res = await runYaac(testEnv.env, 'auth', 'token', 'create', name)
    expect(res.exitCode, res.stderr).toBe(0)
    return res.stdout.trim()
  }

  function origin(): string {
    return `http://127.0.0.1:${server.lock.port}`
  }

  /**
   * Drop any remote the previous test configured. Without this a live
   * remote would route the next test's own `auth token create` through
   * the remote path instead of the local lock, and the "persists
   * nothing" assertions would see a leftover origin.
   */
  async function resetRemote(): Promise<void> {
    await runYaac(testEnv.env, 'remote', 'unset')
  }

  describe('yaac auth token', () => {
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

  describe('yaac remote', () => {
    it('set → commands run via the token; revoke kills them while the lock stays live', async () => {
      await resetRemote()
      const token = await mintToken('remote-laptop')

      const set = await runYaac(testEnv.env, 'remote', 'set', origin(), '--token', token)
      expect(set.exitCode, set.stderr).toBe(0)
      expect(set.stdout).toMatch(/Remote set and enabled/)

      const list = await runYaac(testEnv.env, 'project', 'list')
      expect(list.exitCode, list.stderr).toBe(0)

      // Revoking the token breaks the remote path even though the local
      // lock is still live — proof the remote (not the lock) served it.
      const revoke = await runYaac(testEnv.env, 'auth', 'token', 'revoke', 'remote-laptop')
      expect(revoke.exitCode, revoke.stderr).toBe(0)

      const broken = await runYaac(testEnv.env, 'project', 'list')
      expect(broken.exitCode).toBe(1)
      expect(broken.stderr).toMatch(/rejected the token/)
      expect(broken.stderr).toMatch(/yaac remote set/)

      // remote off → falls back to the local lock and works again.
      const off = await runYaac(testEnv.env, 'remote', 'off')
      expect(off.exitCode, off.stderr).toBe(0)
      const viaLock = await runYaac(testEnv.env, 'project', 'list')
      expect(viaLock.exitCode, viaLock.stderr).toBe(0)
    })

    it('status shows the masked token; unset forgets it', async () => {
      await resetRemote()
      const token = await mintToken('phone')
      const set = await runYaac(testEnv.env, 'remote', 'set', origin(), '--token', token)
      expect(set.exitCode, set.stderr).toBe(0)

      const status = await runYaac(testEnv.env, 'remote', 'status')
      expect(status.exitCode).toBe(0)
      expect(status.stdout).toContain(origin())
      expect(status.stdout).toContain(`${token.slice(0, 8)}…`)
      expect(status.stdout).not.toContain(token)
      expect(status.stdout).toMatch(/enabled\s+yes/)

      const unset = await runYaac(testEnv.env, 'remote', 'unset')
      expect(unset.exitCode).toBe(0)
      const after = await runYaac(testEnv.env, 'remote', 'status')
      expect(after.stdout).toMatch(/No remote configured/)
    })

    it('on / off toggle the remote without re-entering the token', async () => {
      await resetRemote()
      const token = await mintToken('tablet')
      expect((await runYaac(testEnv.env, 'remote', 'set', origin(), '--token', token)).exitCode).toBe(0)

      const off = await runYaac(testEnv.env, 'remote', 'off')
      expect(off.exitCode).toBe(0)
      expect((await runYaac(testEnv.env, 'remote', 'status')).stdout).toMatch(/enabled\s+no/)

      const on = await runYaac(testEnv.env, 'remote', 'on')
      expect(on.exitCode).toBe(0)
      expect((await runYaac(testEnv.env, 'remote', 'status')).stdout).toMatch(/enabled\s+yes/)
      expect((await runYaac(testEnv.env, 'project', 'list')).exitCode).toBe(0)
    })

    it('set fails fast on an unreachable URL and persists nothing', async () => {
      await resetRemote()
      const res = await runYaac(testEnv.env, 'remote', 'set', 'http://127.0.0.1:1', '--token', 'x')
      expect(res.exitCode).toBe(1)
      expect(res.stderr).toMatch(/cannot reach http:\/\/127\.0\.0\.1:1/)
      expect((await runYaac(testEnv.env, 'remote', 'status')).stdout).toMatch(/No remote configured/)
    })

    it('set rejects a bad token with minting guidance', async () => {
      await resetRemote()
      const res = await runYaac(testEnv.env, 'remote', 'set', origin(), '--token', 'f'.repeat(64))
      expect(res.exitCode).toBe(1)
      expect(res.stderr).toMatch(/token rejected/)
      expect(res.stderr).toMatch(/yaac auth token create/)
    })

    it('reads a pre-split remote.json from the data dir, and migrates it on write', async () => {
      // remote.json is CLIENT-LOCAL now (beside the data dir), but an
      // install upgraded from before that tier existed still has one INSIDE
      // it. Dropping it silently would leave every command unable to reach
      // an in-cluster server with no hint why — see
      // docs/legacy-compat-shims.md.
      await resetRemote()
      const token = await mintToken('legacy-reader')
      const legacy = path.join(testEnv.dataDir, 'remote.json')
      const current = path.join(`${testEnv.dataDir}-client`, 'remote.json')
      await fs.rm(current, { force: true })
      await fs.writeFile(legacy, JSON.stringify({
        url: origin(), token, enabled: true, saved: [],
      }), { mode: 0o600 })

      // Read through the real CLI, which is the whole point: a client that
      // resolves its target has to find it at the old path.
      const status = await runYaac(testEnv.env, 'remote', 'status')
      expect(status.exitCode, status.stderr).toBe(0)
      expect(status.stdout).toContain(origin())
      expect((await runYaac(testEnv.env, 'project', 'list')).exitCode).toBe(0)

      // The next write moves it, and takes the bearer token with it.
      expect((await runYaac(testEnv.env, 'remote', 'off')).exitCode).toBe(0)
      await expect(fs.access(current)).resolves.toBeUndefined()
      await expect(fs.access(legacy)).rejects.toThrow()

      await resetRemote()
    })

    it('yaac open --no-browser prints the remote-derived URL', async () => {
      await resetRemote()
      const token = await mintToken('opener')
      expect((await runYaac(testEnv.env, 'remote', 'set', origin(), '--token', token)).exitCode).toBe(0)

      const open = await runYaac(testEnv.env, 'open', '--no-browser')
      expect(open.exitCode, open.stderr).toBe(0)
      expect(open.stdout.trim()).toMatch(
        new RegExp(`^${origin().replace(/[.:/]/g, '\\$&')}/\\?token=[0-9a-f]+$`),
      )
    })
  })
})
