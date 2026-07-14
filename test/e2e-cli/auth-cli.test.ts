import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  createYaacTestEnv,
  spawnYaacServer,
  runYaac,
  type YaacTestEnv,
  type SpawnedServer,
} from '@yaac/test-utils/cli'

/**
 * Merged auth/tool CLI suite (formerly auth.test.ts, auth-fake.test.ts,
 * auth-clear.test.ts, auth-update.test.ts, tool.test.ts) sharing ONE test
 * env and ONE server for the whole file instead of a per-test server —
 * spawning a server (and waiting on the cross-worker server mutex) per
 * test dominated wall-clock for these fast, cluster-free commands.
 *
 * Vitest runs tests within a file sequentially in declaration order, and
 * this file leans on that: the "clean data dir" describe MUST stay first
 * (its tests assert pristine-state output), and every test whose
 * assertions depend on the exact credential set (list rendering, clear
 * menu indexes, whole-file equality) resets `.credentials` to exactly
 * the state it seeds rather than inheriting residue from earlier tests.
 * Tool-credential files (claude.json/codex.json/opencode.json) are
 * written wholesale by the server (fs.writeFile of the full JSON in
 * packages/shared/src/tool-auth.ts), so tests that only parse the file their
 * own command just wrote don't need a reset.
 *
 * The YAAC_E2E_*_LOGIN / YAAC_E2E_OPENCODE_PROVIDER hooks are read by
 * the CLI process (runToolLogin in packages/shared/src/tool-auth-interactive.ts,
 * called from packages/cli/src/commands/auth-update.ts — "interactive tool-login must
 * happen CLI-side"), never by the server, so they are passed per-runYaac
 * call and the shared server needs no special env.
 */
