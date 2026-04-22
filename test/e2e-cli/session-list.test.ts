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

  it('session list --deleted renders seeded Claude Code JSONL entries with prompts', async () => {
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
    const firstMsg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'port the lexer to rust' },
    })
    await fs.writeFile(
      path.join(sessionsDir, `${sessionId}.jsonl`),
      [
        `{"type":"permission-mode","sessionId":"${sessionId}"}`,
        firstMsg,
        '',
      ].join('\n'),
    )

    const { stdout, exitCode } = await runYaac(
      testEnv.env, 'session', 'list', slug, '--deleted',
    )
    expect(exitCode).toBe(0)
    expect(stdout).toContain(sessionId.slice(0, 8))
    expect(stdout).toContain(slug)
    expect(stdout).toContain('claude')
    expect(stdout).toContain('PROMPT')
    expect(stdout).toContain('port the lexer to rust')
  })

  it('session list --deleted -n caps the rendered rows and hints at the cap', async () => {
    const slug = 'proj-del-many'
    const repo = path.join(testEnv.scratchDir, slug)
    await createTestRepo(repo)
    await addTestProject(repo)

    const sessionsDir = path.join(
      testEnv.dataDir, 'projects', slug, 'claude', 'projects', '-workspace',
    )
    await fs.mkdir(sessionsDir, { recursive: true })
    const ids = Array.from({ length: 5 }, (_, i) => `${String(i).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`)
    for (const id of ids) {
      await fs.writeFile(
        path.join(sessionsDir, `${id}.jsonl`),
        '{"type":"permission-mode"}\n',
      )
    }

    const { stdout, exitCode } = await runYaac(
      testEnv.env, 'session', 'list', slug, '--deleted', '-n', '2',
    )
    expect(exitCode).toBe(0)
    const matches = ids.filter((id) => stdout.includes(id.slice(0, 8)))
    expect(matches).toHaveLength(2)
    expect(stdout).toMatch(/showing most recent 2/)
  })

  it('session list --deleted --all omits the cap hint', async () => {
    const slug = 'proj-del-all'
    const repo = path.join(testEnv.scratchDir, slug)
    await createTestRepo(repo)
    await addTestProject(repo)

    const sessionsDir = path.join(
      testEnv.dataDir, 'projects', slug, 'claude', 'projects', '-workspace',
    )
    await fs.mkdir(sessionsDir, { recursive: true })
    const ids = Array.from({ length: 3 }, () => crypto.randomUUID())
    for (const id of ids) {
      await fs.writeFile(
        path.join(sessionsDir, `${id}.jsonl`),
        '{"type":"permission-mode"}\n',
      )
    }

    const { stdout, exitCode } = await runYaac(
      testEnv.env, 'session', 'list', slug, '--deleted', '--all',
    )
    expect(exitCode).toBe(0)
    for (const id of ids) expect(stdout).toContain(id.slice(0, 8))
    expect(stdout).not.toMatch(/showing most recent/)
  })
})
