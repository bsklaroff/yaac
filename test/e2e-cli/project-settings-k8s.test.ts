import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createYaacTestEnv, spawnYaacServer, runYaac, type RunYaacOptions, type YaacTestEnv } from '#support/cli'
import type { SpawnedServer } from '@yaac/test-utils/api'
import { createTestRepo } from '@yaac/test-utils/setup'
import { addTestProject } from '#support/cluster'
import { BUILT_IN_USER_ID } from '@yaac/server/db/user-store'
import { startMockGit } from '#support/mock-remotes'
import { describeRepoForks } from '#support/repo-fork-cases'

/**
 * The `yaac config`, `yaac project repo` and `yaac project move` behavior
 * only a cluster install has: what its pods, images, egress proxy and
 * sandbox are set up with. Everything else those commands do is the same
 * under either driver, and is covered once, against a host server
 * (test/e2e-containerless/project-cli.test.ts), which refuses each of these.
 *
 * One test env and server for the file. `demo-settings` takes the project
 * settings; `multi` links `lib`'s repo as `library`, with a credential, for
 * the repo flags. The repo-fork cases run here too, against a mock git
 * server in the cluster (test/support/repo-fork-cases.ts).
 */

let testEnv: YaacTestEnv
let server: SpawnedServer

const config = (...args: Array<string | RunYaacOptions>): ReturnType<typeof runYaac> => runYaac(testEnv.env, 'config', ...args)
const projectRepo = (...args: Array<string | RunYaacOptions>): ReturnType<typeof runYaac> => runYaac(testEnv.env, 'project', 'repo', ...args)

beforeAll(async () => {
  testEnv = await createYaacTestEnv()
  server = await spawnYaacServer(testEnv.env)
  expect((await runYaac(testEnv.env, 'auth', 'fake', 'github')).exitCode).toBe(0)
  const seed = async (name: string): Promise<string> => {
    const dir = path.join(testEnv.scratchDir, name)
    await createTestRepo(dir)
    return await addTestProject(server, dir)
  }
  await seed('demo-settings')
  await seed('multi')
  const libId = await seed('lib')
  for (const args of [
    ['project', 'repo', 'add', 'multi', '--repo-id', libId],
    ['project', 'repo', 'rename', 'multi', 'lib', 'library'],
    ['config', 'git-credential', 'multi', 'fake-github', '--repo', 'library'],
  ]) {
    const { exitCode, stderr } = await runYaac(testEnv.env, ...args)
    expect(exitCode, `${args.join(' ')}: ${stderr}`).toBe(0)
  }
})

afterAll(async () => {
  await server.stop()
  await testEnv.cleanup()
})

