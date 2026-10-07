import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createYaacTestEnv, spawnYaacServer, runYaac, type YaacTestEnv, type SpawnedServer } from '@yaac/test-utils/cli'
import { createTestRepo, addTestProject } from '@yaac/test-utils/setup'
import { makeServerApiClient } from '@yaac/test-utils/api'
import { BUILT_IN_USER_ID } from '@yaac/server/db/user-store'

/**
 * e2e coverage for `yaac project` (list/add) and `yaac config`, sharing one
 * test env and server across the file.
 *
 * Tests run in declaration order over one data dir, so order matters:
 *  - The empty-state `project list` test runs first.
 *  - The `project add` validation tests leave no project behind (rejects
 *    happen before any write; a failed clone rolls back). They use the
 *    `fake-github` credential beforeAll seeds.
 *  - Seeded project names are unique across the file (repo-alpha/repo-beta,
 *    demo-*) except where a case makes two projects share one on purpose.
 */

let testEnv: YaacTestEnv
let server: SpawnedServer

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

    const editor = await writeStubEditor('config', '{ "initCommands": ["echo MARKER"] }')
    const { exitCode, stderr } = await runYaac(
      { ...testEnv.env, EDITOR: editor },
      'config', 'edit', 'demo-edit',
    )
    expect(exitCode, stderr).toBe(0)

    const saved = JSON.parse(await fs.readFile(configFile(id, 'yaac-config.json'), 'utf8')) as { initCommands?: string[] }
    expect(saved.initCommands).toEqual(['echo MARKER'])
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

  it('config edit-dockerfile writes Dockerfile.yaac verbatim via the server, named by id prefix', async () => {
    const id = await seedProject('demo-dockerfile')

    const editor = await writeStubEditor('dockerfile', 'RUN echo dockerfile-marker\n')
    const { exitCode, stderr } = await runYaac(
      { ...testEnv.env, EDITOR: editor },
      'config', 'edit-dockerfile', id.slice(0, 8),
    )
    expect(exitCode, stderr).toBe(0)

    expect(await fs.readFile(configFile(id, 'build', 'Dockerfile.yaac'), 'utf8')).toBe('RUN echo dockerfile-marker\n')
  })

  it('config edit-user-dockerfile saves a layered Dockerfile.user via the server', async () => {
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

    const editor = await writeStubEditor('repair', '{ "initCommands": ["echo REPAIRED"] }')
    const { exitCode, stderr } = await runYaac(
      { ...testEnv.env, EDITOR: editor },
      'config', 'edit', id,
    )
    expect(exitCode, stderr).toBe(0)
    const saved = JSON.parse(await fs.readFile(target, 'utf8')) as { initCommands?: string[] }
    expect(saved.initCommands).toEqual(['echo REPAIRED'])
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
