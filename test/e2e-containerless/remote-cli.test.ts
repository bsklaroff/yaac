import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import {
  createYaacTestEnv,
  spawnYaacServer,
  runYaac,
  type YaacTestEnv,
  type SpawnedServer,
} from '@yaac/test-utils/cli'

/**
 * The server-selection commands, against one shared server. `yaac remote
 * add` points at the server's loopback origin, which takes the same code
 * path as a remote one (docs/server-selection.md). Tailnet identity is
 * covered by the api tier and unit tests instead.
 *
 * Tests share one data dir, so each resets first (`resetSelection`).
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

  function recordPath(): string {
    return path.join(testEnv.dataDir, 'install.json')
  }

  /** Point the client back at the running server (`server start` re-registers it). */
  async function resetSelection(): Promise<void> {
    const res = await runYaac(testEnv.env, 'server', 'start')
    expect(res.exitCode, res.stderr).toBe(0)
  }

  describe('yaac remote', () => {
    it('add → commands reach the server it names', async () => {
      await resetSelection()
      await fs.rm(configPath(), { force: true })
      expect((await runYaac(testEnv.env, 'project', 'list')).exitCode).toBe(1)

      const add = await runYaac(testEnv.env, 'remote', 'add', origin())
      expect(add.exitCode, add.stderr).toBe(0)
      // A loopback caller is local, so there is no tailnet user to name.
      expect(add.stdout.trim()).toBe(`Server selected: ${origin()}`)
      expect((await runYaac(testEnv.env, 'project', 'list')).exitCode).toBe(0)

      await resetSelection()
    })

    it('`yaac server start` registers the server it finds already running', async () => {
      // The fixture spawned `yaac server run`, which registers nothing.
      await resetSelection()
      await fs.rm(configPath(), { force: true })
      const orphaned = await runYaac(testEnv.env, 'project', 'list')
      expect(orphaned.exitCode).toBe(1)
      expect(orphaned.stderr).toMatch(/No yaac server selected/)

      const start = await runYaac(testEnv.env, 'server', 'start')
      expect(start.exitCode, start.stderr).toBe(0)
      expect(start.stderr).toMatch(/already running/)

      const list = await runYaac(testEnv.env, 'remote', 'list')
      expect(list.stdout).toContain(`* ${origin()}`)
      expect((await runYaac(testEnv.env, 'project', 'list')).exitCode).toBe(0)

      await resetSelection()
    })

    it('list marks the selection; remove forgets a server but not the install record', async () => {
      await resetSelection()
      const list = await runYaac(testEnv.env, 'remote', 'list')
      expect(list.exitCode).toBe(0)
      expect(list.stdout).toContain(`* ${origin()}`)

      const refused = await runYaac(testEnv.env, 'remote', 'remove', origin())
      expect(refused.exitCode).toBe(1)
      expect(refused.stderr).toMatch(/selected server/)

      expect((await runYaac(testEnv.env, 'remote', 'disconnect')).exitCode).toBe(0)
      const removed = await runYaac(testEnv.env, 'remote', 'remove', origin())
      expect(removed.exitCode, removed.stderr).toBe(0)
      expect((await runYaac(testEnv.env, 'remote', 'list')).stdout).toMatch(/No servers saved/)
      const unknown = await runYaac(testEnv.env, 'remote', 'remove', origin())
      expect(unknown.exitCode).toBe(1)
      expect(unknown.stderr).toMatch(/Unknown server/)
      const stranded = await runYaac(testEnv.env, 'project', 'list')
      expect(stranded.exitCode).toBe(1)
      expect(stranded.stderr).toMatch(/No yaac server selected/)
      // `driver` lives in the data dir's install.json alone, so forgetting
      // every server keeps it, and a k8s install stays refused.
      const raw = JSON.parse(await fs.readFile(recordPath(), 'utf8')) as { driver?: string }
      expect(raw.driver).toBe('containerless')

      await resetSelection()
    })

    it('disconnect / connect deselect and reselect a saved server', async () => {
      await resetSelection()

      const off = await runYaac(testEnv.env, 'remote', 'disconnect')
      expect(off.exitCode).toBe(0)
      expect(off.stdout).toMatch(/No server selected/)
      const list = await runYaac(testEnv.env, 'remote', 'list')
      expect(list.stdout).toContain(`  ${origin()}`)
      expect(list.stdout).toMatch(/No server selected/)
      // No local fallback when deselected.
      expect((await runYaac(testEnv.env, 'project', 'list')).exitCode).toBe(1)

      // Only a saved server can be connected to.
      const unknown = await runYaac(testEnv.env, 'remote', 'connect', 'http://127.0.0.1:1')
      expect(unknown.exitCode).toBe(1)
      expect(unknown.stderr).toMatch(/yaac remote add http:\/\/127\.0\.0\.1:1/)

      const on = await runYaac(testEnv.env, 'remote', 'connect', origin())
      expect(on.exitCode, on.stderr).toBe(0)
      expect((await runYaac(testEnv.env, 'remote', 'list')).stdout).toContain(`* ${origin()}`)
      expect((await runYaac(testEnv.env, 'project', 'list')).exitCode).toBe(0)

      await resetSelection()
    })

    it('add fails fast on an unreachable URL and persists nothing', async () => {
      await resetSelection()
      const res = await runYaac(testEnv.env, 'remote', 'add', 'http://127.0.0.1:1')
      expect(res.exitCode).toBe(1)
      expect(res.stderr).toMatch(/cannot reach http:\/\/127\.0\.0\.1:1/)
      const list = await runYaac(testEnv.env, 'remote', 'list')
      expect(list.stdout).toContain(`* ${origin()}`)
      expect(list.stdout).not.toContain('127.0.0.1:1\n')
    })

    // A loopback origin can still be another machine's server, reached
    // through a tunnel such as `ssh -L`.
    it('a remote server\'s driver does not decide `yaac cluster install`', async () => {
      const remote = http.createServer((_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, driver: 'containerless' }))
      })
      await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve))
      await resetSelection()
      const saved = await fs.readFile(configPath(), 'utf8')
      const record = await fs.readFile(recordPath(), 'utf8')
      try {
        const { port } = remote.address() as { port: number }
        const url = `http://127.0.0.1:${port}`
        await fs.writeFile(configPath(), JSON.stringify({ url, saved: [{ url }] }))
        await fs.writeFile(recordPath(), JSON.stringify({ driver: 'k8s' }))
        // An invalid --nodes stops the install before it touches a
        // cluster, so reaching its message proves the refusal was skipped.
        const res = await runYaac(testEnv.env, 'cluster', 'install', '--nodes', '0')
        expect(res.exitCode).toBe(1)
        expect(res.stderr).not.toContain('containerless')
        expect(res.stderr).toContain('--nodes must be an integer')
      } finally {
        remote.close()
        // `server start` would refuse the k8s record, so restore by hand.
        await fs.writeFile(configPath(), saved)
        await fs.writeFile(recordPath(), record)
      }
    })
  })
})
