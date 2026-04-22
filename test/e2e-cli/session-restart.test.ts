import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import {
  createYaacTestEnv,
  spawnYaacDaemon,
  runYaac,
  type YaacTestEnv,
  type SpawnedDaemon,
} from '@test/helpers/cli'
import { requirePodman } from '@test/helpers/setup'

describe('yaac session restart (real CLI + real daemon)', () => {
  beforeAll(async () => {
    await requirePodman()
  })

  let testEnv: YaacTestEnv
  let daemon: SpawnedDaemon

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
    await fs.writeFile(
      testEnv.gitConfigPath,
      '[user]\n\tname = Test User\n\temail = test@example.com\n',
    )
    daemon = await spawnYaacDaemon(testEnv.env)
  })

  afterEach(async () => {
    await daemon.stop()
    await testEnv.cleanup()
  })

  it('errors with NOT_FOUND when no session or worktree matches the id', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'session', 'restart', 'definitely-no-such-session',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/No session found/i)
  })

  it('rejects a relative --add-dir path with an absolute-path error', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'session', 'restart', 'sess-x', '--add-dir', 'relative/path',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/absolute/i)
  })

  it('rejects a missing --add-dir-rw path with a not-found error', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'session', 'restart', 'sess-x', '--add-dir-rw', '/definitely-missing-dir',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/not found/i)
  })
})
