import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createYaacTestEnv, spawnYaacDaemon, runYaac, type YaacTestEnv, type SpawnedDaemon } from '@test/helpers/cli'

describe('yaac open (real CLI + real daemon)', () => {
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

  it('open --no-browser prints an authenticated webapp URL with a bootstrap code', async () => {
    const { stdout, exitCode } = await runYaac(testEnv.env, 'open', '--no-browser')
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/http:\/\/127\.0\.0\.1:\d+\/\?bootstrap=[a-f0-9]{64}/)
  })
})
