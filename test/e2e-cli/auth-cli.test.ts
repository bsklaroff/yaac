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
 * The auth and tool CLI commands, sharing one test env and one server for
 * the whole file.
 *
 * Tests run in declaration order. The "clean data dir" describe must stay
 * first, and every test that depends on the exact credential set resets
 * `.credentials` to the state it seeds. The server writes each tool
 * credential file whole, so a test that only reads the file its own command
 * just wrote needs no reset.
 *
 * The YAAC_E2E_*_LOGIN / YAAC_E2E_OPENCODE_PROVIDER hooks are read by the
 * CLI process (runToolLogin in packages/shared/src/tool-auth-interactive.ts),
 * not the server, so they are passed per runYaac call.
 */
describe('yaac auth (real CLI + shared server)', () => {
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
    return path.join(testEnv.dataDir, 'server-local', '.credentials', file)
  }

  /**
   * Empty the shared `.credentials` dir, so earlier tests' files can't
   * change list output or shift `auth clear` menu indexes.
   */
  async function resetCreds(): Promise<string> {
    const credsDir = path.join(testEnv.dataDir, 'server-local', '.credentials')
    await fs.rm(credsDir, { recursive: true, force: true })
    await fs.mkdir(credsDir, { recursive: true, mode: 0o700 })
    return credsDir
  }

  /** Seed the claude and codex api-key credentials and nothing else, so
   *  the `auth clear` menu lists exactly those two, in that order. */
  async function seedToolCreds(): Promise<void> {
    const credsDir = await resetCreds()
    for (const [file, apiKey] of [['claude.json', 'sk-ant-api03-clear-me'], ['codex.json', 'sk-codex-clear-me']]) {
      await fs.writeFile(path.join(credsDir, file), JSON.stringify({
        kind: 'api-key', savedAt: '2026-01-15T00:00:00.000Z', apiKey,
      }) + '\n')
    }
  }

  // Must run before anything writes a credential file.
  describe('clean data dir', () => {
    it('auth list on a clean data dir reports no credentials configured', async () => {
      const { stdout, exitCode } = await runYaac(testEnv.env, 'auth', 'list')
      expect(exitCode).toBe(0)
      expect(stdout).toContain('Git credentials:')
      expect(stdout).toContain('(none configured')
      expect(stdout).toContain('Tool credentials:')
      expect(stdout).toMatch(/claude\s+not configured/)
      expect(stdout).toMatch(/codex\s+not configured/)
    })

    it('reports "No credentials configured." on a clean data dir', async () => {
      const { stdout, exitCode } = await runYaac(testEnv.env, 'auth', 'clear')
      expect(exitCode).toBe(0)
      expect(stdout).toContain('No credentials configured.')
    })
  })

  describe('auth list', () => {
    it('auth list renders masked previews for every tool credential', async () => {
      const credsDir = await resetCreds()
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

      expect(stdout).toMatch(/claude\s+\*\*\*-key.*api-key.*2026-01-15/)
      expect(stdout).toMatch(/codex\s+\*\*\*-key.*api-key.*2026-02-20/)
      expect(stdout).not.toContain('sk-ant-api03-fake-claude-key')
      expect(stdout).not.toContain('sk-fake-codex-key')
    })
  })

  describe('auth fake', () => {
    it('refuses to replace a real credential, and seeds once it is cleared', async () => {
      // `auth list` above left a real claude api-key behind, which a fake
      // must never replace.
      const credsDir = await resetCreds()
      await fs.writeFile(path.join(credsDir, 'claude.json'), JSON.stringify({
        kind: 'api-key', savedAt: '2026-01-15T00:00:00.000Z', apiKey: 'sk-ant-api03-real',
      }) + '\n')
      const refused = await runYaac(testEnv.env, 'auth', 'fake', 'claude-oauth')
      expect(refused.exitCode).not.toBe(0)
      expect(refused.stderr).toMatch(/real credential is already stored for claude-oauth/)
      expect(await fs.readFile(credPath('claude.json'), 'utf8')).toContain('sk-ant-api03-real')

      await resetCreds()
      const seeded = await runYaac(testEnv.env, 'auth', 'fake', 'claude-oauth')
      expect(seeded.exitCode, seeded.stderr).toBe(0)
    })

    it('auth fake claude-oauth seeds an OAuth bundle in the data dir', async () => {
      // Re-seeding over the previous case's fake is allowed.
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

    it('auth fake github seeds the fake-github git credential, once', async () => {
      for (let i = 0; i < 2; i++) {
        const { exitCode, stderr } = await runYaac(testEnv.env, 'auth', 'fake', 'github')
        expect(exitCode, stderr).toBe(0)
      }
      // Git credentials are rows, listed by the name `project add` takes.
      const { stdout } = await runYaac(testEnv.env, 'auth', 'list')
      expect(stdout.match(/^\s+fake-github\s+https\s+\*\*\*oken$/gm)).toHaveLength(1)
    })

    it('auth fake opencode-openrouter seeds a placeholder openrouter api-key', async () => {
      const { exitCode, stderr } = await runYaac(testEnv.env, 'auth', 'fake', 'opencode-openrouter')
      expect(exitCode, stderr).toBe(0)

      const parsed = JSON.parse(await fs.readFile(credPath('opencode.json'), 'utf8')) as {
        kind: string
        provider: string
        apiKey: string
      }
      expect(parsed.kind).toBe('api-key')
      expect(parsed.provider).toBe('openrouter')
      expect(parsed.apiKey).toBe('yaac-ph-opencode-api-key')
    })

    it('auth fake pi-openrouter seeds a placeholder openrouter api-key', async () => {
      const { exitCode, stderr } = await runYaac(testEnv.env, 'auth', 'fake', 'pi-openrouter')
      expect(exitCode, stderr).toBe(0)

      const parsed = JSON.parse(await fs.readFile(credPath('pi.json'), 'utf8')) as {
        kind: string
        provider: string
        apiKey: string
      }
      expect(parsed.kind).toBe('api-key')
      expect(parsed.provider).toBe('openrouter')
      expect(parsed.apiKey).toBe('yaac-ph-pi-api-key')
    })

    it('seeds several kinds passed in one invocation (variadic)', async () => {
      const { exitCode, stdout, stderr } = await runYaac(
        testEnv.env, 'auth', 'fake', 'claude-oauth', 'opencode-openrouter',
      )
      expect(exitCode, stderr).toBe(0)
      expect(stdout).toContain('Claude OAuth')
      expect(stdout).toContain('OpenCode OpenRouter')

      const claude = JSON.parse(await fs.readFile(credPath('claude.json'), 'utf8')) as {
        claudeAiOauth: { accessToken: string }
      }
      const opencode = JSON.parse(await fs.readFile(credPath('opencode.json'), 'utf8')) as {
        provider: string
        apiKey: string
      }
      expect(claude.claudeAiOauth.accessToken).toBe('yaac-ph-access')
      expect(opencode.provider).toBe('openrouter')
      expect(opencode.apiKey).toBe('yaac-ph-opencode-api-key')
    })

    it('rejects an unknown kind', async () => {
      const { exitCode, stderr } = await runYaac(testEnv.env, 'auth', 'fake', 'bogus')
      expect(exitCode).not.toBe(0)
      expect(stderr).toMatch(/claude-oauth|Allowed choices/i)
    })

    it('requires at least one kind', async () => {
      const { exitCode, stderr } = await runYaac(testEnv.env, 'auth', 'fake')
      expect(exitCode).not.toBe(0)
      expect(stderr).toMatch(/missing required argument|kinds/i)
    })
  })

  describe('auth clear', () => {
    // Menu indexes assume seedToolCreds: exactly claude, then codex.
    it('removes a specific tool credential by menu index', async () => {
      await seedToolCreds()

      const { stdout, exitCode } = await runYaac(testEnv.env, 'auth', 'clear', { stdin: '1\n' })
      expect(exitCode).toBe(0)
      expect(stdout).toContain('Removed Claude Code credentials.')
      await expect(fs.access(credPath('claude.json'))).rejects.toThrow()
      await fs.access(credPath('codex.json'))
    })

    it('removes every credential when the user answers "all"', async () => {
      await seedToolCreds()

      const { stdout, exitCode } = await runYaac(testEnv.env, 'auth', 'clear', { stdin: 'all\n' })
      expect(exitCode).toBe(0)
      expect(stdout).toContain('All credentials removed.')
      await expect(fs.access(credPath('claude.json'))).rejects.toThrow()
      await expect(fs.access(credPath('codex.json'))).rejects.toThrow()
    })

    it('prints "Cancelled." on an out-of-range menu choice', async () => {
      await seedToolCreds()

      const { stdout, exitCode } = await runYaac(testEnv.env, 'auth', 'clear', { stdin: '99\n' })
      expect(exitCode).toBe(0)
      expect(stdout).toContain('Cancelled.')
      await fs.access(credPath('claude.json'))
      await fs.access(credPath('codex.json'))
    })
  })

  describe('auth update', () => {
    it('prints "Cancelled." when the user picks an invalid menu option', async () => {
      // The update menu is the same whatever credentials exist.
      const { stdout, exitCode } = await runYaac(
        testEnv.env, 'auth', 'update', { stdin: 'x\n' },
      )
      expect(exitCode).toBe(0)
      expect(stdout).toContain('Cancelled.')
    })

    it('adds a named HTTPS git credential through the menu + piped prompts', async () => {
      // authUpdate asks each question only after the last is answered, so
      // each is answered as it renders (see RunYaacOptions.stdinOnPrompt).
      const { stdout, exitCode } = await runYaac(
        testEnv.env, 'auth', 'update',
        {
          stdinOnPrompt: [
            { when: /Choice \[1-5\]: /, send: '1\n' },
            { when: /Choice \[a\/b\]: /, send: 'a\n' },
            { when: /Name \[git-token\]: /, send: 'acme\n' },
            { when: /Token \(PAT\): /, send: 'ghp_test_token_xyz\n' },
          ],
        },
      )
      expect(exitCode).toBe(0)
      expect(stdout).toContain('Git credential "acme" saved.')
      expect(stdout).toContain("yaac project add <remote-url> 'acme'")

      const { stdout: listed } = await runYaac(testEnv.env, 'auth', 'list')
      expect(listed).toMatch(/^\s+acme\s+https\s+\*\*\*_xyz$/m)
      expect(listed).not.toContain('ghp_test_token_xyz')
    })

    it('exits 1 when the token prompt is answered with a blank line', async () => {
      const { stderr, exitCode } = await runYaac(
        testEnv.env, 'auth', 'update',
        {
          stdinOnPrompt: [
            { when: /Choice \[1-5\]: /, send: '1\n' },
            { when: /Choice \[a\/b\]: /, send: 'a\n' },
            { when: /Name \[git-token\]: /, send: '\n' },
            { when: /Token \(PAT\): /, send: '\n' },
          ],
        },
      )
      expect(exitCode).toBe(1)
      expect(stderr).toMatch(/Token cannot be empty/)
    })

    it('generates an SSH key on the server under the default name and prints only its public half', async () => {
      // No key is read off this machine, and none lands anywhere in the
      // server's data dir.
      const { exitCode, stdout } = await runYaac(
        testEnv.env, 'auth', 'update',
        {
          stdinOnPrompt: [
            { when: /Choice \[1-5\]: /, send: '1\n' },
            { when: /Choice \[a\/b\]: /, send: 'b\n' },
            { when: /Name \[git-key\]: /, send: '\n' },
          ],
        },
      )
      expect(exitCode).toBe(0)
      expect(stdout).toContain('SSH key "git-key" generated.')
      const publicKey = /^(ssh-ed25519 AAAAC3NzaC1lZDI1NTE5\S+ git-key)$/m.exec(stdout)?.[1]
      expect(publicKey).toBeDefined()
      expect(stdout).not.toContain('PRIVATE KEY')
      const grep = spawnSync('grep', ['-rl', 'PRIVATE KEY', testEnv.dataDir])
      expect(grep.stdout.toString()).toBe('')

      const { stdout: listed } = await runYaac(testEnv.env, 'auth', 'list')
      expect(listed).toContain(publicKey)
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

      const credsPath = path.join(testEnv.dataDir, 'server-local', '.credentials', 'claude.json')
      const raw = await fs.readFile(credsPath, 'utf8')
      const parsed = JSON.parse(raw) as { kind: string; claudeAiOauth?: typeof bundle }
      expect(parsed.kind).toBe('oauth')
      expect(parsed.claudeAiOauth).toEqual(bundle)
    })

    it('persists an OpenCode (OpenRouter) api key via the test-only login hook', async () => {
      // opencode is api-key-only, so the hook holds a raw key. With no
      // provider override the credential defaults to openrouter.
      const env = { ...testEnv.env, YAAC_E2E_OPENCODE_LOGIN: 'sk-or-v1-test-key' }
      const { stdout, exitCode } = await runYaac(env, 'auth', 'update', { stdin: '4\n' })
      expect(exitCode).toBe(0)
      expect(stdout).toContain('OpenCode credentials saved.')

      const credsPath = path.join(testEnv.dataDir, 'server-local', '.credentials', 'opencode.json')
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
      const env = {
        ...testEnv.env,
        YAAC_E2E_OPENCODE_LOGIN: 'nw-test-key',
        YAAC_E2E_OPENCODE_PROVIDER: 'neuralwatt',
      }
      const { stdout, exitCode } = await runYaac(env, 'auth', 'update', { stdin: '4\n' })
      expect(exitCode).toBe(0)
      expect(stdout).toContain('OpenCode credentials saved.')

      const credsPath = path.join(testEnv.dataDir, 'server-local', '.credentials', 'opencode.json')
      const raw = await fs.readFile(credsPath, 'utf8')
      const parsed = JSON.parse(raw) as { kind: string; apiKey?: string; provider?: string }
      expect(parsed.kind).toBe('api-key')
      expect(parsed.apiKey).toBe('nw-test-key')
      expect(parsed.provider).toBe('neuralwatt')
    })

    it('persists a Pi (OpenRouter) api key via the test-only login hook', async () => {
      // pi is api-key-only, so the hook holds a raw key. With no provider
      // override the credential defaults to openrouter. Menu choice 5 is pi.
      const env = { ...testEnv.env, YAAC_E2E_PI_LOGIN: 'sk-or-v1-pi-test-key' }
      const { stdout, exitCode } = await runYaac(env, 'auth', 'update', { stdin: '5\n' })
      expect(exitCode).toBe(0)
      expect(stdout).toContain('Pi credentials saved.')

      const credsPath = path.join(testEnv.dataDir, 'server-local', '.credentials', 'pi.json')
      const raw = await fs.readFile(credsPath, 'utf8')
      const parsed = JSON.parse(raw) as {
        kind: string; apiKey?: string; savedAt?: string; provider?: string
      }
      expect(parsed.kind).toBe('api-key')
      expect(parsed.apiKey).toBe('sk-or-v1-pi-test-key')
      expect(parsed.provider).toBe('openrouter')
      expect(typeof parsed.savedAt).toBe('string')
    })

    it('persists a Pi Anthropic api key when the provider hook is set', async () => {
      const env = {
        ...testEnv.env,
        YAAC_E2E_PI_LOGIN: 'sk-ant-pi-test-key',
        YAAC_E2E_PI_PROVIDER: 'anthropic',
      }
      const { stdout, exitCode } = await runYaac(env, 'auth', 'update', { stdin: '5\n' })
      expect(exitCode).toBe(0)
      expect(stdout).toContain('Pi credentials saved.')

      const credsPath = path.join(testEnv.dataDir, 'server-local', '.credentials', 'pi.json')
      const raw = await fs.readFile(credsPath, 'utf8')
      const parsed = JSON.parse(raw) as { kind: string; apiKey?: string; provider?: string }
      expect(parsed.kind).toBe('api-key')
      expect(parsed.apiKey).toBe('sk-ant-pi-test-key')
      expect(parsed.provider).toBe('anthropic')
    })
  })
})
