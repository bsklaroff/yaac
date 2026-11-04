import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createYaacTestEnv, spawnYaacServer, runYaac, type RunYaacOptions, type YaacTestEnv } from '#support/cli'
import { makeServerApiClient, type SpawnedServer } from '@yaac/test-utils/api'
import { createTestRepo } from '@yaac/test-utils/setup'
import { addTestProject } from '#support/cluster'
import { BUILT_IN_USER_ID } from '@yaac/server/db/user-store'
import { git } from '@yaac/test-utils/git'

/**
 * e2e coverage for `yaac project` (list/add/create/clone/move) and `yaac
 * config`, sharing one test env and server across the file.
 *
 * Tests run in declaration order over one data dir, so order matters:
 *  - The empty-state `project list` test runs first.
 *  - The `project add` validation tests leave no project behind (rejects
 *    happen before any write; a failed clone rolls back). They use the
 *    `fake-github` credential beforeAll seeds.
 *  - Seeded project names are unique across the file (repo-alpha/repo-beta,
 *    demo-*) except where a case makes two projects share one on purpose.
 *  - The config settings cases use the hosted-demo project `project create`
 *    left behind as their hosted project that takes no git credential.
 */

let testEnv: YaacTestEnv
let server: SpawnedServer
/** The file also runs in the containerless tier, whose server builds no
 *  images, so its Dockerfile routes refuse (see the route matrix). */
const buildsImages = process.env.YAAC_DRIVER !== 'containerless'

beforeAll(async () => {
  testEnv = await createYaacTestEnv()
  server = await spawnYaacServer(testEnv.env)
  expect((await runYaac(testEnv.env, 'auth', 'fake', 'github')).exitCode).toBe(0)
})

afterAll(async () => {
  await server.stop()
  await testEnv.cleanup()
})

