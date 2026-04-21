import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readLock } from '@/shared/lock'
import { createYaacTestEnv, spawnYaacDaemon, runYaac, type YaacTestEnv, type SpawnedDaemon } from '@test/helpers/cli'

describe('yaac daemon lifecycle (real CLI + real daemon)', () => {
  let testEnv: YaacTestEnv
  let daemon: SpawnedDaemon | null = null

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
  })

  afterEach(async () => {
    if (daemon) await daemon.stop()
    daemon = null
    await testEnv.cleanup()
  })

  it('the daemon binds and /health responds with ok', async () => {
    daemon = await spawnYaacDaemon(testEnv.env)
    expect(daemon.lock.port).toBeGreaterThan(0)

    const res = await fetch(`http://127.0.0.1:${daemon.lock.port}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
  })

  it('stopping the daemon removes the lock', async () => {
    daemon = await spawnYaacDaemon(testEnv.env)
    expect(await readLock()).not.toBeNull()
    await daemon.stop()
    daemon = null
    expect(await readLock()).toBeNull()
  })

  it('runYaac can issue a command against the spawned daemon', async () => {
    daemon = await spawnYaacDaemon(testEnv.env)
    const { stdout, exitCode } = await runYaac(testEnv.env, 'project', 'list')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('No projects found')
  })
})