describe('yaac config: the settings of a cluster install (real CLI + real server)', () => {
  it('config egress-allowlist shows and replaces the hosts and defaults, warning when agents lose access', async () => {
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

  it('config cache-volumes and npm-cache show and set the pod settings', async () => {
    expect((await config('cache-volumes', 'demo-settings')).stdout).toContain('Cache volumes in demo-settings: none')
    const volumes = await config('cache-volumes', 'demo-settings', 'pip=/home/yaac/.cache/pip', 'cargo=/home/yaac/.cargo')
    expect(volumes.exitCode, volumes.stderr).toBe(0)
    expect(volumes.stdout).toContain('are now: pip at /home/yaac/.cache/pip, cargo at /home/yaac/.cargo.')
    expect((await config('cache-volumes', 'demo-settings', 'pip')).stderr).toContain('"pip" is not <name>=<absolute path>.')
    expect((await config('cache-volumes', 'demo-settings', '../up=/x')).stderr).toContain('name "../up" must be')
    expect((await config('cache-volumes', 'demo-settings', 'a=/x', '--none')).stderr).toContain('Pass volumes or --none, not both.')
    expect((await config('cache-volumes', 'demo-settings', '--none')).stdout).toContain('are now: none.')

    expect((await config('npm-cache', 'demo-settings')).stdout).toContain('npm cache in demo-settings: on')
    expect((await config('npm-cache', 'demo-settings', 'off')).stdout).toContain('npm cache in demo-settings is now off.')
    expect((await config('npm-cache', 'demo-settings', 'maybe')).stderr).toContain('Allowed choices are on, off')
    expect((await config('npm-cache', 'demo-settings', 'on')).exitCode).toBe(0)
  })

  it('config dockerfile and user-dockerfile print, replace from a file or stdin, and clear', async () => {
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
  it('config show prints them under the command that changes each', async () => {
    const { stdout, exitCode, stderr } = await config('show', 'demo-settings')
    expect(exitCode, stderr).toBe(0)
    expect(stdout).toMatch(/\n {2}egress-allowlist +the defaults\n/)
    expect(stdout).toMatch(/\n {2}npm-cache +on\n {2}dockerfile +none\n/)
  })
})

describe('yaac project repo and move: what the sandbox and the egress proxy enforce (real CLI + real server)', () => {
  it('project repo read-only and gh-token show and set what a project\'s workspaces may do with a repo', async () => {
    expect((await projectRepo('read-only', 'multi', 'library')).stdout).toContain('library of project "multi" can be pushed to by its workspaces.')
    expect((await projectRepo('gh-token', 'multi', 'library')).stdout).toContain('library of project "multi" lets its token be GH_TOKEN.')
    expect((await projectRepo('read-only', 'multi', 'library', 'maybe')).stderr).toContain('Allowed choices are on, off')
    expect((await projectRepo('gh-token', 'multi', 'nope', 'on')).stderr).toContain('Project "multi" has no repo "nope"')
    const readOnly = await projectRepo('read-only', 'multi', 'library', 'on')
    expect(readOnly.exitCode, readOnly.stderr).toBe(0)
    expect(readOnly.stdout).toContain('library of project "multi" now is read-only: its workspaces can fetch it but not push to it.')
    expect((await projectRepo('read-only', 'multi', 'library')).stdout).toContain('is read-only')
    // Its stored GH_TOKEN setting stands, but does not apply while read-only.
    expect((await projectRepo('gh-token', 'multi', 'library')).stdout)
      .toContain('While the repo is read-only its token is never GH_TOKEN, whatever this says.')
    expect((await projectRepo('list', 'multi')).stdout).toMatch(/library\s+\S+\s+fake-github\s+on\s+off\s+https:/)
    expect((await config('show', 'multi')).stdout).toMatch(/library \(https:[^)]*, read-only\)/)
    expect((await projectRepo('read-only', 'multi', 'library', 'off')).stdout).toContain('now can be pushed to by its workspaces.')

    const ghToken = await projectRepo('gh-token', 'multi', 'library', 'off')
    expect(ghToken.exitCode, ghToken.stderr).toBe(0)
    expect(ghToken.stdout).toContain('library of project "multi" now keeps its token from being GH_TOKEN.')
    expect((await projectRepo('list', 'multi')).stdout).toMatch(/library\s+\S+\s+fake-github\s+off\s+off\s+https:/)
    expect((await projectRepo('gh-token', 'multi', 'library', 'on')).stdout).toContain('now lets its token be GH_TOKEN.')
    // The other project linking the repo has flags of its own.
    expect((await projectRepo('read-only', 'lib', 'lib')).stdout).toContain('can be pushed to by its workspaces')
  })

  it('project move is refused by the egress allowlist before anything stops', async () => {
    const created = await runYaac(testEnv.env, 'project', 'create', 'Hosted Demo')
    expect(created.exitCode, created.stderr).toBe(0)
    const target = 'https://gitlab.example.com/foo/bar'
    const moved = await runYaac(testEnv.env, 'project', 'move', 'hosted-demo', target, 'fake-github',
      { tty: true, stdinOnPrompt: [{ when: /Continue\? \[y\/N\]/, send: 'y\r' }] })
    expect(moved.exitCode).not.toBe(0)
    expect(moved.stdout).toContain(`Moving hosted-demo to ${target}...`)
    expect(moved.stdout + moved.stderr).toMatch(/"gitlab.example.com" is not in the egress allowlist/)
    expect((await runYaac(testEnv.env, 'project', 'list')).stdout).toMatch(/hosted-demo\s+\S+\s+\d+\s+\(hosted by yaac\)/)
  })
})

describeRepoForks({ env: () => testEnv.env, port: () => server.lock.port, scratchDir: () => testEnv.scratchDir }, startMockGit)
