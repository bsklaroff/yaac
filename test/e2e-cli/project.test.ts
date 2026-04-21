import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import { createYaacTestEnv, spawnYaacDaemon, runYaac, type YaacTestEnv, type SpawnedDaemon } from '@test/helpers/cli'
import { createTestRepo, addTestProject } from '@test/helpers/setup'

describe('yaac project (real CLI + real daemon)', () => {
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

  it('project list prints the empty-state hint when no projects exist', async () => {
    const { stdout, exitCode } = await runYaac(testEnv.env, 'project', 'list')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('No projects found')
    expect(stdout).toContain('yaac project add')
  })

  it('project list shows each seeded project with slug and remote', async () => {
    const repoAlpha = path.join(testEnv.scratchDir, 'repo-alpha')
    const repoBeta = path.join(testEnv.scratchDir, 'repo-beta')
    await createTestRepo(repoAlpha)
    await createTestRepo(repoBeta)
    await addTestProject(repoAlpha)
    await addTestProject(repoBeta)

    const { stdout, exitCode } = await runYaac(testEnv.env, 'project', 'list')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('repo-alpha')
    expect(stdout).toContain('repo-beta')
    expect(stdout).toContain(repoAlpha)
    expect(stdout).toContain(repoBeta)
  })

  it('project add rejects a non-GitHub URL with a validation error', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env,
      'project',
      'add',
      'https://gitlab.com/foo/bar',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/github/i)
  })
})
