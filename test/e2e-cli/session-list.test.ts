import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  createYaacTestEnv,
  spawnYaacDaemon,
  runYaac,
  type YaacTestEnv,
  type SpawnedDaemon,
} from '@test/helpers/cli'
import { addTestProject, createTestRepo } from '@test/helpers/setup'

describe('yaac session list (real CLI + real daemon)', () => {
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

  it('prints the empty-state hint when no sessions exist', async () => {
    const { stdout, exitCode } = await runYaac(testEnv.env, 'session', 'list')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('No active sessions')
    expect(stdout).toContain('yaac session create')
  })

  it('session list <project> 404s with a helpful message for an unknown slug', async () => {
    const { stderr, exitCode } = await runYaac(testEnv.env, 'session', 'list', 'no-such-project')
    expect(exitCode).not.toBe(0)
    expect(stderr.toLowerCase()).toMatch(/not found|no-such-project/)
  })

  it('session list <project> filters the empty state by project name', async () => {
    const repo = path.join(testEnv.scratchDir, 'proj-empty')
    await createTestRepo(repo)
    await addTestProject(repo)

    const { stdout, exitCode } = await runYaac(testEnv.env, 'session', 'list', 'proj-empty')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('No active sessions for project "proj-empty"')
  })

  it('session list --deleted shows the empty-deleted message when nothing is recorded', async () => {
    const repo = path.join(testEnv.scratchDir, 'proj-nodel')
    await createTestRepo(repo)
    await addTestProject(repo)

    const { stdout, exitCode } = await runYaac(
      testEnv.env, 'session', 'list', 'proj-nodel', '--deleted',
    )
    expect(exitCode).toBe(0)
    expect(stdout).toContain('No deleted sessions for project "proj-nodel"')
  })

  it('session list --deleted renders seeded Claude Code JSONL entries', async () => {
    const slug = 'proj-del'
    const repo = path.join(testEnv.scratchDir, slug)
    await createTestRepo(repo)
    await addTestProject(repo)

    // Seed a Claude Code transcript file so listDeletedSessions() picks it up.
    const sessionsDir = path.join(
      testEnv.dataDir, 'projects', slug, 'claude', 'projects', '-workspace',
    )
    await fs.mkdir(sessionsDir, { recursive: true })
    const sessionId = crypto.randomUUID()
    await fs.writeFile(
      path.join(sessionsDir, `${sessionId}.jsonl`),
      `{"type":"permission-mode","sessionId":"${sessionId}"}\n`,
    )

    const { stdout, exitCode } = await runYaac(
      testEnv.env, 'session', 'list', slug, '--deleted',
    )
    expect(exitCode).toBe(0)
    expect(stdout).toContain(sessionId.slice(0, 8))
    expect(stdout).toContain(slug)
    expect(stdout).toContain('claude')
  })
})
