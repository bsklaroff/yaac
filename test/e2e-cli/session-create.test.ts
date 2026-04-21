import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createYaacTestEnv, spawnYaacDaemon, runYaac, type YaacTestEnv, type SpawnedDaemon } from '@test/helpers/cli'
import { addTestProject, createTestRepo, requirePodman } from '@test/helpers/setup'

/**
 * Real CLI + real daemon + real podman.
 *
 * Today this covers one CLI-initiated session-create path end-to-end:
 * the VALIDATION error raised by the daemon when no GitHub token is
 * configured for the project's remote. That flows through the full
 * subprocess→HTTP→Hono→session-create-handler→NDJSON-stream→CLI
 * chain, including `ensureContainerRuntime()`, so it proves the
 * podman+daemon plumbing works end-to-end through real processes.
 *
 * A happy-path container-creation test (actually spawning a session
 * container through the real CLI) is deliberately deferred: the
 * daemon's session-create hardcodes a GitHub-token requirement that
 * the existing integration-style `test/e2e/session-create.test.ts`
 * bypasses by re-implementing container orchestration. Supporting a
 * real happy-path CLI test would require product-code changes
 * (e.g. allowing local `file://` remotes without a token). Out of
 * scope for the initial e2e-cli PR; tracked as follow-up.
 */
describe('yaac session create (real CLI + real daemon)', () => {
  beforeAll(async () => {
    await requirePodman()
  })

  let testEnv: YaacTestEnv
  let daemon: SpawnedDaemon

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
    // Global git identity so the CLI's session-create doesn't prompt
    // on stdin. `GIT_CONFIG_GLOBAL` is preset in `testEnv.env`, so
    // seeding this file is the same as populating `~/.gitconfig`
    // without clobbering the real one.
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

  it('errors out fast when the project slug does not exist', async () => {
    const { stderr, exitCode } = await runYaac(testEnv.env, 'session', 'create', 'nope')
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/Project "nope" not found/)
  })

  it('surfaces the daemon "no GitHub token" validation error via stderr + nonzero exit', async () => {
    const repo = path.join(testEnv.scratchDir, 'repo-demo')
    await createTestRepo(repo)
    await addTestProject(repo)

    const { stderr, exitCode } = await runYaac(
      testEnv.env,
      'session',
      'create',
      'repo-demo',
      '--tool',
      'claude',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/No GitHub token configured/)
  })
})