describe('yaac project (real CLI + real server)', () => {
  // Must run first (see the file header).
  it('project list prints the empty-state hint when no projects exist', async () => {
    const { stdout, exitCode } = await runYaac(testEnv.env, 'project', 'list')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('No projects found')
    expect(stdout).toContain('yaac project add')
  })

  it('project add accepts a non-GitHub HTTPS URL, cloning it with the named credential', async () => {
    // The host does not exist, so failing at the clone shows URL
    // validation let the non-github host through.
    const { stdout, stderr, exitCode } = await runYaac(
      testEnv.env, 'project', 'add', 'https://gitlab.example.com/foo/bar', 'fake-github',
    )
    const combined = stdout + stderr
    expect(exitCode).not.toBe(0)
    expect(combined).not.toMatch(/only github/i)
    expect(combined).toMatch(/Failed to clone|git authentication failed/)
  })

  it('project add accepts SCP-style SSH URLs, which need an SSH key credential', async () => {
    const { stdout, stderr, exitCode } = await runYaac(
      testEnv.env, 'project', 'add', 'git@github.com:org/repo.git', 'fake-github',
    )
    const combined = stdout + stderr
    expect(exitCode).not.toBe(0)
    expect(combined).not.toMatch(/SSH URLs are not supported/i)
    expect(combined).toMatch(/needs an SSH key, not a token/)
  })

  it('project add requires a credential, and one that exists', async () => {
    const missing = await runYaac(testEnv.env, 'project', 'add', 'https://github.com/org/repo')
    expect(missing.exitCode).not.toBe(0)
    expect(missing.stderr).toMatch(/missing required argument 'credential'/)

    const unknown = await runYaac(testEnv.env, 'project', 'add', 'https://github.com/org/repo', 'nope')
    expect(unknown.exitCode).not.toBe(0)
    expect(unknown.stderr).toContain('No git credential named "nope"')
  })

  it('project add rejects plain HTTP URLs', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'project', 'add', 'http://github.com/org/repo', 'fake-github',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/HTTPS/i)
  })

  it('project add rejects ssh:// URLs pointing at SCP-style instead', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'project', 'add', 'ssh://git@github.com/org/repo', 'fake-github',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/SCP-style/)
  })

  it('project add rejects unparseable URLs', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'project', 'add', 'not-a-url', 'fake-github',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/Unrecognized|Invalid|HTTPS/i)
  })

  it('project list shows each seeded project with its name, id prefix, remote, and session count', async () => {
    const repoAlpha = path.join(testEnv.scratchDir, 'repo-alpha')
    const repoBeta = path.join(testEnv.scratchDir, 'repo-beta')
    await createTestRepo(repoAlpha)
    await createTestRepo(repoBeta)
    const alpha = await addTestProject(server, repoAlpha)
    const beta = await addTestProject(server, repoBeta)

    const { stdout, exitCode } = await runYaac(testEnv.env, 'project', 'list')
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/PROJECT\s+ID\s+REMOTE\s+WORKSPACES/)
    // No workspaces started, so 0 sessions each.
    expect(stdout).toMatch(new RegExp(`repo-alpha\\s+${alpha.slice(0, 8)}\\s+https://github.com/test-org/repo-alpha.git\\s+0`))
    expect(stdout).toMatch(new RegExp(`repo-beta\\s+${beta.slice(0, 8)}\\s+https://github.com/test-org/repo-beta.git\\s+0`))
  })

  it('project create makes an empty hosted project, which project clone clones for pushing', async () => {
    const created = await runYaac(testEnv.env, 'project', 'create', 'Hosted Demo')
    expect(created.exitCode).toBe(0)
    expect(created.stdout).toContain('Project "hosted-demo"')
    expect(created.stdout).toContain('yaac project clone hosted-demo')

    // Into a named directory, then pushed to like any remote.
    const dir = path.join(testEnv.scratchDir, 'hosted-named')
    const cloned = await runYaac(testEnv.env, 'project', 'clone', 'hosted-demo', dir)
    expect(cloned.exitCode).toBe(0)
    await git(dir, ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'first'])
    await git(dir, ['push', '-q', 'origin', 'HEAD:main'])

    // Into the project's name by default, with what was pushed.
    const parent = path.join(testEnv.scratchDir, 'hosted-default')
    await fs.mkdir(parent)
    expect((await runYaac(testEnv.env, 'project', 'clone', 'hosted-demo', { cwd: parent })).exitCode).toBe(0)
    expect(await git(path.join(parent, 'hosted-demo'), ['log', '--format=%s'])).toBe('first\n')

    const list = await runYaac(testEnv.env, 'project', 'list')
    expect(list.stdout).toMatch(/hosted-demo\s+\S+\s+\(hosted by yaac\)\s+0/)
  })

  it('project create refuses an unusable name, and project clone a project yaac does not host', async () => {
    const bad = await runYaac(testEnv.env, 'project', 'create', '!!!')
    expect(bad.exitCode).not.toBe(0)
    expect(bad.stderr).toContain('not a usable project name')

    const notHosted = await runYaac(testEnv.env, 'project', 'clone', 'repo-alpha', path.join(testEnv.scratchDir, 'nope'))
    expect(notHosted.exitCode).not.toBe(0)
    expect(notHosted.stderr).toContain('is not hosted by yaac')
  })

  // A move that lands needs a git host to push to, so unit tests cover it
  // (moveProjectToRemote); here every argument reaches the server.
  it('project move warns what it stops, moves only once confirmed on a terminal, and changes nothing when it cannot', async () => {
    const move = (...args: Array<string | RunYaacOptions>): ReturnType<typeof runYaac> => runYaac(testEnv.env, 'project', 'move', ...args)
    const answer = (send: string): RunYaacOptions => ({ tty: true, stdinOnPrompt: [{ when: /Continue\? \[y\/N\]/, send }] })
    const target = 'https://gitlab.example.com/foo/bar'
    const stillHosted = async (): Promise<void> => {
      expect((await runYaac(testEnv.env, 'project', 'list')).stdout).toMatch(/hosted-demo\s+\S+\s+\(hosted by yaac\)/)
    }

    // With no terminal to confirm on it refuses; on one, Enter means no.
    const unconfirmed = await move('hosted-demo', target, 'fake-github')
    expect(unconfirmed.exitCode).toBe(1)
    expect(unconfirmed.stderr).toContain('only moved from a terminal')
    const declined = await move('hosted-demo', target, 'fake-github', answer('\r'))
    expect(declined.stdout).toContain(`This moves hosted-demo to ${target}, which must be empty. It first stops 0 running workspace(s)`)
    expect(declined.stdout).toContain('Aborted — nothing was stopped or moved.')
    await stillHosted()

    // Before anything stops, the move fails: behind the egress proxy on the
    // allowlist, and on the host because it does not exist.
    const unreachable = await move('hosted-demo', target, 'fake-github', answer('y\r'))
    expect(unreachable.exitCode).not.toBe(0)
    expect(unreachable.stdout).toContain(`Moving hosted-demo to ${target}...`)
    expect(unreachable.stdout).toMatch(buildsImages
      ? /"gitlab.example.com" is not in the egress allowlist of "hosted-demo"/
      : /did not move: .*It stays on yaac/s)
    await stillHosted()

    const sshWithToken = await move('hosted-demo', 'git@github.com:org/repo.git', 'fake-github', answer('y\r'))
    expect(sshWithToken.stdout).toMatch(/needs an SSH key, not a token/)
    const missing = await move('hosted-demo', 'https://github.com/org/repo')
    expect(missing.stderr).toMatch(/missing required argument 'credential'/)
    const unknown = await move('hosted-demo', 'https://github.com/org/repo', 'nope')
    expect(unknown.stderr).toContain('No git credential named "nope"')
    // Refused before it asks.
    const notHosted = await move('repo-alpha', 'https://github.com/org/repo', 'fake-github')
    expect(notHosted.exitCode).not.toBe(0)
    expect(notHosted.stderr).toContain('is not hosted by yaac')
  })
})

