import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import {
  createYaacTestEnv,
  spawnYaacDaemon,
  runYaac,
  type YaacTestEnv,
  type SpawnedDaemon,
} from '@test/helpers/cli'
import { requirePodman } from '@test/helpers/setup'

describe('yaac session shell (real CLI + real daemon)', () => {
  beforeAll(async () => {
    await requirePodman()
  })

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

  it('errors with NOT_FOUND for a bogus session id', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'session', 'shell', 'definitely-bogus-id',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/not found/i)
  })
})
