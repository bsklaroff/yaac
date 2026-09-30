import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createYaacTestEnv, spawnYaacServer, runYaac, type YaacTestEnv, type SpawnedServer } from '@yaac/test-utils/cli'
import { createTestRepo, addTestProject } from '@yaac/test-utils/setup'
import { makeServerApiClient } from '@yaac/test-utils/api'

/**
 * e2e coverage for `yaac project` (list/add) and `yaac config`, sharing one
 * test env and server across the file.
 *
 * Tests run in declaration order over one data dir, so order matters:
 *  - The empty-state `project list` test runs first.
 *  - The `project add` validation tests leave no project behind (rejects
 *    happen before any write; a failed clone rolls back). They use the
 *    `fake-github` credential beforeAll seeds.
 *  - The CONFLICT tests create bare project dirs (`repo`, `myrepo`) that
 *    persist, so the seeded `project list` test runs before them.
 *  - Seeded slugs are unique across the file (repo-alpha/repo-beta, demo-*).
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

  // Must precede the CONFLICT tests (see the file header).
  it('project list shows each seeded project with slug, remote, and session count', async () => {
    const repoAlpha = path.join(testEnv.scratchDir, 'repo-alpha')
    const repoBeta = path.join(testEnv.scratchDir, 'repo-beta')
    await createTestRepo(repoAlpha)
    await createTestRepo(repoBeta)
    await addTestProject(server, repoAlpha)
    await addTestProject(server, repoBeta)

    const { stdout, exitCode } = await runYaac(testEnv.env, 'project', 'list')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('PROJECT')
    expect(stdout).toContain('WORKSPACES')
    expect(stdout).toContain('repo-alpha')
    expect(stdout).toContain('repo-beta')
    expect(stdout).toContain('https://github.com/test-org/repo-alpha.git')
    expect(stdout).toContain('https://github.com/test-org/repo-beta.git')
    // No workspaces started, so 0 sessions each.
    expect(stdout).toMatch(/repo-alpha\s+\S.*\s+0/)
    expect(stdout).toMatch(/repo-beta\s+\S.*\s+0/)
  })

  it('project add returns CONFLICT when a project with the same slug exists', async () => {
    // An existing project dir makes the server answer CONFLICT before
    // resolving credentials.
    await fs.mkdir(path.join(testEnv.dataDir, 'global', 'projects', 'repo'), { recursive: true })

    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'project', 'add', 'https://github.com/org/repo', 'fake-github',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain('already exists')
  })

  it('project add lowercases the slug regardless of the URL case', async () => {
    // The slug is used as a pod label value (projectSlugFor), so it is
    // lowercased. The CONFLICT message shows the derived slug before any
    // clone happens.
    await fs.mkdir(path.join(testEnv.dataDir, 'global', 'projects', 'myrepo'), { recursive: true })

    const github = await runYaac(
      testEnv.env, 'project', 'add', 'https://github.com/Acme/MyRepo', 'fake-github',
    )
    expect(github.exitCode).not.toBe(0)
    expect(github.stderr).toContain('"myrepo"')
    expect(github.stderr).toContain('already exists')

    const gitlab = await runYaac(
      testEnv.env, 'project', 'add', 'https://gitlab.com/Acme/MyRepo', 'fake-github',
    )
    expect(gitlab.exitCode).not.toBe(0)
    expect(gitlab.stderr).toContain('"myrepo"')
    expect(gitlab.stderr).toContain('already exists')
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

  // Each test uses a unique `demo-*` slug, since the data dir is shared.
  async function seedProject(slug: string): Promise<void> {
    const repo = path.join(testEnv.scratchDir, slug)
    await createTestRepo(repo)
    await addTestProject(server, repo)
  }

  it('config edit round-trips yaac-config.json through the server (validated)', async () => {
    await seedProject('demo-edit')

    const editor = await writeStubEditor('config', '{ "initCommands": ["echo MARKER"] }')
    const { exitCode, stderr } = await runYaac(
      { ...testEnv.env, EDITOR: editor },
      'config', 'edit', 'demo-edit',
    )
    expect(exitCode, stderr).toBe(0)

    const target = path.join(testEnv.dataDir, 'global', 'projects', 'demo-edit', 'config', 'yaac-config.json')
    const saved = JSON.parse(await fs.readFile(target, 'utf8')) as { initCommands?: string[] }
    expect(saved.initCommands).toEqual(['echo MARKER'])
  })

  it('config edit rejects invalid JSON, keeps the edits, and leaves the server file alone', async () => {
    await seedProject('demo-badjson')

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

    const target = path.join(testEnv.dataDir, 'global', 'projects', 'demo-badjson', 'config', 'yaac-config.json')
    await expect(fs.access(target)).rejects.toThrow()
  })

  it('config edit-dockerfile writes Dockerfile.yaac verbatim via the server', async () => {
    await seedProject('demo-dockerfile')

    const editor = await writeStubEditor('dockerfile', 'RUN echo dockerfile-marker\n')
    const { exitCode, stderr } = await runYaac(
      { ...testEnv.env, EDITOR: editor },
      'config', 'edit-dockerfile', 'demo-dockerfile',
    )
    expect(exitCode, stderr).toBe(0)

    const target = path.join(
      testEnv.dataDir, 'global', 'projects', 'demo-dockerfile', 'config', 'build', 'Dockerfile.yaac',
    )
    expect(await fs.readFile(target, 'utf8')).toBe('RUN echo dockerfile-marker\n')
  })

  it('config edit-user-dockerfile saves a layered Dockerfile.user via the server', async () => {
    const layered = 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN echo user-marker\n'
    const editor = await writeStubEditor('user-dockerfile', layered)
    const { exitCode, stderr } = await runYaac(
      { ...testEnv.env, EDITOR: editor },
      'config', 'edit-user-dockerfile',
    )
    expect(exitCode, stderr).toBe(0)

    const target = path.join(testEnv.dataDir, 'server-local', 'build', 'Dockerfile.user')
    expect(await fs.readFile(target, 'utf8')).toBe(layered)
  })

  it('config edit opens the editor even when yaac-config.json is malformed', async () => {
    await seedProject('demo-malformed')

    // Broken content reaches the editor verbatim so it can be repaired.
    const target = path.join(testEnv.dataDir, 'global', 'projects', 'demo-malformed', 'config', 'yaac-config.json')
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, '{ this is not valid json')

    const editor = await writeStubEditor('repair', '{ "initCommands": ["echo REPAIRED"] }')
    const { exitCode, stderr } = await runYaac(
      { ...testEnv.env, EDITOR: editor },
      'config', 'edit', 'demo-malformed',
    )
    expect(exitCode, stderr).toBe(0)
    const saved = JSON.parse(await fs.readFile(target, 'utf8')) as { initCommands?: string[] }
    expect(saved.initCommands).toEqual(['echo REPAIRED'])
  })

  it('accepts the nestedContainers key through the config-write route', async () => {
    // The config-write route uses the same parser as workspace create.
    await seedProject('demo-nested')

    const client = makeServerApiClient(server)

    const nested = await client.project[':slug'].config.$put({
      param: { slug: 'demo-nested' },
      json: { config: { nestedContainers: true } },
    })
    expect(nested.status).toBe(200)
  })

  it('config edit fails with a clear error for an unknown project slug', async () => {
    const editor = await writeStubEditor('should-not-run', 'unused')
    const { exitCode, stderr } = await runYaac(
      { ...testEnv.env, EDITOR: editor },
      'config', 'edit', 'no-such-project',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/no-such-project|not found/i)
  })
})
