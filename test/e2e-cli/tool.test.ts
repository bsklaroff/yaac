import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createYaacTestEnv, spawnYaacDaemon, runYaac, type YaacTestEnv, type SpawnedDaemon } from '@test/helpers/cli'

describe('yaac tool (real CLI + real daemon)', () => {
  let testEnv: YaacTestEnv
  let daemon: SpawnedDaemon

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
    daemon = await spawnYaacDaemon(testEnv.env)
  })

  afterEach(async () => {
    await daemon.stop()
    await testEnv.cleanup()
  })

  it('tool get reports the unconfigured state on a clean data dir', async () => {
    const { stdout, exitCode } = await runYaac(testEnv.env, 'tool', 'get')
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/No default tool configured/)
  })

  it('tool set then tool get round-trips via the daemon', async () => {
    const setResult = await runYaac(testEnv.env, 'tool', 'set', 'claude')
    expect(setResult.exitCode).toBe(0)
    expect(setResult.stdout).toMatch(/claude/)

    const getResult = await runYaac(testEnv.env, 'tool', 'get')
    expect(getResult.exitCode).toBe(0)
    expect(getResult.stdout.trim()).toBe('claude')
  })

  it('tool set rejects an unknown tool', async () => {
    const { exitCode, stderr } = await runYaac(testEnv.env, 'tool', 'set', 'bogus')
    expect(exitCode).not.toBe(0)
    expect(stderr.length).toBeGreaterThan(0)
  })
})
