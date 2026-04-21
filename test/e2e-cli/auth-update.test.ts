import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  createYaacTestEnv,
  spawnYaacDaemon,
  runYaac,
  type YaacTestEnv,
  type SpawnedDaemon,
} from '@test/helpers/cli'

describe('yaac auth update (real CLI + real daemon)', () => {
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

  it('prints "Cancelled." when the user picks an invalid menu option', async () => {
    const { stdout, exitCode } = await runYaac(
      testEnv.env, 'auth', 'update', { stdin: 'x\n' },
    )
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Cancelled.')
  })

  it('adds a GitHub token through the menu + piped prompts', async () => {
    // authUpdate opens a fresh readline per prompt; chunk the input so
    // each interface can hand off cleanly (see RunYaacOptions docs).
    const { stdout, exitCode } = await runYaac(
      testEnv.env, 'auth', 'update',
      { stdin: ['1\n', 'acme/*\n', 'ghp_test_token_xyz\n'] },
    )
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Token saved for pattern "acme/*"')

    const credsPath = path.join(testEnv.dataDir, '.credentials', 'github.json')
    const raw = await fs.readFile(credsPath, 'utf8')
    expect(JSON.parse(raw)).toEqual({
      tokens: [{ pattern: 'acme/*', token: 'ghp_test_token_xyz' }],
    })
  })

  it('exits 1 when the pattern prompt is answered with a blank line', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'auth', 'update', { stdin: ['1\n', '\n'] },
    )
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/Pattern cannot be empty/)
  })

  it('persists a Claude OAuth bundle end-to-end via the test-only login hook', async () => {
    const bundle = {
      accessToken: 'sk-ant-oat01-fake-access',
      refreshToken: 'sk-ant-ort01-fake-refresh',
      expiresAt: Date.now() + 60_000,
      scopes: ['user:inference'],
      subscriptionType: 'pro',
    }

    const env = { ...testEnv.env, YAAC_E2E_CLAUDE_LOGIN: JSON.stringify(bundle) }
    const { stdout, exitCode } = await runYaac(env, 'auth', 'update', { stdin: '2\n' })
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Claude Code credentials saved.')

    const credsPath = path.join(testEnv.dataDir, '.credentials', 'claude.json')
    const raw = await fs.readFile(credsPath, 'utf8')
    const parsed = JSON.parse(raw) as { kind: string; claudeAiOauth?: typeof bundle }
    expect(parsed.kind).toBe('oauth')
    expect(parsed.claudeAiOauth).toEqual(bundle)
  })
})