describe('yaac config (real CLI + real server)', () => {
  // Stub $EDITOR that writes fixed content into the temp file the CLI
  // hands it. The CLI PUTs the result, so tests read the server-side file.
  async function writeStubEditor(name: string, content: string): Promise<string> {
    const editorPath = path.join(testEnv.scratchDir, `editor-${name}.sh`)
    const contentFile = path.join(testEnv.scratchDir, `editor-${name}.content`)
    await fs.writeFile(contentFile, content)
    await fs.writeFile(editorPath, `#!/bin/sh\ncat '${contentFile}' > "$1"\n`, { mode: 0o755 })
    return editorPath
  }

  /**
   * Add a project named `name` and return its id. Each test uses a unique
   * `demo-*` name, since the data dir is shared; `dir` places a second repo
   * of the same name elsewhere.
   */
  async function seedProject(name: string, dir = testEnv.scratchDir): Promise<string> {
    const repo = path.join(dir, name)
    await createTestRepo(repo)
    return await addTestProject(server, repo)
  }

  const configFile = (projectId: string, ...rel: string[]): string =>
    path.join(testEnv.dataDir, 'global', 'projects', projectId, 'config', ...rel)

  it('config edit round-trips yaac-config.json through the server (validated), named by project name', async () => {
    const id = await seedProject('demo-edit')

    const editor = await writeStubEditor('config', '{ "cacheVolumes": { "marker": "/tmp/marker" } }')
    const { exitCode, stderr } = await runYaac(
      { ...testEnv.env, EDITOR: editor },
      'config', 'edit', 'demo-edit',
    )
    expect(exitCode, stderr).toBe(0)

    const saved = JSON.parse(await fs.readFile(configFile(id, 'yaac-config.json'), 'utf8')) as { cacheVolumes?: object }
    expect(saved.cacheVolumes).toEqual({ marker: '/tmp/marker' })
  })

  it('config init-steps prints, replaces from a file, refuses a bad graph, and clears a project\'s init steps', async () => {
    await seedProject('demo-steps')
    const show = async (): Promise<unknown> => {
      const { stdout, exitCode, stderr } = await runYaac(testEnv.env, 'config', 'init-steps', 'demo-steps')
      expect(exitCode, stderr).toBe(0)
      return JSON.parse(stdout)
    }
    expect(await show()).toEqual({})

    const file = path.join(testEnv.scratchDir, 'init-steps.json')
    await fs.writeFile(file, JSON.stringify({
      install: { run: 'pnpm install' },
      server: { run: ['pnpm build', 'pnpm start'], needs: ['install'], service: true, ready: 'curl -sf localhost:3000' },
    }))
    const set = await runYaac(testEnv.env, 'config', 'init-steps', 'demo-steps', '--file', file)
    expect(set.exitCode, set.stderr).toBe(0)
    expect(set.stdout).toContain('install, server')
    expect(await show()).toEqual({
      install: { run: ['pnpm install'] },
      server: { run: ['pnpm build', 'pnpm start'], needs: ['install'], service: true, ready: 'curl -sf localhost:3000' },
    })

    await fs.writeFile(file, JSON.stringify({ a: { run: 'x', needs: ['b'] }, b: { run: 'y', needs: ['a'] } }))
    const cyclic = await runYaac(testEnv.env, 'config', 'init-steps', 'demo-steps', '--file', file)
    expect(cyclic.exitCode).not.toBe(0)
    expect(cyclic.stderr).toContain('cycle')
    // The refused graph left the stored one alone.
    expect(Object.keys(await show() as object)).toEqual(['install', 'server'])

    const cleared = await runYaac(testEnv.env, 'config', 'init-steps', 'demo-steps', '--none')
    expect(cleared.exitCode, cleared.stderr).toBe(0)
    expect(cleared.stdout).toContain('are now: none')
    expect(await show()).toEqual({})
  })

  it('config edit rejects invalid JSON, keeps the edits, and leaves the server file alone', async () => {
    const id = await seedProject('demo-badjson')

    const editor = await writeStubEditor('bad-json', '{ not json')
    const { exitCode, stderr } = await runYaac(
      { ...testEnv.env, EDITOR: editor },
      'config', 'edit', 'demo-badjson',
    )
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/Invalid JSON/)
    expect(stderr).toMatch(/Your edits are kept at (.+)/)
    const kept = /Your edits are kept at (.+)/.exec(stderr)?.[1] as string
    expect(await fs.readFile(kept.trim(), 'utf8')).toBe('{ not json')

    await expect(fs.access(configFile(id, 'yaac-config.json'))).rejects.toThrow()
  })

  it.skipIf(!buildsImages)('config edit-dockerfile writes Dockerfile.yaac verbatim via the server, named by id prefix', async () => {
    const id = await seedProject('demo-dockerfile')

    const editor = await writeStubEditor('dockerfile', 'RUN echo dockerfile-marker\n')
    const { exitCode, stderr } = await runYaac(
      { ...testEnv.env, EDITOR: editor },
      'config', 'edit-dockerfile', id.slice(0, 8),
    )
    expect(exitCode, stderr).toBe(0)

    expect(await fs.readFile(configFile(id, 'build', 'Dockerfile.yaac'), 'utf8')).toBe('RUN echo dockerfile-marker\n')
  })

  it.skipIf(!buildsImages)('config edit-user-dockerfile saves a layered Dockerfile.user via the server', async () => {
    const layered = 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo user-marker\n'
    const editor = await writeStubEditor('user-dockerfile', layered)
    const { exitCode, stderr } = await runYaac(
      { ...testEnv.env, EDITOR: editor },
      'config', 'edit-user-dockerfile',
    )
    expect(exitCode, stderr).toBe(0)

    // The caller is local, so the file is the built-in user's.
    const target = path.join(testEnv.dataDir, 'server-local', 'users', BUILT_IN_USER_ID, 'build', 'Dockerfile.user')
    expect(await fs.readFile(target, 'utf8')).toBe(layered)
  })

  it('config edit opens the editor even when yaac-config.json is malformed, named by full id', async () => {
    const id = await seedProject('demo-malformed')

    // Broken content reaches the editor verbatim so it can be repaired.
    const target = configFile(id, 'yaac-config.json')
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, '{ this is not valid json')

    const editor = await writeStubEditor('repair', '{ "cacheVolumes": { "repaired": "/tmp/repaired" } }')
    const { exitCode, stderr } = await runYaac(
      { ...testEnv.env, EDITOR: editor },
      'config', 'edit', id,
    )
    expect(exitCode, stderr).toBe(0)
    const saved = JSON.parse(await fs.readFile(target, 'utf8')) as { cacheVolumes?: object }
    expect(saved.cacheVolumes).toEqual({ repaired: '/tmp/repaired' })
  })

  it('accepts the nestedContainers key through the config-write route', async () => {
    // The config-write route uses the same parser as workspace create.
    const id = await seedProject('demo-nested')

    const client = makeServerApiClient(server)

    const nested = await client.project[':projectId'].config.$put({
      param: { projectId: id },
      json: { config: { nestedContainers: true } },
    })
    expect(nested.status).toBe(200)
  })

  it('config edit fails with a clear error for an unknown project', async () => {
    const editor = await writeStubEditor('should-not-run', 'unused')
    const { exitCode, stderr } = await runYaac(
      { ...testEnv.env, EDITOR: editor },
      'config', 'edit', 'no-such-project',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/no-such-project|not found/i)
  })

  // Adding the same remote twice gives two projects with one name.
  it('config edit and edit-dockerfile refuse a name two projects share, listing both', async () => {
    const first = await seedProject('demo-twin')
    const second = await seedProject('demo-twin', path.join(testEnv.scratchDir, 'twin'))
    const editor = await writeStubEditor('should-not-run-twin', 'unused')
    for (const command of ['edit', 'edit-dockerfile']) {
      const { exitCode, stderr } = await runYaac(
        { ...testEnv.env, EDITOR: editor }, 'config', command, 'demo-twin',
      )
      expect(exitCode, command).not.toBe(0)
      expect(stderr, command).toContain(first)
      expect(stderr, command).toContain(second)
    }
  })
})

