import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
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

  it('adds an HTTPS git credential through the menu + piped prompts', async () => {
    // authUpdate opens a fresh readline per prompt; chunk the input so
    // each interface can hand off cleanly (see RunYaacOptions docs).
    const { stdout, exitCode } = await runYaac(
      testEnv.env, 'auth', 'update',
      { stdin: ['1\n', 'a\n', 'github.com/acme/*\n', 'ghp_test_token_xyz\n'] },
    )
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Credential saved for pattern "github.com/acme/*"')

    const credsPath = path.join(testEnv.dataDir, '.credentials', 'github.json')
    const raw = await fs.readFile(credsPath, 'utf8')
    expect(JSON.parse(raw)).toEqual({
      tokens: [{ kind: 'https', pattern: 'github.com/acme/*', token: 'ghp_test_token_xyz' }],
    })
  })

  it('exits 1 when the pattern prompt is answered with a blank line', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'auth', 'update', { stdin: ['1\n', 'a\n', '\n'] },
    )
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/Pattern cannot be empty/)
  })

  it('rejects bare patterns missing a host', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'auth', 'update', { stdin: ['1\n', 'a\n', 'acme/*\n'] },
    )
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/<host>\/\*/)
  })

  it('saves an SSH credential with a registered key path', async () => {
    // Generate a real ed25519 key so the daemon's passphrase check passes.
    // ssh-keygen is a hard host dep for yaac's SSH credential path.
    const keyPath = path.join(testEnv.dataDir, 'test-key')
    const gen = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'yaac-test'])
    expect(gen.status).toBe(0)
    const { stdout, exitCode } = await runYaac(
      testEnv.env, 'auth', 'update',
      {
        stdin: [
          '1\n', 'b\n', 'git.example.com/*\n', `${keyPath}\n`,
          'git.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITESTAAAA\n',
        ],
      },
    )
    expect(exitCode).toBe(0)
    expect(stdout).toContain('SSH credential saved for pattern "git.example.com/*"')

    const credsPath = path.join(testEnv.dataDir, '.credentials', 'github.json')
    const raw = await fs.readFile(credsPath, 'utf8')
    const parsed = JSON.parse(raw) as { tokens: Array<Record<string, unknown>> }
    expect(parsed.tokens).toHaveLength(1)
    expect(parsed.tokens[0]).toMatchObject({
      kind: 'ssh',
      pattern: 'git.example.com/*',
      privateKeyPath: keyPath,
      knownHostsEntry: 'git.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITESTAAAA',
    })
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

  it('persists an OpenCode (OpenRouter) api key via the test-only login hook', async () => {
    // YAAC_E2E_OPENCODE_LOGIN holds a raw api key string — opencode is
    // api-key-only in v1 and skips any native CLI spawn.
    const env = { ...testEnv.env, YAAC_E2E_OPENCODE_LOGIN: 'sk-or-v1-test-key' }
    const { stdout, exitCode } = await runYaac(env, 'auth', 'update', { stdin: '4\n' })
    expect(exitCode).toBe(0)
    expect(stdout).toContain('OpenCode credentials saved.')

    const credsPath = path.join(testEnv.dataDir, '.credentials', 'opencode.json')
    const raw = await fs.readFile(credsPath, 'utf8')
    const parsed = JSON.parse(raw) as { kind: string; apiKey?: string; savedAt?: string }
    expect(parsed.kind).toBe('api-key')
    expect(parsed.apiKey).toBe('sk-or-v1-test-key')
    expect(typeof parsed.savedAt).toBe('string')
  })
})
