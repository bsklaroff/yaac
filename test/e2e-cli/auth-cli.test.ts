import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import path from 'node:path'
import { createYaacTestEnv, spawnYaacServer, runYaac, type YaacTestEnv } from '#support/cli'
import { makeServerApiClient, signInTestTool, type SpawnedServer } from '@yaac/test-utils/api'
import { CLAUDE_STUB, CODEX_STUB } from '@yaac/test-utils/fixtures'
import type { AgentTool, CustomEndpointSummary, ToolAuthSummary } from '@yaac/shared/types'

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
 * The stub vendor CLIs of YAAC_E2E_*_LOGIN_CLI are read by the CLI process,
 * which runs the browser sign-in itself, not the server, so they are passed
 * per runYaac call.
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

    it('auth fake omp-openrouter seeds a placeholder openrouter api-key', async () => {
      const { exitCode, stderr } = await runYaac(testEnv.env, 'auth', 'fake', 'omp-openrouter')
      expect(exitCode, stderr).toBe(0)

      expect(await stored('omp')).toMatchObject({ kind: 'api-key', ompProvider: 'openrouter', keyPreview: '***-key' })
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
            { when: /Choice \[1-6\]: /, send: '1\n' },
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
            { when: /Choice \[1-6\]: /, send: '1\n' },
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
            { when: /Choice \[1-6\]: /, send: '1\n' },
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

    /** `yaac auth update` for an api-key tool, answering its prompts. */
    const pasteApiKey = (choice: string, provider: string, key: string): ReturnType<typeof runYaac> =>
      runYaac(testEnv.env, 'auth', 'update', {
        stdinOnPrompt: [
          { when: /Choice \[1-6\]: /, send: `${choice}\n` },
          { when: /Provider \[openrouter\]: /, send: `${provider}\n` },
          { when: /Paste your .*API key: /, send: `${key}\n` },
        ],
      })

    it('stores an OpenCode api key for the default provider when Enter takes it', async () => {
      const { stdout, exitCode } = await pasteApiKey('4', '', 'sk-or-v1-test-key')
      expect(exitCode).toBe(0)
      expect(stdout).toContain('OpenCode credentials saved.')

      expect(await stored('opencode')).toMatchObject({ kind: 'api-key', opencodeProvider: 'openrouter', keyPreview: '***-key' })
    })

    it('stores an OpenCode api key for the provider typed at the prompt', async () => {
      const { stdout, exitCode } = await pasteApiKey('4', 'neuralwatt', 'nw-test-key')
      expect(exitCode).toBe(0)
      expect(stdout).toContain('OpenCode credentials saved.')

      expect(await stored('opencode')).toMatchObject({ kind: 'api-key', opencodeProvider: 'neuralwatt', keyPreview: '***-key' })
    })

    it('stores a Pi api key for the default provider, or the one typed', async () => {
      const fallback = await pasteApiKey('5', '', 'sk-or-v1-pi-test-key')
      expect(fallback.exitCode).toBe(0)
      expect(fallback.stdout).toContain('Pi credentials saved.')
      expect(await stored('pi')).toMatchObject({ kind: 'api-key', piProvider: 'openrouter', keyPreview: '***-key' })

      const typed = await pasteApiKey('5', 'anthropic', 'sk-ant-pi-test-key')
      expect(typed.exitCode).toBe(0)
      expect(await stored('pi')).toMatchObject({ kind: 'api-key', piProvider: 'anthropic', keyPreview: '***-key' })
    })

    it('stores an Oh My Pi api key for the provider typed, apart from pi\'s', async () => {
      const { stdout, exitCode } = await pasteApiKey('6', 'deepseek', 'sk-ds-omp-test-key')
      expect(exitCode).toBe(0)
      expect(stdout).toContain('Oh My Pi credentials saved.')
      expect(await stored('omp')).toMatchObject({ kind: 'api-key', ompProvider: 'deepseek', keyPreview: '***-key' })
    })
  })

  describe('auth endpoint', () => {
    // The containerless tier's server runs on this host and can reach a stub
    // here; a cluster's server pod cannot, so the cases that fetch /models
    // run in that tier only.
    const reachesHost = process.env.YAAC_DRIVER === 'containerless'
    /** What the stub endpoint's /models lists next. */
    let listed: unknown[] = []
    let stub: http.Server
    let stubUrl: string

    beforeAll(async () => {
      stub = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: listed }))
      })
      await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
      stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/v1`
    })

    afterAll(async () => {
      stub.closeAllConnections()
      await new Promise((resolve) => stub.close(resolve))
    })

    /** The caller's endpoints as the server lists them. */
    async function endpoints(): Promise<CustomEndpointSummary[]> {
      const res = await makeServerApiClient(server).auth.list.$get()
      return (await res.json()).customEndpoints
    }

    /**
     * An `$EDITOR` that writes each of `saves` over the file in turn, one per
     * opening, keeping its `//` header, and records what it was shown.
     */
    async function scriptedEditor(saves: string[]): Promise<{ env: NodeJS.ProcessEnv; shown: () => Promise<string[]> }> {
      const dir = await fs.mkdtemp(path.join(testEnv.dataDir, 'editor-'))
      await fs.writeFile(path.join(dir, 'saves.json'), JSON.stringify(saves))
      const script = path.join(dir, 'editor.cjs')
      await fs.writeFile(script, `
        const fs = require('fs'), path = require('path')
        const dir = ${JSON.stringify(dir)}
        const saves = JSON.parse(fs.readFileSync(path.join(dir, 'saves.json'), 'utf8'))
        const shown = fs.existsSync(path.join(dir, 'shown.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'shown.json'), 'utf8')) : []
        const file = process.argv[2]
        const text = fs.readFileSync(file, 'utf8')
        shown.push(text)
        fs.writeFileSync(path.join(dir, 'shown.json'), JSON.stringify(shown))
        const next = saves[shown.length - 1]
        if (next !== undefined) fs.writeFileSync(file, next)
      `)
      return {
        env: { ...testEnv.env, VISUAL: '', EDITOR: `${process.execPath} ${script}` },
        shown: async () => JSON.parse(await fs.readFile(path.join(dir, 'shown.json'), 'utf8')) as string[],
      }
    }

    it('adds endpoints from a models file, edits each part, signs a tool in with one and removes it', async () => {
      await resetCreds()
      const file = path.join(testEnv.dataDir, 'models.json')
      await fs.writeFile(file, JSON.stringify([{ id: 'gpt-oss', efforts: { levels: ['low', 'high'], default: 'low' } }]))
      const added = await runYaac(testEnv.env, 'auth', 'endpoint', 'add', 'files', 'http://box.example:8080/v1', '--models-file', file)
      expect(added.exitCode).toBe(0)
      expect(added.stdout).toContain('Custom endpoint "files" saved with 1 model(s):')
      expect(added.stdout).toContain('gpt-oss [low* high]')
      // A key read from stdin, for an https endpoint (a cluster refuses one
      // over plain HTTP).
      const keyed = await runYaac(testEnv.env, 'auth', 'endpoint', 'add', 'keyed', 'https://llm.example.com/v1',
        '--key-stdin', '--models-file', file, { stdin: 'sk-e2e-endpoint-key\n' })
      expect(keyed.exitCode).toBe(0)
      expect((await endpoints()).find((e) => e.name === 'keyed')).toMatchObject({ keyPreview: '***-key' })

      // `models` prints what `--models-file` reads, so an edit round-trips.
      const printed = await runYaac(testEnv.env, 'auth', 'endpoint', 'models', 'files')
      expect(JSON.parse(printed.stdout)).toEqual([{ id: 'gpt-oss', efforts: { levels: ['low', 'high'], default: 'low' } }])
      const piped = await runYaac(testEnv.env, 'auth', 'endpoint', 'edit', 'files', '--models-file', '-',
        { stdin: JSON.stringify([{ id: 'gpt-oss', name: 'gpt-oss 120B' }, { id: 'gemma' }]) })
      expect(piped.exitCode).toBe(0)
      expect((await endpoints()).find((e) => e.name === 'files')?.models).toEqual([{ id: 'gpt-oss', name: 'gpt-oss 120B' }, { id: 'gemma' }])
      const bad = await runYaac(testEnv.env, 'auth', 'endpoint', 'edit', 'files', '--models-file', '-',
        { stdin: JSON.stringify([{ id: 'x', efforts: { levels: ['low'], default: 'high' } }]) })
      expect(bad.exitCode).not.toBe(0)
      expect(bad.stderr).toContain('[0].efforts.default: the default is not one of the levels')

      const moved = await runYaac(testEnv.env, 'auth', 'endpoint', 'edit', 'files', '--rename', 'renamed',
        '--url', 'https://moved.example.com/v1', '--key-stdin', { stdin: 'sk-moved-key' })
      expect(moved.exitCode).toBe(0)
      expect((await endpoints()).find((e) => e.name === 'renamed'))
        .toMatchObject({ baseUrl: 'https://moved.example.com/v1', keyPreview: '***-key' })
      expect((await runYaac(testEnv.env, 'auth', 'endpoint', 'edit', 'renamed', '--clear-key')).exitCode).toBe(0)
      expect((await endpoints()).find((e) => e.name === 'renamed')).toMatchObject({ keyPreview: '' })

      // `yaac auth update` signs pi in with an endpoint named at its prompt.
      const signedIn = await runYaac(testEnv.env, 'auth', 'update', {
        stdinOnPrompt: [
          { when: /Choice \[1-6\]: /, send: '5\n' },
          { when: /Provider \[openrouter\]: /, send: 'custom\n' },
          { when: /Custom endpoint: /, send: 'renamed\n' },
        ],
      })
      expect(signedIn.exitCode).toBe(0)
      expect(signedIn.stdout).toContain('Your custom endpoints: renamed, keyed.')
      expect(await stored('pi')).toMatchObject({
        piProvider: 'custom', endpoint: { name: 'renamed', baseUrl: 'https://moved.example.com/v1' },
        models: [{ id: 'custom/gpt-oss', name: 'gpt-oss 120B' }, { id: 'custom/gemma' }],
      })
      const list = await runYaac(testEnv.env, 'auth', 'list')
      expect(list.stdout).toMatch(/pi\s+endpoint "renamed"/)
      expect(list.stdout).toContain('Custom endpoints:')
      expect(list.stdout).toContain('renamed  https://moved.example.com/v1  (used by pi)')
      expect(list.stdout).toContain('    gpt-oss (gpt-oss 120B)')

      // The editor: a save that does not parse reopens with its errors, an
      // unchanged one cancels.
      const editor = await scriptedEditor(['not json', '[{ "id": "edited" }]'])
      const edited = await runYaac(editor.env, 'auth', 'endpoint', 'edit', 'renamed')
      expect(edited.exitCode).toBe(0)
      expect(edited.stdout).toContain('Custom endpoint "renamed" saved. Updated for pi; agents already running keep their list until restarted.')
      const shown = await editor.shown()
      expect(shown[0]).toContain('// The models of the custom endpoint "renamed" (https://moved.example.com/v1).')
      expect(shown[0]).toContain('"gpt-oss 120B"')
      expect(shown[1]).toContain('// The last save did not parse:')
      expect((await endpoints()).find((e) => e.name === 'renamed')?.models).toEqual([{ id: 'edited' }])
      const unchanged = await runYaac((await scriptedEditor([])).env, 'auth', 'endpoint', 'edit', 'renamed')
      expect(unchanged.stdout).toContain('Nothing changed.')

      const removed = await runYaac(testEnv.env, 'auth', 'endpoint', 'remove', 'renamed')
      expect(removed.exitCode).toBe(0)
      expect(removed.stdout).toContain('Custom endpoint "renamed" deleted. Signed out: pi.')
      expect(await stored('pi')).toBeUndefined()
      expect((await runYaac(testEnv.env, 'auth', 'endpoint', 'remove', 'renamed')).stderr).toContain('No custom endpoint named "renamed". Yours: keyed.')
    })

    it.runIf(reachesHost)('adds an endpoint from its /models, then reviews and applies what a refresh finds', async () => {
      listed = [
        { id: 'gpt-oss', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], default_reasoning_level: 'high' },
        { id: 'qwen3', meta: { llamaswap: { supported_reasoning_levels: ['low', 'medium'] } } },
        { id: 'embed', capabilities: { embeddings: true } },
      ]
      const added = await runYaac(testEnv.env, 'auth', 'endpoint', 'add', 'swap', stubUrl)
      expect(added.exitCode).toBe(0)
      expect(added.stdout).toContain('skipped embed: not a chat model')
      expect(added.stdout).toContain('gpt-oss [low high*]')
      expect(added.stdout).toContain('qwen3 [low medium*]')

      // Without --apply a refresh only shows what changed.
      listed = [listed[0], { id: 'qwen3', supported_reasoning_levels: ['low', 'medium', 'high'] }, { id: 'llama4' }]
      const shown = await runYaac(testEnv.env, 'auth', 'endpoint', 'refresh', 'swap')
      expect(shown.stdout).toContain('  new      llama4')
      expect(shown.stdout).toContain('  changed  qwen3 [low medium*] -> qwen3 [low medium* high]')
      expect(shown.stdout).toContain('Apply with --apply all')
      const models = async (): Promise<unknown> => (await endpoints()).find((e) => e.name === 'swap')?.models
      expect(await models()).toHaveLength(2)

      expect((await runYaac(testEnv.env, 'auth', 'endpoint', 'refresh', 'swap', '--apply', 'new')).exitCode).toBe(0)
      expect(await models()).toEqual([
        { id: 'gpt-oss', efforts: { levels: ['low', 'high'], default: 'high' } },
        { id: 'qwen3', efforts: { levels: ['low', 'medium'], default: 'medium' } },
        { id: 'llama4' },
      ])
      // --edit opens the merged list (new and changed by default) for
      // review, and saving it as shown stores it.
      listed = [listed[1]]
      const editor = await scriptedEditor([])
      const reviewed = await runYaac(editor.env, 'auth', 'endpoint', 'refresh', 'swap', '--edit')
      expect(reviewed.stdout).toContain('  gone     gpt-oss [low high*]')
      expect((await editor.shown())[0]).toContain('"high"')
      expect(reviewed.stdout).toContain('Custom endpoint "swap" saved with 3 model(s).')
      expect(await models()).toEqual([
        { id: 'gpt-oss', efforts: { levels: ['low', 'high'], default: 'high' } },
        { id: 'qwen3', efforts: { levels: ['low', 'medium', 'high'], default: 'medium' } },
        { id: 'llama4' },
      ])
      // Only gone models are left, which start unpicked: the merged list is
      // the stored one, so saving it as shown changes nothing.
      const again = await runYaac((await scriptedEditor([])).env, 'auth', 'endpoint', 'refresh', 'swap', '--edit')
      expect(again.stdout).toContain('Nothing changed.')
      expect((await runYaac(testEnv.env, 'auth', 'endpoint', 'refresh', 'swap', '--apply', 'all')).exitCode).toBe(0)
      expect(await models()).toEqual([{ id: 'qwen3', efforts: { levels: ['low', 'medium', 'high'], default: 'medium' } }])
      expect((await runYaac(testEnv.env, 'auth', 'endpoint', 'refresh', 'swap')).stdout).toContain('The endpoint\'s list matches yours.')

      // `yaac auth update` adds an endpoint under a new name, from its /models.
      const signedIn = await runYaac(testEnv.env, 'auth', 'update', {
        stdinOnPrompt: [
          { when: /Choice \[1-6\]: /, send: '6\n' },
          { when: /Provider \[openrouter\]: /, send: 'custom\n' },
          { when: /Custom endpoint: /, send: 'fresh\n' },
          { when: /Endpoint URL .*: /, send: `${stubUrl}\n` },
          { when: /API key \(Enter for none\): /, send: '\n' },
        ],
      })
      expect(signedIn.exitCode).toBe(0)
      expect(signedIn.stdout).toContain('Custom endpoint "fresh" saved')
      expect(await stored('omp')).toMatchObject({ ompProvider: 'custom', endpoint: { name: 'fresh' }, defaultModel: 'custom/qwen3' })
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