describe('yaac auth + tool (real CLI + shared server)', () => {
  let testEnv: YaacTestEnv
  let server: SpawnedServer

  beforeAll(async () => {
    testEnv = await createYaacTestEnv()
    server = await spawnYaacServer(testEnv.env)
  })

  afterAll(async () => {
    await server.stop()
    await testEnv.cleanup()
  })

  function credPath(file: string): string {
    return path.join(testEnv.dataDir, '.credentials', file)
  }

  /**
   * Reset the shared data dir's `.credentials` to empty. Because every
   * test shares one data dir, state-sensitive tests call this first so
   * leftovers from earlier tests (extra github.json tokens, a stray
   * claude.json/codex.json/opencode.json) can't change list output or
   * shift `auth clear` menu indexes.
   */
  async function resetCreds(): Promise<string> {
    const credsDir = path.join(testEnv.dataDir, '.credentials')
    await fs.rm(credsDir, { recursive: true, force: true })
    await fs.mkdir(credsDir, { recursive: true, mode: 0o700 })
    return credsDir
  }

  /**
   * Seed github.json with exactly these tokens and nothing else in the
   * credentials dir. The `auth clear` menu enumerates git AND tool
   * credentials, so the reset is what keeps the menu indexes ("1", ...)
   * pointing at the git entries these tests expect.
   */
  async function seedTokens(tokens: Array<Record<string, unknown>>): Promise<void> {
    const credsDir = await resetCreds()
    await fs.writeFile(
      path.join(credsDir, 'github.json'),
      JSON.stringify({ tokens }) + '\n',
    )
  }

  // Pristine-state assertions — these MUST run before anything writes a
  // credential file or sets the default tool.
  describe('clean data dir', () => {
    it('auth list on a clean data dir reports no credentials configured', async () => {
      const { stdout, exitCode } = await runYaac(testEnv.env, 'auth', 'list')
      expect(exitCode).toBe(0)
      expect(stdout).toContain('Git credentials:')
      expect(stdout).toContain('(none configured)')
      expect(stdout).toContain('Tool credentials:')
      expect(stdout).toMatch(/claude\s+not configured/)
      expect(stdout).toMatch(/codex\s+not configured/)
    })

    it('reports "No credentials configured." on a clean data dir', async () => {
      const { stdout, exitCode } = await runYaac(testEnv.env, 'auth', 'clear')
      expect(exitCode).toBe(0)
      expect(stdout).toContain('No credentials configured.')
    })

    it('tool get reports the unconfigured state on a clean data dir', async () => {
      const { stdout, exitCode } = await runYaac(testEnv.env, 'tool', 'get')
      expect(exitCode).toBe(0)
      expect(stdout).toMatch(/No default tool configured/)
    })
  })

  describe('auth list', () => {
    it('auth list normalizes legacy github.json entries and renders masked previews', async () => {
      const credsDir = await resetCreds()
      // Legacy on-disk shape (pre host-prefix era). Read-time normalization
      // should upgrade these to github.com/* prefixes without rewriting the file.
      await fs.writeFile(
        path.join(credsDir, 'github.json'),
        JSON.stringify({
          tokens: [
            { pattern: 'acme/*', token: 'ghp_abcdef123456' },
            { pattern: '*', token: 'ghp_fallback_token' },
          ],
        }) + '\n',
      )
      await fs.writeFile(
        path.join(credsDir, 'claude.json'),
        JSON.stringify({
          kind: 'api-key',
          savedAt: '2026-01-15T00:00:00.000Z',
          apiKey: 'sk-ant-api03-fake-claude-key',
        }) + '\n',
      )
      await fs.writeFile(
        path.join(credsDir, 'codex.json'),
        JSON.stringify({
          kind: 'api-key',
          savedAt: '2026-02-20T00:00:00.000Z',
          apiKey: 'sk-fake-codex-key',
        }) + '\n',
      )

      const { stdout, exitCode } = await runYaac(testEnv.env, 'auth', 'list')
      expect(exitCode).toBe(0)

      expect(stdout).toContain('github.com/acme/*')
      expect(stdout).toContain('github.com/*')
      expect(stdout).toContain('***3456')
      expect(stdout).toContain('***oken')
      expect(stdout).not.toContain('ghp_abcdef123456')
      expect(stdout).not.toContain('ghp_fallback_token')

      expect(stdout).toMatch(/claude\s+\*\*\*-key.*api-key.*2026-01-15/)
      expect(stdout).toMatch(/codex\s+\*\*\*-key.*api-key.*2026-02-20/)
      expect(stdout).not.toContain('sk-ant-api03-fake-claude-key')
      expect(stdout).not.toContain('sk-fake-codex-key')
    })

    it('auth list renders ssh credentials with the key path as preview', async () => {
      // Reset so the listing shows exactly this credential set (the
      // previous test left claude.json/codex.json behind).
      const credsDir = await resetCreds()
      await fs.writeFile(
        path.join(credsDir, 'github.json'),
        JSON.stringify({
          tokens: [
            {
              kind: 'ssh',
              pattern: 'git.example.com/*',
              privateKeyPath: '/home/me/.ssh/yaac-key',
              knownHostsEntry: 'git.example.com ssh-ed25519 AAAA',
            },
          ],
        }) + '\n',
      )
      const { stdout, exitCode } = await runYaac(testEnv.env, 'auth', 'list')
      expect(exitCode).toBe(0)
      expect(stdout).toContain('ssh')
      expect(stdout).toContain('git.example.com/*')
      expect(stdout).toContain('/home/me/.ssh/yaac-key')
    })
  })

  describe('auth fake', () => {
    it('auth fake claude-oauth seeds an OAuth bundle in the data dir', async () => {
      // No reset needed: the server writes claude.json wholesale, so any
      // earlier claude.json content is fully replaced before we parse it.
      const { exitCode, stderr } = await runYaac(testEnv.env, 'auth', 'fake', 'claude-oauth')
      expect(exitCode, stderr).toBe(0)

      const parsed = JSON.parse(await fs.readFile(credPath('claude.json'), 'utf8')) as {
        kind: string
        claudeAiOauth: { accessToken: string; refreshToken: string }
      }
      expect(parsed.kind).toBe('oauth')
      expect(parsed.claudeAiOauth.accessToken).toBe('yaac-ph-access')
      expect(parsed.claudeAiOauth.refreshToken).toBe('yaac-ph-refresh')
    })

    it('auth fake github seeds an https github.com/* credential', async () => {
      // No reset needed: seeding merges by pattern into github.json and
      // the assertion is toContainEqual, so residual entries (the ssh
      // credential from the auth list test) can't affect it.
      const { exitCode, stderr } = await runYaac(testEnv.env, 'auth', 'fake', 'github')
      expect(exitCode, stderr).toBe(0)

      const parsed = JSON.parse(await fs.readFile(credPath('github.json'), 'utf8')) as {
        tokens: Array<{ kind: string; pattern: string; token: string }>
      }
      expect(parsed.tokens).toContainEqual({
        kind: 'https',
        pattern: 'github.com/*',
        token: 'yaac-ph-gh-token',
      })
    })

    it('rejects an unknown kind', async () => {
      const { exitCode, stderr } = await runYaac(testEnv.env, 'auth', 'fake', 'bogus')
      expect(exitCode).not.toBe(0)
      expect(stderr).toMatch(/claude-oauth|github|Allowed choices/i)
    })
  })

  describe('auth clear', () => {
    // These are menu-index-sensitive: seedTokens resets .credentials so
    // the clear menu lists exactly the seeded git credentials (a leftover
    // claude.json/codex.json/opencode.json would add menu entries and
    // shift the indexes).
    it('removes a specific git credential by menu index', async () => {
      await seedTokens([
        { kind: 'https', pattern: 'github.com/acme/*', token: 'ghp_acme_token_xxxx' },
        { kind: 'https', pattern: 'github.com/*', token: 'ghp_fallback_token_yy' },
      ])

      const { stdout, exitCode } = await runYaac(
        testEnv.env, 'auth', 'clear', { stdin: '1\n' },
      )
      expect(exitCode).toBe(0)
      expect(stdout).toContain('Removed git credential for pattern "github.com/acme/*"')

      const raw = await fs.readFile(
        path.join(testEnv.dataDir, '.credentials', 'github.json'), 'utf8',
      )
      expect(JSON.parse(raw)).toEqual({
        tokens: [{ kind: 'https', pattern: 'github.com/*', token: 'ghp_fallback_token_yy' }],
      })
    })

    it('removes every credential when the user answers "all"', async () => {
      await seedTokens([
        { kind: 'https', pattern: 'github.com/acme/*', token: 'ghp_acme_token_xxxx' },
        { kind: 'https', pattern: 'github.com/*', token: 'ghp_fallback_token_yy' },
      ])

      const { stdout, exitCode } = await runYaac(
        testEnv.env, 'auth', 'clear', { stdin: 'all\n' },
      )
      expect(exitCode).toBe(0)
      expect(stdout).toContain('All credentials removed.')

      const raw = await fs.readFile(
        path.join(testEnv.dataDir, '.credentials', 'github.json'), 'utf8',
      )
      expect(JSON.parse(raw)).toEqual({ tokens: [] })
    })

    it('prints "Cancelled." on an out-of-range menu choice', async () => {
      await seedTokens([
        { kind: 'https', pattern: 'github.com/acme/*', token: 'ghp_acme_token_xxxx' },
      ])

      const { stdout, exitCode } = await runYaac(
        testEnv.env, 'auth', 'clear', { stdin: '99\n' },
      )
      expect(exitCode).toBe(0)
      expect(stdout).toContain('Cancelled.')

      // Nothing removed.
      const raw = await fs.readFile(
        path.join(testEnv.dataDir, '.credentials', 'github.json'), 'utf8',
      )
      const parsed = JSON.parse(raw) as { tokens: unknown[] }
      expect(parsed.tokens).toHaveLength(1)
    })
  })

  describe('auth update', () => {
    it('prints "Cancelled." when the user picks an invalid menu option', async () => {
      // The update menu is static (git/claude/codex/opencode) regardless
      // of what credentials exist, so no reset is needed.
      const { stdout, exitCode } = await runYaac(
        testEnv.env, 'auth', 'update', { stdin: 'x\n' },
      )
      expect(exitCode).toBe(0)
      expect(stdout).toContain('Cancelled.')
    })

    it('adds an HTTPS git credential through the menu + piped prompts', async () => {
      // Reset: the assertion is whole-file equality on github.json, and
      // git credential saves merge into the existing tokens array — a
      // leftover token from the auth clear tests would break toEqual.
      await resetCreds()
      // authUpdate opens a fresh readline per prompt; answer each prompt
      // only after it renders so the handoff can't eat a chunk (see
      // RunYaacOptions.stdinOnPrompt).
      const { stdout, exitCode } = await runYaac(
        testEnv.env, 'auth', 'update',
        {
          stdinOnPrompt: [
            { when: /Choice \[1-4\]: /, send: '1\n' },
            { when: /Choice \[a\/b\]: /, send: 'a\n' },
            { when: /Repo pattern: /, send: 'github.com/acme/*\n' },
            { when: /Token \(PAT\): /, send: 'ghp_test_token_xyz\n' },
          ],
        },
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
        testEnv.env, 'auth', 'update',
        {
          stdinOnPrompt: [
            { when: /Choice \[1-4\]: /, send: '1\n' },
            { when: /Choice \[a\/b\]: /, send: 'a\n' },
            { when: /Repo pattern: /, send: '\n' },
          ],
        },
      )
      expect(exitCode).toBe(1)
      expect(stderr).toMatch(/Pattern cannot be empty/)
    })

    it('rejects bare patterns missing a host', async () => {
      const { stderr, exitCode } = await runYaac(
        testEnv.env, 'auth', 'update',
        {
          stdinOnPrompt: [
            { when: /Choice \[1-4\]: /, send: '1\n' },
            { when: /Choice \[a\/b\]: /, send: 'a\n' },
            { when: /Repo pattern: /, send: 'acme/*\n' },
          ],
        },
      )
      expect(exitCode).toBe(1)
      expect(stderr).toMatch(/<host>\/\*/)
    })

    it('saves an SSH credential with a registered key path', async () => {
      // Reset: the assertion is tokens.toHaveLength(1), and the HTTPS
      // credential saved two tests ago would otherwise still be present.
      await resetCreds()
      // Generate a real ed25519 key so the server's passphrase check passes.
      // ssh-keygen is a hard host dep for yaac's SSH credential path.
      const keyPath = path.join(testEnv.dataDir, 'test-key')
      const gen = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'yaac-test'])
      expect(gen.status).toBe(0)
      const { stdout, exitCode } = await runYaac(
        testEnv.env, 'auth', 'update',
        {
          stdinOnPrompt: [
            { when: /Choice \[1-4\]: /, send: '1\n' },
            { when: /Choice \[a\/b\]: /, send: 'b\n' },
            { when: /Repo pattern: /, send: 'git.example.com/*\n' },
            { when: /Private key path/, send: `${keyPath}\n` },
            { when: /Entry: /, send: 'git.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITESTAAAA\n' },
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
      // claude.json is written wholesale, so the fake bundle seeded by the
      // auth fake test above is fully replaced — no reset needed.
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
      // api-key-only and skips any native CLI spawn. With no provider override
      // the credential defaults to openrouter.
      const env = { ...testEnv.env, YAAC_E2E_OPENCODE_LOGIN: 'sk-or-v1-test-key' }
      const { stdout, exitCode } = await runYaac(env, 'auth', 'update', { stdin: '4\n' })
      expect(exitCode).toBe(0)
      expect(stdout).toContain('OpenCode credentials saved.')

      const credsPath = path.join(testEnv.dataDir, '.credentials', 'opencode.json')
      const raw = await fs.readFile(credsPath, 'utf8')
      const parsed = JSON.parse(raw) as {
        kind: string; apiKey?: string; savedAt?: string; provider?: string
      }
      expect(parsed.kind).toBe('api-key')
      expect(parsed.apiKey).toBe('sk-or-v1-test-key')
      expect(parsed.provider).toBe('openrouter')
      expect(typeof parsed.savedAt).toBe('string')
    })

    it('persists an OpenCode NeuralWatt api key when the provider hook is set', async () => {
      // opencode.json is also written wholesale, replacing the openrouter
      // credential the previous test saved.
      const env = {
        ...testEnv.env,
        YAAC_E2E_OPENCODE_LOGIN: 'nw-test-key',
        YAAC_E2E_OPENCODE_PROVIDER: 'neuralwatt',
      }
      const { stdout, exitCode } = await runYaac(env, 'auth', 'update', { stdin: '4\n' })
      expect(exitCode).toBe(0)
      expect(stdout).toContain('OpenCode credentials saved.')

      const credsPath = path.join(testEnv.dataDir, '.credentials', 'opencode.json')
      const raw = await fs.readFile(credsPath, 'utf8')
      const parsed = JSON.parse(raw) as { kind: string; apiKey?: string; provider?: string }
      expect(parsed.kind).toBe('api-key')
      expect(parsed.apiKey).toBe('nw-test-key')
      expect(parsed.provider).toBe('neuralwatt')
    })
  })

  describe('tool', () => {
    // Runs after the clean-data-dir describe: `tool set` persists the
    // default tool, which would break the unconfigured-state assertion.
    it('tool set then tool get round-trips via the server', async () => {
      const setResult = await runYaac(testEnv.env, 'tool', 'set', 'claude')
      expect(setResult.exitCode).toBe(0)
      expect(setResult.stdout).toMatch(/claude/)

      const getResult = await runYaac(testEnv.env, 'tool', 'get')
      expect(getResult.exitCode).toBe(0)
      expect(getResult.stdout.trim()).toBe('claude')
    })

    it('tool set rejects an unknown tool', async () => {
      const { exitCode, stderr } = await runYaac(testEnv.env, 'tool', 'set', 'bogus')
      expect(exitCode).not.toBe(0)
      expect(stderr.length).toBeGreaterThan(0)
    })
  })
})
