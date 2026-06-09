import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createYaacTestEnv, spawnYaacDaemon, runYaac, type YaacTestEnv, type SpawnedDaemon } from '@test/helpers/cli'
import { createTestRepo, addTestProject } from '@test/helpers/setup'

describe('yaac project rebuild (real CLI + real daemon)', () => {
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

  it('errors at commander level when the <project> argument is omitted', async () => {
    const { stderr, exitCode } = await runYaac(testEnv.env, 'project', 'rebuild')
    expect(exitCode).not.toBe(0)
    // commander emits "missing required argument" — exact phrasing varies
    // by version, so just match the project token.
    expect(stderr).toMatch(/missing.*argument.*project/i)
  })

  it('errors cleanly when the named project does not exist', async () => {
    const { stdout, stderr, exitCode } = await runYaac(
      testEnv.env, 'project', 'rebuild', 'no-such-project',
    )
    expect(exitCode).not.toBe(0)
    expect(stdout + stderr).toMatch(/not found/i)
  })

  it('reports the "standalone Dockerfile.yaac" guard when the project has no tools layer', async () => {
    // Seed a project, then drop a standalone Dockerfile.yaac (its own FROM)
    // into the per-machine config dir so resolveImageChain skips the tools
    // layer entirely. The daemon route should surface the guard error
    // rather than attempting a (slow, network-bound) --no-cache build.
    const repoAlpha = path.join(testEnv.scratchDir, 'repo-alpha')
    await createTestRepo(repoAlpha)
    await addTestProject(repoAlpha)

    const configDir = path.join(testEnv.dataDir, 'projects', 'repo-alpha', 'config')
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(
      path.join(configDir, 'Dockerfile.yaac'),
      'FROM docker.io/ubuntu:24.04\nRUN echo custom\n',
    )

    const { stdout, stderr, exitCode } = await runYaac(
      testEnv.env, 'project', 'rebuild', 'repo-alpha',
    )
    expect(exitCode).not.toBe(0)
    expect(stdout + stderr).toMatch(/standalone Dockerfile\.yaac/)
  })
})
