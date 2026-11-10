import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createYaacTestEnv, spawnYaacServer, runYaac, type RunYaacOptions, type YaacTestEnv } from '#support/cli'
import type { SpawnedServer } from '@yaac/test-utils/api'
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

  it('project add accepts ssh:// and SCP-style SSH URLs, which need an SSH key credential', async () => {
    for (const url of ['git@github.com:org/repo.git', 'ssh://git@github.com/org/repo.git']) {
      const { stdout, stderr, exitCode } = await runYaac(testEnv.env, 'project', 'add', url, 'fake-github')
      expect(exitCode).not.toBe(0)
      expect(stdout + stderr).toMatch(/needs an SSH key, not a token/)
    }
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

  // Adding the same remote twice gives two projects with one name.
  it('config commands refuse an unknown project, and a name two projects share, listing both', async () => {
    const unknown = await runYaac(testEnv.env, 'config', 'show', 'no-such-project')
    expect(unknown.exitCode).not.toBe(0)
    expect(unknown.stderr).toContain('You have no project no-such-project')
    const first = await seedProject('demo-twin')
    const second = await seedProject('demo-twin', path.join(testEnv.scratchDir, 'twin'))
    for (const command of ['show', 'port-forwards']) {
      const { exitCode, stderr } = await runYaac(testEnv.env, 'config', command, 'demo-twin')
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

  it('config icon shows, replaces from an image file or stdin, saves, refuses a non-image, and removes a project\'s icon', async () => {
    const png = path.join(testEnv.scratchDir, 'icon.png')
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    await fs.writeFile(png, bytes)
    const svg = path.join(testEnv.scratchDir, 'icon.svg')
    await fs.writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>')

    expect((await config('icon', 'demo-settings')).stdout).toContain('demo-settings has no icon; its chip shows its initial.')
    const set = await config('icon', 'demo-settings', '--file', png)
    expect(set.exitCode, set.stderr).toBe(0)
    expect(set.stdout).toContain('Saved demo-settings\'s icon.')
    expect((await config('icon', 'demo-settings')).stdout).toContain('demo-settings has an icon.')
    const projectId = (await (await fetch(`http://127.0.0.1:${String(server.lock.port)}/api/project/list`)).json() as Array<{ id: string; name: string }>)
      .find((p) => p.name === 'demo-settings')!.id
    const served = async (): Promise<Buffer> =>
      Buffer.from(await (await fetch(`http://127.0.0.1:${String(server.lock.port)}/api/project/${projectId}/icon`)).arrayBuffer())
    expect(await served()).toEqual(bytes)
    const piped = Buffer.from([...bytes, 9])
    expect((await config('icon', 'demo-settings', '--file', '-', { stdin: piped })).exitCode).toBe(0)
    expect(await served()).toEqual(piped)
    const out = path.join(testEnv.scratchDir, 'icon-out.png')
    const saved = await config('icon', 'demo-settings', '--out', out)
    expect(saved.stdout).toContain(`Saved demo-settings's icon (image/png, ${piped.length} bytes) to ${out}.`)
    expect(await fs.readFile(out)).toEqual(piped)
    // The helper decodes stdout as UTF-8, so the PNG signature's 0x89 is lost.
    expect((await config('icon', 'demo-settings', '--out', '-')).stdout).toMatch(/^\uFFFDPNG\r\n/)

    expect((await config('icon', 'demo-settings', '--file', svg)).stderr).toContain('must be a PNG, JPEG, GIF or WebP image')
    expect((await config('icon', 'demo-settings', '--file', path.join(testEnv.scratchDir, 'nope.png'))).stderr).toContain('Cannot read')
    expect((await config('icon', 'demo-settings', '--file', png, '--none')).stderr).toContain('Pass only one of --out, --file and --none.')
    expect((await config('icon', 'demo-settings', '--none')).stdout).toContain('Removed demo-settings\'s icon')
    expect((await config('icon', 'demo-settings')).stdout).toContain('has no icon')
    expect((await config('icon', 'demo-settings', '--out', out)).stderr).toContain('demo-settings has no icon')
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

  it('config port-forwards shows, replaces with container[:host] ports, refuses a bad or reserved one, and clears', async () => {
    expect((await config('port-forwards', 'demo-settings')).stdout).toContain('Forwarded ports in demo-settings: none')
    const set = await config('port-forwards', 'demo-settings', '3000', '5173:8080')
    expect(set.exitCode, set.stderr).toBe(0)
    expect(set.stdout).toContain('Forwarded ports in demo-settings are now: 3000, 5173 (host 8080 up). Workspaces created from now on use this.')
    expect((await config('port-forwards', 'demo-settings')).stdout).toContain(': 3000, 5173 (host 8080 up)')
    expect((await config('port-forwards', 'demo-settings', 'web')).stderr).toContain('"web" is not a port or <container>:<host> pair.')
    expect((await config('port-forwards', 'demo-settings', '10300')).stderr).toContain('10300 is reserved for yaac\'s own in-workspace services')
    expect((await config('port-forwards', 'demo-settings', '3000', '--none')).stderr).toContain('Pass ports or --none, not both.')
    // The refused ones left the stored list alone.
    expect((await config('port-forwards', 'demo-settings')).stdout).toContain(': 3000, 5173 (host 8080 up)')
    expect((await config('port-forwards', 'demo-settings', '--none')).stdout).toContain('are now: none.')
  })

  it('config cache-volumes, nested-containers and npm-cache show and set the pod settings; k8s only', async () => {
    if (!buildsImages) {
      for (const [args, why] of [
        [['cache-volumes', 'demo-settings', 'pip=/p'], 'keeps no cache volumes'],
        [['nested-containers', 'demo-settings', 'on'], 'runs no container engine in a workspace'],
        [['npm-cache', 'demo-settings', 'off'], 'runs no npm cache'],
      ] as const) {
        const refused = await config(...args)
        expect(refused.exitCode, args[0]).not.toBe(0)
        expect(refused.stderr).toContain(`This server ${why}`)
      }
      return
    }
    expect((await config('cache-volumes', 'demo-settings')).stdout).toContain('Cache volumes in demo-settings: none')
    const volumes = await config('cache-volumes', 'demo-settings', 'pip=/home/yaac/.cache/pip', 'cargo=/home/yaac/.cargo')
    expect(volumes.exitCode, volumes.stderr).toBe(0)
    expect(volumes.stdout).toContain('are now: pip at /home/yaac/.cache/pip, cargo at /home/yaac/.cargo.')
    expect((await config('cache-volumes', 'demo-settings', 'pip')).stderr).toContain('"pip" is not <name>=<absolute path>.')
    expect((await config('cache-volumes', 'demo-settings', '../up=/x')).stderr).toContain('name "../up" must be')
    expect((await config('cache-volumes', 'demo-settings', 'a=/x', '--none')).stderr).toContain('Pass volumes or --none, not both.')
    expect((await config('cache-volumes', 'demo-settings', '--none')).stdout).toContain('are now: none.')

    expect((await config('nested-containers', 'demo-settings')).stdout).toContain('Nested containers in demo-settings: off')
    expect((await config('nested-containers', 'demo-settings', 'on')).stdout).toContain('Nested containers in demo-settings are now on.')
    expect((await config('nested-containers', 'demo-settings', 'maybe')).stderr).toContain('Allowed choices are on, off')
    expect((await config('npm-cache', 'demo-settings')).stdout).toContain('npm cache in demo-settings: on')
    expect((await config('npm-cache', 'demo-settings', 'off')).stdout).toContain('npm cache in demo-settings is now off.')
    expect((await config('nested-containers', 'demo-settings', 'off')).exitCode).toBe(0)
    expect((await config('npm-cache', 'demo-settings', 'on')).exitCode).toBe(0)
  })

  it('config dockerfile and user-dockerfile print, replace from a file or stdin, and clear; k8s only', async () => {
    if (!buildsImages) {
      const refused = await config('dockerfile', 'demo-settings')
      expect(refused.exitCode).not.toBe(0)
      expect(refused.stderr).toContain('This server builds no images')
      return
    }
    const file = path.join(testEnv.scratchDir, 'Dockerfile.yaac')
    await fs.writeFile(file, 'RUN echo dockerfile-marker\n')
    expect((await config('dockerfile', 'demo-settings')).stderr).toContain('demo-settings has no Dockerfile.yaac')
    const set = await config('dockerfile', 'demo-settings', '--file', file)
    expect(set.exitCode, set.stderr).toBe(0)
    expect(set.stdout).toContain('Saved demo-settings\'s Dockerfile.yaac')
    expect((await config('dockerfile', 'demo-settings')).stdout).toBe('RUN echo dockerfile-marker\n')
    expect((await config('dockerfile', 'demo-settings', '--file', '-', { stdin: 'RUN echo from-stdin\n' })).exitCode).toBe(0)
    expect((await config('dockerfile', 'demo-settings')).stdout).toBe('RUN echo from-stdin\n')
    expect((await config('dockerfile', 'demo-settings', '--file', file, '--none')).stderr).toContain('Pass --file or --none, not both.')
    expect((await config('dockerfile', 'demo-settings', '--none')).stdout).toContain('Cleared demo-settings\'s Dockerfile.yaac')
    expect((await config('dockerfile', 'demo-settings')).stdout).toBe('')

    const layered = 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo user-marker\n'
    expect((await config('user-dockerfile')).stderr).toContain('You have no Dockerfile.user.')
    const user = await config('user-dockerfile', '--file', '-', { stdin: layered })
    expect(user.exitCode, user.stderr).toBe(0)
    expect((await config('user-dockerfile')).stdout).toBe(layered)
    // The caller is local, so the file is the built-in user's.
    const target = path.join(testEnv.dataDir, 'server-local', 'users', BUILT_IN_USER_ID, 'build', 'Dockerfile.user')
    expect(await fs.readFile(target, 'utf8')).toBe(layered)
    expect((await config('user-dockerfile', '--file', file)).stderr).toMatch(/layered|BASE_IMAGE/)
    expect((await config('user-dockerfile', '--none')).stdout).toContain('Cleared your Dockerfile.user.')
  })

  // Last, so it sees what the cases above left set.
  it('config show prints every project setting under the command that changes it', async () => {
    expect((await config('port-forwards', 'demo-settings', '3000')).exitCode).toBe(0)
    const { stdout, exitCode, stderr } = await config('show', 'demo-settings')
    expect(exitCode, stderr).toBe(0)
    expect(stdout).toMatch(/^demo-settings \([0-9a-f]{8}\), /)
    expect(stdout).toMatch(/\n {2}git-credential +fake-github\n/)
    const env = /\n {2}env +(.*)\n/.exec(stdout)?.[1].split(', ')
    expect(env?.sort()).toEqual(['CLIENT_SECRET (secret)', 'EMPTY', 'FOO', 'KEY_HEADER (secret)'])
    expect(stdout).toMatch(/\n {2}port-forwards +3000\n/)
    expect(stdout).toMatch(/\n {2}scratch-dirs +node_modules \(16 GiB\), target \(16 GiB\)\n/)
    expect(stdout).toMatch(/\n {2}workspace-auto-delete +off\n/)
    expect(stdout).toContain('Change one with `yaac config <setting>`.')
    if (buildsImages) {
      expect(stdout).toMatch(/\n {2}egress-allowlist +the defaults\n/)
      expect(stdout).toMatch(/\n {2}nested-containers +off\n {2}npm-cache +on\n {2}dockerfile +none\n/)
    } else {
      expect(stdout).not.toContain('egress-allowlist')
      expect(stdout).not.toContain('cache-volumes')
    }
    expect((await config('show', 'branchy')).stdout).toMatch(/\n {2}git-credential +none needed \(hosted by yaac\)\n {2}default-branch-guard +on\n/)
  })
})
