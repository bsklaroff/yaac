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
 * Durable tokens and the server-selection commands that consume them,
 * against one shared server.
 *
 * This needs no second machine: `yaac remote set` points at the spawned
 * server's own loopback origin, and the code path is identical to one
 * across the network — every server is an origin plus a durable token, so
 * there is no separate "local" path to miss. The two halves share a
 * fixture because the tokens minted below are the ones the selection cases
 * authenticate with.
 *
 * Every test shares one data dir, so state-sensitive ones reset first
 * (see `resetSelection`) and each mints its token under a distinct name.
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

  function configPath(): string {
    return path.join(`${testEnv.dataDir}-client`, 'server.json')
  }

  /**
   * Put the machine back to "pointed at the running server".
   *
   * Not `remote unset`: with no server selected NOTHING reaches the
   * server, not even the `auth token create` the next test starts with —
   * that is the point of the model, since a client has no lock to fall
   * back to. And not a restored copy of the file either: a test that
   * re-registers rotates the durable token, which would leave a snapshot
   * holding a revoked one. `yaac server start` re-derives it, reusing the
   * saved token when it still works.
   */
  async function resetSelection(): Promise<void> {
    for (const legacy of ['remote.json']) {
      await fs.rm(path.join(testEnv.dataDir, legacy), { force: true })
      await fs.rm(path.join(`${testEnv.dataDir}-client`, legacy), { force: true })
    }
    const res = await runYaac(testEnv.env, 'server', 'start')
    expect(res.exitCode, res.stderr).toBe(0)
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

      // The list is never empty: the start banner mints a one-time exchange
      // token, and this machine's own `local-client` token is what points it
      // at the server. Assert the revoked one is gone, not that none remain.
      const empty = await runYaac(testEnv.env, 'auth', 'token', 'list')
      expect(empty.exitCode).toBe(0)
      expect(empty.stdout).not.toContain('laptop')
      expect(empty.stdout).toContain('local-client')
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
    it('set → commands run via the token; revoking it breaks them, live lock or not', async () => {
      await resetSelection()
      const token = await mintToken('remote-laptop')

      const set = await runYaac(testEnv.env, 'remote', 'set', origin(), '--token', token)
      expect(set.exitCode, set.stderr).toBe(0)
      expect(set.stdout).toMatch(/Server selected/)

      const list = await runYaac(testEnv.env, 'project', 'list')
      expect(list.exitCode, list.stderr).toBe(0)

      // Revoking the token breaks every command even though the server is
      // up and its lock is live on this very machine: a client has no lock
      // to fall back to, and the message says how to fix it either way.
      const revoke = await runYaac(testEnv.env, 'auth', 'token', 'revoke', 'remote-laptop')
      expect(revoke.exitCode, revoke.stderr).toBe(0)

      const broken = await runYaac(testEnv.env, 'project', 'list')
      expect(broken.exitCode).toBe(1)
      expect(broken.stderr).toMatch(/rejected the token/)
      expect(broken.stderr).toMatch(/yaac server start/)
      expect(broken.stderr).toMatch(/yaac remote set/)

      await resetSelection()
      expect((await runYaac(testEnv.env, 'project', 'list')).exitCode).toBe(0)
    })

    it('`yaac server start` registers the server it finds already running', async () => {
      // The fixture spawned `yaac server run`, which registers nothing —
      // exactly like an operator running one in the foreground. `start` is
      // what points this machine at it, on the already-running path too.
      await resetSelection()
      await fs.rm(configPath(), { force: true })
      const orphaned = await runYaac(testEnv.env, 'project', 'list')
      expect(orphaned.exitCode).toBe(1)
      expect(orphaned.stderr).toMatch(/No yaac server selected/)

      const start = await runYaac(testEnv.env, 'server', 'start')
      expect(start.exitCode, start.stderr).toBe(0)
      expect(start.stderr).toMatch(/already running/)

      const status = await runYaac(testEnv.env, 'remote', 'status')
      expect(status.stdout).toContain(origin())
      expect(status.stdout).toMatch(/selected\s+yes/)
      // A durable token under the shared name, not the per-boot lock secret.
      expect((await runYaac(testEnv.env, 'auth', 'token', 'list')).stdout)
        .toContain('local-client')
      expect((await runYaac(testEnv.env, 'project', 'list')).exitCode).toBe(0)

      // And it is reused rather than rotated on the next start.
      const before = await fs.readFile(configPath(), 'utf8')
      expect((await runYaac(testEnv.env, 'server', 'start')).exitCode).toBe(0)
      expect(await fs.readFile(configPath(), 'utf8')).toBe(before)

      await resetSelection()
    })

    it('status shows the masked token; unset forgets it', async () => {
      await resetSelection()
      const token = await mintToken('phone')
      const set = await runYaac(testEnv.env, 'remote', 'set', origin(), '--token', token)
      expect(set.exitCode, set.stderr).toBe(0)

      const status = await runYaac(testEnv.env, 'remote', 'status')
      expect(status.exitCode).toBe(0)
      expect(status.stdout).toContain(origin())
      expect(status.stdout).toContain(`${token.slice(0, 8)}…`)
      expect(status.stdout).not.toContain(token)
      expect(status.stdout).toMatch(/selected\s+yes/)

      const unset = await runYaac(testEnv.env, 'remote', 'unset')
      expect(unset.exitCode).toBe(0)
      const after = await runYaac(testEnv.env, 'remote', 'status')
      expect(after.stdout).toMatch(/No server configured/)
      // And with none configured, nothing reaches a server at all.
      const stranded = await runYaac(testEnv.env, 'project', 'list')
      expect(stranded.exitCode).toBe(1)
      expect(stranded.stderr).toMatch(/No yaac server selected/)

      await resetSelection()
    })

    it('on / off deselect and reselect without re-entering the token', async () => {
      await resetSelection()
      const token = await mintToken('tablet')
      expect((await runYaac(testEnv.env, 'remote', 'set', origin(), '--token', token)).exitCode).toBe(0)

      const off = await runYaac(testEnv.env, 'remote', 'off')
      expect(off.exitCode).toBe(0)
      expect(off.stdout).toMatch(/No server selected/)
      expect((await runYaac(testEnv.env, 'remote', 'status')).stdout).toMatch(/selected\s+no/)
      // Deselected means unreachable — there is no local fallback to find.
      expect((await runYaac(testEnv.env, 'project', 'list')).exitCode).toBe(1)

      const on = await runYaac(testEnv.env, 'remote', 'on')
      expect(on.exitCode).toBe(0)
      expect((await runYaac(testEnv.env, 'remote', 'status')).stdout).toMatch(/selected\s+yes/)
      expect((await runYaac(testEnv.env, 'project', 'list')).exitCode).toBe(0)

      await resetSelection()
    })

    it('set fails fast on an unreachable URL and persists nothing', async () => {
      await resetSelection()
      const res = await runYaac(testEnv.env, 'remote', 'set', 'http://127.0.0.1:1', '--token', 'x')
      expect(res.exitCode).toBe(1)
      expect(res.stderr).toMatch(/cannot reach http:\/\/127\.0\.0\.1:1/)
      // Persists nothing: the selection is still the server that was there.
      const status = await runYaac(testEnv.env, 'remote', 'status')
      expect(status.stdout).toContain(origin())
      expect(status.stdout).not.toContain('127.0.0.1:1\n')
    })

    it('set rejects a bad token with minting guidance', async () => {
      await resetSelection()
      const res = await runYaac(testEnv.env, 'remote', 'set', origin(), '--token', 'f'.repeat(64))
      expect(res.exitCode).toBe(1)
      expect(res.stderr).toMatch(/token rejected/)
      expect(res.stderr).toMatch(/yaac auth token create/)
      await resetSelection()
    })

    it('reads remote.json at both older paths, and migrates them on write', async () => {
      // The file was `remote.json` before it could name a server on this
      // machine, and lived INSIDE the data dir before the client-local tier
      // existed. Dropping either silently would leave every command unable
      // to reach a running server with no hint why — see
      // docs/legacy-compat-shims.md.
      for (const legacy of [
        path.join(testEnv.dataDir, 'remote.json'),
        path.join(`${testEnv.dataDir}-client`, 'remote.json'),
      ]) {
        await resetSelection()
        const token = await mintToken(`legacy-${path.basename(path.dirname(legacy))}`)
        await fs.rm(configPath(), { force: true })
        await fs.writeFile(legacy, JSON.stringify({
          url: origin(), token, enabled: true, saved: [],
        }), { mode: 0o600 })

        // Read through the real CLI, which is the whole point: a client that
        // resolves its target has to find it at the old path.
        const status = await runYaac(testEnv.env, 'remote', 'status')
        expect(status.exitCode, status.stderr).toBe(0)
        expect(status.stdout).toContain(origin())
        expect((await runYaac(testEnv.env, 'project', 'list')).exitCode).toBe(0)

        // The next write moves it to server.json, and takes the bearer
        // token with it rather than stranding a live credential.
        expect((await runYaac(testEnv.env, 'remote', 'off')).exitCode).toBe(0)
        await expect(fs.access(configPath())).resolves.toBeUndefined()
        await expect(fs.access(legacy)).rejects.toThrow()
      }

      await resetSelection()
    })

    it('the install driver survives `remote unset`, so a k8s install stays refused', async () => {
      // `driver` shares server.json with the selection. Forgetting the
      // servers must not forget which command stands this one up.
      await resetSelection()
      expect((await runYaac(testEnv.env, 'remote', 'unset')).exitCode).toBe(0)
      const raw = JSON.parse(await fs.readFile(configPath(), 'utf8')) as { driver?: string }
      expect(raw.driver).toBe('containerless')
      await resetSelection()
    })

    it('yaac open --no-browser prints the remote-derived URL', async () => {
      await resetSelection()
      const token = await mintToken('opener')
      expect((await runYaac(testEnv.env, 'remote', 'set', origin(), '--token', token)).exitCode).toBe(0)

      const open = await runYaac(testEnv.env, 'open', '--no-browser')
      expect(open.exitCode, open.stderr).toBe(0)
      expect(open.stdout.trim()).toMatch(
        new RegExp(`^${origin().replace(/[.:/]/g, '\\$&')}/\\?token=[0-9a-f]+$`),
      )
    })

    it('`yaac open` starts nothing when no server is selected', async () => {
      // It used to auto-start one. Now `yaac server start` is the only
      // starter, so this reports and exits rather than spawning a process
      // beside whatever the install actually runs.
      await resetSelection()
      await fs.rm(configPath(), { force: true })
      const open = await runYaac(testEnv.env, 'open', '--no-browser')
      expect(open.exitCode).toBe(1)
      expect(open.stderr).toMatch(/No yaac server selected/)
      await resetSelection()
    })
  })
})