describe('yaac config project and user settings (real CLI + real server)', () => {
  const config = (...args: Array<string | RunYaacOptions>): ReturnType<typeof runYaac> => runYaac(testEnv.env, 'config', ...args)

  beforeAll(async () => {
    const repo = path.join(testEnv.scratchDir, 'demo-settings')
    await createTestRepo(repo)
    await addTestProject(server, repo)
  })

  it('config env sets plain variables and secrets with their rules, lists them masked, and unsets them', async () => {
    expect((await config('env', 'demo-settings')).stdout).toContain('demo-settings has no environment variables or secrets.')

    const plain = await config('env', 'demo-settings', 'FOO=bar', 'EMPTY=')
    expect(plain.exitCode, plain.stderr).toBe(0)
    expect(plain.stdout).toContain('Set FOO, EMPTY in demo-settings. Applies to workspaces created from now on.')
    expect((await config('env', 'demo-settings', 'NOVALUE')).stderr).toContain('NOVALUE is not NAME=value')
    expect((await config('env', 'demo-settings', '1BAD=x')).stderr).toContain('is not a valid environment variable name')

    // The value comes from stdin and never reaches the listing.
    const header = await config('env', 'demo-settings', 'API_TOKEN', '--secret', '--host', 'api.example.com',
      '--host', '*.example.org', '--path', '/v1/*', { stdin: 'tok-secret-value\n' })
    expect(header.exitCode, header.stderr).toBe(0)
    expect(header.stdout).toContain('Secret API_TOKEN in demo-settings is stored, for api.example.com, *.example.org /v1/* · header authorization "Bearer "')
    const custom = await config('env', 'demo-settings', 'KEY_HEADER', '--secret', '--host', 'a.example.com',
      '--header', 'x-api-key', { stdin: 'k' })
    expect(custom.stdout).toContain('for a.example.com · header x-api-key.')
    const prefixed = await config('env', 'demo-settings', 'KEY_HEADER', '--secret', '--host', 'a.example.com',
      '--header', 'x-api-key', '--prefix', 'Token ', { stdin: '' })
    expect(prefixed.stdout, prefixed.stderr).toContain('header x-api-key "Token "')
    const body = await config('env', 'demo-settings', 'CLIENT_SECRET', '--secret', '--host', 'auth.example.com',
      '--body-param', 'client_secret', { stdin: 'cs' })
    expect(body.stdout).toContain('for auth.example.com · body client_secret.')
    // On a terminal it is asked for, without echo.
    const typed = await config('env', 'demo-settings', 'CLIENT_SECRET', '--secret', '--host', 'auth.example.com',
      '--body-param', 'client_secret', { tty: true, stdinOnPrompt: [{ when: /Value of CLIENT_SECRET \(not shown/, send: 'typed-value\r' }] })
    expect(typed.stdout).toContain('Secret CLIENT_SECRET in demo-settings is stored')
    expect(typed.stdout).not.toContain('typed-value')

    const list = await config('env', 'demo-settings')
    expect(list.stdout).toContain('Variables in demo-settings:\n  EMPTY=\n  FOO=bar\n')
    expect(list.stdout).toMatch(/API_TOKEN {2}\*{8} {2}api\.example\.com, \*\.example\.org \/v1\/\* · header authorization "Bearer "/)
    expect(list.stdout).not.toContain('tok-secret-value')
    // The rule-only edit, its stdin blank, kept the stored value.
    expect(list.stdout).toContain('KEY_HEADER  ********  a.example.com · header x-api-key "Token "')

    // Refused before anything is sent.
    expect((await config('env', 'demo-settings', 'NEW_SECRET', '--secret', '--host', 'x.example.com', { stdin: '' })).stderr)
      .toContain('a value is required for a new secret')
    expect((await config('env', 'demo-settings', 'S', '--secret', { stdin: 'v' })).stderr).toContain('at least one --host')
    expect((await config('env', 'demo-settings', 'S=v', '--secret', '--host', 'x.example.com')).stderr).toContain('one NAME without a value')
    expect((await config('env', 'demo-settings', 'S', '--secret', '--host', 'x.example.com', '--header', 'h', '--body-param', 'b')).stderr)
      .toContain('--header (and --prefix) or --body-param, not both')
    expect((await config('env', 'demo-settings', 'FOO=x', '--host', 'x.example.com')).stderr).toContain('pass --secret too')
    expect((await config('env', 'demo-settings', 'FOO=x', '--unset', 'FOO')).stderr).toContain('--unset on its own')

    const unset = await config('env', 'demo-settings', '--unset', 'API_TOKEN')
    expect(unset.stdout).toContain('Removed API_TOKEN from demo-settings.')
    expect((await config('env', 'demo-settings', '--unset', 'API_TOKEN')).stderr).toContain('demo-settings has no variable or secret API_TOKEN')
    expect((await config('env', 'demo-settings')).stdout).not.toContain('API_TOKEN')
  })

  it('config egress-allowlist shows and replaces the hosts and defaults, warning when agents lose access; k8s only', async () => {
    if (!buildsImages) {
      const refused = await config('egress-allowlist', 'demo-settings', 'api.example.com')
      expect(refused.exitCode).not.toBe(0)
      expect(refused.stderr).toContain('This server mediates no egress')
      return
    }
    expect((await config('egress-allowlist', 'demo-settings')).stdout).toMatch(/demo-settings's workspaces may reach the \d+ default hosts\./)
    const set = await config('egress-allowlist', 'demo-settings', 'api.example.com', '*.example.org')
    expect(set.exitCode, set.stderr).toBe(0)
    expect(set.stdout).toMatch(/may now reach the \d+ default hosts, plus api\.example\.com, \*\.example\.org\. Applies to workspaces created from now on\./)
    expect(set.stderr).not.toContain('Warning')

    const noDefaults = await config('egress-allowlist', 'demo-settings', '--defaults', 'off')
    expect(noDefaults.stdout).toContain('may now reach only api.example.com, *.example.org.')
    expect(noDefaults.stderr).toContain('leaves out Anthropic API (api.anthropic.com)')
    expect(noDefaults.stderr).toContain('leaves out GitHub (github.com)')
    expect((await config('egress-allowlist', 'demo-settings', '--none')).stdout).toContain('nothing; all egress is blocked')
    expect((await config('egress-allowlist', 'demo-settings', 'a.com', '--none')).stderr).toContain('hosts or --none, not both')
    expect((await config('egress-allowlist', 'demo-settings', '--defaults', 'maybe')).stderr).toContain('Allowed choices are on, off')
    expect((await config('egress-allowlist', 'demo-settings', '--defaults', 'on')).stdout).toMatch(/may now reach the \d+ default hosts\./)
  })

  it('config kept-ignored-paths shows, replaces, refuses a path outside the checkout, and clears', async () => {
    expect((await config('kept-ignored-paths', 'demo-settings')).stdout).toContain('Ignored paths demo-settings keeps at stop: none')
    const set = await config('kept-ignored-paths', 'demo-settings', '.env', 'data/dev.db')
    expect(set.exitCode, set.stderr).toBe(0)
    expect(set.stdout).toContain('are now: .env, data/dev.db. Applies from each workspace\'s next stop.')
    expect((await config('kept-ignored-paths', 'demo-settings')).stdout).toContain('keeps at stop: .env, data/dev.db')
    expect((await config('kept-ignored-paths', 'demo-settings', '../outside')).exitCode).not.toBe(0)
    expect((await config('kept-ignored-paths', 'demo-settings', '.env', '--none')).stderr).toContain('paths or --none, not both')
    expect((await config('kept-ignored-paths', 'demo-settings', '--none')).stdout).toContain('are now: none.')
  })

  it('config git-credential shows and assigns a credential by name, and refuses one for a hosted project', async () => {
    expect((await config('git-credential', 'demo-settings')).stdout).toContain('demo-settings has no git credential')
    const set = await config('git-credential', 'demo-settings', 'fake-github')
    expect(set.exitCode, set.stderr).toBe(0)
    expect(set.stdout).toContain('demo-settings now uses the git credential fake-github')
    expect((await config('git-credential', 'demo-settings')).stdout).toContain('demo-settings uses the git credential fake-github.')
    expect((await config('git-credential', 'demo-settings', 'nope')).stderr).toContain('No git credential named "nope"')
    expect((await config('git-credential', 'hosted-demo')).stdout).toContain('hosted-demo is hosted by yaac, so it needs no git credential.')
    expect((await config('git-credential', 'hosted-demo', 'fake-github')).stderr).toContain('is hosted by yaac, so it needs no git credential')
  })

  it('config default-branch and default-branch-guard show and set a hosted project\'s, and refuse other projects', async () => {
    expect((await runYaac(testEnv.env, 'project', 'create', 'Branchy')).exitCode).toBe(0)
    const dir = path.join(testEnv.scratchDir, 'branchy')
    expect((await runYaac(testEnv.env, 'project', 'clone', 'branchy', dir)).exitCode).toBe(0)
    await git(dir, ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'first'])
    await git(dir, ['push', '-q', 'origin', 'HEAD:main', 'HEAD:release'])

    expect((await config('default-branch', 'branchy')).stdout).toContain('branchy\'s default branch is main.')
    const set = await config('default-branch', 'branchy', 'release')
    expect(set.exitCode, set.stderr).toBe(0)
    expect(set.stdout).toContain('branchy\'s default branch is now release.')
    expect((await config('default-branch', 'branchy')).stdout).toContain('branchy\'s default branch is release.')
    expect((await config('default-branch', 'branchy', 'nope')).stderr).toContain('"branchy" has no branch "nope"')
    expect((await config('default-branch', 'demo-settings')).stdout).toMatch(/demo-settings's default branch is \S+, set at its git host\./)
    expect((await config('default-branch', 'demo-settings', 'main')).stderr).toContain('is not hosted by yaac; set its default branch at its git host')

    expect((await config('default-branch-guard', 'branchy')).stdout).toContain('branchy refuses pushes that delete its default branch')
    expect((await config('default-branch-guard', 'branchy', 'off')).stdout).toContain('branchy now accepts pushes')
    expect((await config('default-branch-guard', 'branchy')).stdout).toContain('branchy accepts pushes')
    expect((await config('default-branch-guard', 'branchy', 'on')).stdout).toContain('branchy now refuses pushes')
    expect((await config('default-branch-guard', 'branchy', 'maybe')).stderr).toContain('Allowed choices are on, off')
    expect((await config('default-branch-guard', 'demo-settings')).stdout).toContain('is not hosted by yaac; its git host protects its branches')
    expect((await config('default-branch-guard', 'demo-settings', 'on')).stderr).toContain('is not hosted by yaac; set its default-branch guard at its git host')
  })

  it('config time-zone shows, pins a zone, refuses a bad one, and follows the device again', async () => {
    expect((await config('time-zone')).stdout).toMatch(/^Time zone: /)
    const pinned = await config('time-zone', 'Europe/Berlin')
    expect(pinned.exitCode, pinned.stderr).toBe(0)
    expect(pinned.stdout).toContain('Time zone is now Europe/Berlin. Workspaces started from now on launch in it.')
    expect((await config('time-zone')).stdout).toContain('Time zone: Europe/Berlin\n')
    expect((await config('time-zone', 'Mars/Olympus')).stderr).toContain('not an IANA time zone')
    expect((await config('time-zone', 'UTC', '--follow-device')).stderr).toContain('a zone or --follow-device, not both')
    const follow = await config('time-zone', '--follow-device')
    expect(follow.stdout).toContain(', following your devices.')
    expect((await config('time-zone')).stdout).toContain(', following your devices')
  })
})
