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
 * The server-selection commands, against one shared server.
 *
 * This needs no second machine: `yaac remote set` points at the spawned
 * server's own loopback origin, and the code path is identical to one
 * across the network — every server is an origin, so there is no separate
 * "local" path to miss. What a device across the tailnet adds is only who
 * it is, which the api tier's identity-flow covers against a real server,
 * and `remote set`'s refusal of an unidentified device is a unit case —
 * this tier cannot address a test server by a tailnet name.
 *
 * Every test shares one data dir, so state-sensitive ones reset first
 * (see `resetSelection`).
 */
describe('yaac remote (real CLI + shared server)', () => {
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

  function origin(): string {
    return `http://127.0.0.1:${server.lock.port}`
  }

  function configPath(): string {
    return path.join(`${testEnv.dataDir}-client`, 'server.json')
  }

  /**
   * Put the machine back to "pointed at the running server". Not
   * `remote unset`, which would point it at nothing: `yaac server start`
   * re-registers the server it finds running.
   */
  async function resetSelection(): Promise<void> {
    const res = await runYaac(testEnv.env, 'server', 'start')
    expect(res.exitCode, res.stderr).toBe(0)
  }

  describe('yaac remote', () => {
    it('set → commands reach the server it names', async () => {
      await resetSelection()
      await fs.rm(configPath(), { force: true })
      expect((await runYaac(testEnv.env, 'project', 'list')).exitCode).toBe(1)

      const set = await runYaac(testEnv.env, 'remote', 'set', origin())
      expect(set.exitCode, set.stderr).toBe(0)
      // A loopback caller is local, so there is no tailnet user to name.
      expect(set.stdout.trim()).toBe(`Server selected: ${origin()}`)
      expect((await runYaac(testEnv.env, 'project', 'list')).exitCode).toBe(0)

      await resetSelection()
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
      expect((await runYaac(testEnv.env, 'project', 'list')).exitCode).toBe(0)

      await resetSelection()
    })

    it('status shows the selection; unset forgets it', async () => {
      await resetSelection()
      const status = await runYaac(testEnv.env, 'remote', 'status')
      expect(status.exitCode).toBe(0)
      expect(status.stdout).toContain(origin())
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

    it('on / off deselect and reselect without re-entering the server', async () => {
      await resetSelection()

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
      const res = await runYaac(testEnv.env, 'remote', 'set', 'http://127.0.0.1:1')
      expect(res.exitCode).toBe(1)
      expect(res.stderr).toMatch(/cannot reach http:\/\/127\.0\.0\.1:1/)
      // Persists nothing: the selection is still the server that was there.
      const status = await runYaac(testEnv.env, 'remote', 'status')
      expect(status.stdout).toContain(origin())
      expect(status.stdout).not.toContain('127.0.0.1:1\n')
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
  })
})
