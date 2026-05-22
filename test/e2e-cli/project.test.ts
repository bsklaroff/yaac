import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
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

  it('project add accepts a non-GitHub HTTPS URL (no longer rejected on host)', async () => {
    // Without credentials the CLI drops into the interactive auth flow.
    // Cancel out of that flow with a single newline; we just need to assert
    // that URL validation did NOT reject the non-github host.
    const { stdout, stderr } = await runYaac(
      testEnv.env, 'project', 'add', 'https://gitlab.example.com/foo/bar',
      { stdin: '\n' },
    )
    const combined = stdout + stderr
    // The old "Only GitHub repositories are supported" error must be gone.
    expect(combined).not.toMatch(/only github/i)
    // The interactive auth-update menu must have been shown — proves the
    // URL reached the daemon (rather than being blocked by validation).
    expect(combined).toMatch(/What would you like to authenticate\?/)
  })

  it('project add accepts SCP-style SSH URLs', async () => {
    const { stdout, stderr } = await runYaac(
      testEnv.env, 'project', 'add', 'git@github.com:org/repo.git',
      { stdin: '\n' },
    )
    const combined = stdout + stderr
    expect(combined).not.toMatch(/SSH URLs are not supported/i)
    expect(combined).toMatch(/What would you like to authenticate\?/)
  })

  it('project add rejects plain HTTP URLs', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'project', 'add', 'http://github.com/org/repo',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/HTTPS/i)
  })

  it('project add rejects ssh:// URLs pointing at SCP-style instead', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'project', 'add', 'ssh://git@github.com/org/repo',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/SCP-style/)
  })

  it('project add rejects unparseable URLs', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'project', 'add', 'not-a-url',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/Unrecognized|Invalid|HTTPS/i)
  })

  it('project add returns CONFLICT when a project with the same slug exists', async () => {
    // Pre-create the project dir so the daemon's `fs.access` check throws
    // CONFLICT before it reaches token resolution.
    await fs.mkdir(path.join(testEnv.dataDir, 'projects', 'repo'), { recursive: true })

    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'project', 'add', 'https://github.com/org/repo',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain('already exists')
  })
})
