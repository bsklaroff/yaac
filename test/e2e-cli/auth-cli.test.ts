import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import {
  createYaacTestEnv,
  spawnYaacServer,
  runYaac,
  type YaacTestEnv,
  type SpawnedServer,
} from '@yaac/test-utils/cli'
import { makeServerApiClient, signInTestTool } from '@yaac/test-utils/api'
import { CLAUDE_STUB, CODEX_STUB } from '@yaac/test-utils/fixtures'
import type { AgentTool, ToolAuthSummary } from '@yaac/shared/types'

/**
 * The auth and tool CLI commands, sharing one test env and one server for
 * the whole file.
 *
 * Tests run in declaration order. The "clean data dir" describe must stay
 * first, and every test that depends on the exact credential set resets the
 * caller's sign-ins to the state it seeds. A sign-in is stored whole, so a
 * test that only reads back what its own command just stored needs no
 * reset. What is stored is read back through `GET /auth/list`, masked to a
 * key's last four characters.
 *
 * The YAAC_E2E_*_LOGIN / YAAC_E2E_OPENCODE_PROVIDER hooks (runToolLogin in
 * packages/shared/src/tool-auth-interactive.ts) and the stub vendor CLIs of
 * YAAC_E2E_*_LOGIN_CLI are read by the CLI process, which runs the browser
 * sign-in itself, not the server, so they are passed per runYaac call.
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

  /** The server's masked summary of the caller's sign-in for a tool. */
  async function stored(tool: AgentTool): Promise<ToolAuthSummary | undefined> {
    const res = await makeServerApiClient(server).auth.list.$get()
    return (await res.json()).toolAuth.find((t) => t.tool === tool)
  }

  /** Sign the caller out of every tool, so earlier tests' sign-ins can't
   *  change list output or shift `auth clear` menu indexes. */
  async function resetCreds(): Promise<void> {
    const res = await makeServerApiClient(server).auth.clear.$post({ json: { service: 'all' } })
    if (!res.ok) throw new Error(`auth clear failed: ${res.status}`)
  }

  /** Seed the claude and codex api-key credentials and nothing else, so
   *  the `auth clear` menu lists exactly those two, in that order. */
  async function seedToolCreds(): Promise<void> {
    await resetCreds()
    await signInTestTool(server, 'claude', { kind: 'api-key', apiKey: 'sk-ant-api03-clear-me' })
    await signInTestTool(server, 'codex', { kind: 'api-key', apiKey: 'sk-codex-clear-me' })
  }

  // Must run before anything stores a credential.
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
      await resetCreds()
      await signInTestTool(server, 'claude', { kind: 'api-key', apiKey: 'sk-ant-api03-fake-claude-key' })
      await signInTestTool(server, 'codex', { kind: 'api-key', apiKey: 'sk-fake-codex-key' })

      const { stdout, exitCode } = await runYaac(testEnv.env, 'auth', 'list')
      expect(exitCode).toBe(0)

      expect(stdout).toMatch(/claude\s+\*\*\*-key.*api-key/)
      expect(stdout).toMatch(/codex\s+\*\*\*-key.*api-key/)
      expect(stdout).not.toContain('sk-ant-api03-fake-claude-key')
      expect(stdout).not.toContain('sk-fake-codex-key')
    })
  })

  describe('auth fake', () => {
    it('refuses to replace a real credential, and seeds once it is cleared', async () => {
      // `auth list` above left a real claude api-key behind, which a fake
      // must never replace.
      await resetCreds()
      await signInTestTool(server, 'claude', { kind: 'api-key', apiKey: 'sk-ant-api03-real' })
      const refused = await runYaac(testEnv.env, 'auth', 'fake', 'claude-oauth')
      expect(refused.exitCode).not.toBe(0)
      expect(refused.stderr).toMatch(/real credential is already stored for claude-oauth/)
      expect(await stored('claude')).toMatchObject({ kind: 'api-key', keyPreview: '***real' })

      await resetCreds()
      const seeded = await runYaac(testEnv.env, 'auth', 'fake', 'claude-oauth')
      expect(seeded.exitCode, seeded.stderr).toBe(0)
    })

    it('auth fake claude-oauth seeds an OAuth bundle of placeholders', async () => {
      // Re-seeding over the previous case's fake is allowed.
      const { exitCode, stderr } = await runYaac(testEnv.env, 'auth', 'fake', 'claude-oauth')
      expect(exitCode, stderr).toBe(0)

      // `yaac-ph-access`, masked.
      expect(await stored('claude')).toMatchObject({ kind: 'oauth', keyPreview: '***cess' })
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

      expect(await stored('opencode')).toMatchObject({ kind: 'api-key', opencodeProvider: 'openrouter', keyPreview: '***-key' })
    })

    it('auth fake pi-openrouter seeds a placeholder openrouter api-key', async () => {
      const { exitCode, stderr } = await runYaac(testEnv.env, 'auth', 'fake', 'pi-openrouter')
      expect(exitCode, stderr).toBe(0)

      expect(await stored('pi')).toMatchObject({ kind: 'api-key', piProvider: 'openrouter', keyPreview: '***-key' })
    })

    it('seeds several kinds passed in one invocation (variadic)', async () => {
      const { exitCode, stdout, stderr } = await runYaac(
        testEnv.env, 'auth', 'fake', 'claude-oauth', 'opencode-openrouter',
      )
      expect(exitCode, stderr).toBe(0)
      expect(stdout).toContain('Claude OAuth')
      expect(stdout).toContain('OpenCode OpenRouter')

      expect(await stored('claude')).toMatchObject({ kind: 'oauth', keyPreview: '***cess' })
      expect(await stored('opencode')).toMatchObject({ opencodeProvider: 'openrouter' })
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
      expect(await stored('claude')).toBeUndefined()
      expect(await stored('codex')).toBeDefined()
    })

    it('removes every credential when the user answers "all"', async () => {
      await seedToolCreds()

      const { stdout, exitCode } = await runYaac(testEnv.env, 'auth', 'clear', { stdin: 'all\n' })
      expect(exitCode).toBe(0)
      expect(stdout).toContain('All credentials removed.')
      expect(await stored('claude')).toBeUndefined()
      expect(await stored('codex')).toBeUndefined()
    })

    it('prints "Cancelled." on an out-of-range menu choice', async () => {
      await seedToolCreds()

      const { stdout, exitCode } = await runYaac(testEnv.env, 'auth', 'clear', { stdin: '99\n' })
      expect(exitCode).toBe(0)
      expect(stdout).toContain('Cancelled.')
      expect(await stored('claude')).toBeDefined()
      expect(await stored('codex')).toBeDefined()
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

      expect(await stored('claude')).toMatchObject({ kind: 'oauth', keyPreview: '***cess' })
    })

    it('signs Claude in in-process and seeds an unset git identity from git config', async () => {
      const identity = async (): Promise<unknown> =>
        (await (await makeServerApiClient(server).config['git-identity'].$get()).json()).identity
      const gitConfig = testEnv.env.GIT_CONFIG_GLOBAL!
      await fs.writeFile(gitConfig, '[user]\n\tname = Seeded User\n\temail = seeded@example.com\n')
      try {
        expect(await identity()).toBeNull()
        const env = { ...testEnv.env, YAAC_E2E_CLAUDE_LOGIN_CLI: JSON.stringify([process.execPath, CLAUDE_STUB]) }
        const res = await runYaac(env, 'auth', 'update', { stdin: '2\n' })
        expect(res.exitCode, res.stderr).toBe(0)
        // The vendor CLI's output, sign-in URL included, is relayed.
        expect(res.stdout).toMatch(/claude\.com\/cai\/oauth/)
        expect(res.stdout).toContain('Claude Code credentials saved.')
        expect(await stored('claude')).toMatchObject({ kind: 'oauth', keyPreview: '***ogin' })
        expect(await identity()).toEqual({ name: 'Seeded User', email: 'seeded@example.com' })

        // A second machine's git config never replaces an identity.
        await fs.writeFile(gitConfig, '[user]\n\tname = Other User\n\temail = other@example.com\n')
        const codexEnv = { ...testEnv.env, YAAC_E2E_CODEX_LOGIN_CLI: JSON.stringify([process.execPath, CODEX_STUB]) }
        const codex = await runYaac(codexEnv, 'auth', 'update', { stdin: '3\n' })
        expect(codex.exitCode, codex.stderr).toBe(0)
        expect(codex.stdout).toContain('Codex credentials saved.')
        expect(await stored('codex')).toMatchObject({ kind: 'oauth' })
        expect(await identity()).toEqual({ name: 'Seeded User', email: 'seeded@example.com' })
      } finally {
        await fs.writeFile(gitConfig, '')
      }
    })

    it('exits 1 with the vendor CLI\'s error when its sign-in fails', async () => {
      const env = {
        ...testEnv.env,
        YAAC_E2E_CODEX_LOGIN_CLI: JSON.stringify([process.execPath, CODEX_STUB]),
        FAKE_LOGIN_MODE: 'fail',
      }
      const res = await runYaac(env, 'auth', 'update', { stdin: '3\n' })
      expect(res.exitCode).toBe(1)
      expect(res.stderr).toContain('Login was not completed.')
    })

    it('persists an OpenCode (OpenRouter) api key via the test-only login hook', async () => {
      // opencode is api-key-only, so the hook holds a raw key. With no
      // provider override the credential defaults to openrouter.
      const env = { ...testEnv.env, YAAC_E2E_OPENCODE_LOGIN: 'sk-or-v1-test-key' }
      const { stdout, exitCode } = await runYaac(env, 'auth', 'update', { stdin: '4\n' })
      expect(exitCode).toBe(0)
      expect(stdout).toContain('OpenCode credentials saved.')

      expect(await stored('opencode')).toMatchObject({ kind: 'api-key', opencodeProvider: 'openrouter', keyPreview: '***-key' })
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

      expect(await stored('opencode')).toMatchObject({ kind: 'api-key', opencodeProvider: 'neuralwatt', keyPreview: '***-key' })
    })

    it('persists a Pi (OpenRouter) api key via the test-only login hook', async () => {
      // pi is api-key-only, so the hook holds a raw key. With no provider
      // override the credential defaults to openrouter. Menu choice 5 is pi.
      const env = { ...testEnv.env, YAAC_E2E_PI_LOGIN: 'sk-or-v1-pi-test-key' }
      const { stdout, exitCode } = await runYaac(env, 'auth', 'update', { stdin: '5\n' })
      expect(exitCode).toBe(0)
      expect(stdout).toContain('Pi credentials saved.')

      expect(await stored('pi')).toMatchObject({ kind: 'api-key', piProvider: 'openrouter', keyPreview: '***-key' })
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

      expect(await stored('pi')).toMatchObject({ kind: 'api-key', piProvider: 'anthropic', keyPreview: '***-key' })
    })
  })

  // The daemon the desktop app bundles, run from source as its
  // utilityProcess would run the bundle.
  describe('the desktop app\'s auth daemon', () => {
    it('relays a webapp sign-in to the server it was started for, and drops off when stopped', async () => {
      // An earlier case stored the same stub credential.
      await resetCreds()
      const serverJson = path.join(`${testEnv.dataDir}-client`, 'server.json')
      const selected = await fs.readFile(serverJson, 'utf8')
      const origin = (JSON.parse(selected) as { url: string }).url
      const get = async <T>(p: string): Promise<T> => (await fetch(`${origin}/api${p}`)).json() as Promise<T>
      const connected = async (): Promise<boolean> => (await get<{ connected: boolean }>('/auth/agent')).connected

      const tsx = createRequire(import.meta.url).resolve('tsx/cli')
      const entry = path.resolve(import.meta.dirname, '../../packages/desktop/src/auth-daemon.ts')
      const daemon = spawn(process.execPath, [tsx, entry, origin], {
        env: {
          ...testEnv.env,
          YAAC_E2E_CLAUDE_LOGIN_CLI: JSON.stringify([process.execPath, CLAUDE_STUB]),
          FAKE_LOGIN_DELAY_MS: '1500',
        },
        stdio: 'ignore',
      })
      try {
        await vi.waitFor(async () => { expect(await connected()).toBe(true) }, { timeout: 30_000, interval: 250 })

        const start = await fetch(`${origin}/api/auth/claude/login/start`, { method: 'POST' })
        const { id } = await start.json() as { id: string }
        // Selecting another server mid-flow must not move where the
        // credential is saved.
        await fs.writeFile(serverJson, JSON.stringify({ ...JSON.parse(selected) as object, url: 'http://127.0.0.1:1' }))
        await vi.waitFor(async () => {
          expect((await get<{ status: string }>(`/auth/login/${id}`)).status).toBe('success')
        }, { timeout: 30_000, interval: 250 })
        expect(await stored('claude')).toMatchObject({ kind: 'oauth', keyPreview: '***ogin' })
      } finally {
        await fs.writeFile(serverJson, selected)
        daemon.kill('SIGTERM')
      }
      await vi.waitFor(async () => { expect(await connected()).toBe(false) }, { timeout: 15_000, interval: 250 })
    })
  })
})
