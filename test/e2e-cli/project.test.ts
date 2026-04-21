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

  it('project list shows each seeded project with slug, remote, and session count', async () => {
    const repoAlpha = path.join(testEnv.scratchDir, 'repo-alpha')
    const repoBeta = path.join(testEnv.scratchDir, 'repo-beta')
    await createTestRepo(repoAlpha)
    await createTestRepo(repoBeta)
    await addTestProject(repoAlpha)
    await addTestProject(repoBeta)

    const { stdout, exitCode } = await runYaac(testEnv.env, 'project', 'list')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('PROJECT')
    expect(stdout).toContain('SESSIONS')
    expect(stdout).toContain('repo-alpha')
    expect(stdout).toContain('repo-beta')
    expect(stdout).toContain(repoAlpha)
    expect(stdout).toContain(repoBeta)
    // No containers were started, so both projects should show 0 sessions.
    expect(stdout).toMatch(/repo-alpha\s+\S.*\s+0/)
    expect(stdout).toMatch(/repo-beta\s+\S.*\s+0/)
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

  it('project add rejects SSH-style URLs pointing at HTTPS instead', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'project', 'add', 'git@github.com:org/repo.git',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/HTTPS/)
  })

  it('project add rejects plain HTTP URLs', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'project', 'add', 'http://github.com/org/repo',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/HTTPS/)
  })

  it('project add rejects unparseable URLs', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'project', 'add', 'not-a-url',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/Invalid URL|HTTPS|GitHub/)
  })
})
