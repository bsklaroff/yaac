import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import {
  createYaacTestEnv,
  spawnYaacDaemon,
  runYaac,
  type YaacTestEnv,
  type SpawnedDaemon,
} from '@test/helpers/cli'
import { requirePodman, requireCluster } from '@test/helpers/setup'

describe('yaac session delete (real CLI + real daemon)', () => {
  // Session resolution lists pods/jobs via kubectl, so the NOT_FOUND path
  // needs a reachable cluster even though no session is ever created.
  beforeAll(async () => {
    await requirePodman()
    await requireCluster()
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

  it('errors with NOT_FOUND when no session matches the id', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'session', 'delete', 'definitely-no-such-session',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/No session found/i)
  })
})
