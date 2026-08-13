import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createYaacTestEnv, spawnYaacServer, runYaac, type YaacTestEnv, type SpawnedServer } from '@yaac/test-utils/cli'
import { createTestRepo, addTestProject } from '@yaac/test-utils/setup'
import { makeServerApiClient } from '@yaac/test-utils/api'

/**
 * Merged e2e coverage for `yaac project` (list/add) and `yaac config` — all
 * server-backed CLI commands. One test env + one real server are shared
 * across the whole file (spawning a server acquires
 * the cross-worker server mutex and is by far the slowest step, so per-test
 * servers made these suites pay that cost for every it()).
 *
 * The shared data dir makes test ORDER load-bearing — vitest runs a file's
 * tests sequentially in declaration order:
 *  - The empty-state `project list` test must run before anything seeds a
 *    project, so it is declared first.
 *  - The `project add` validation tests leave NO residue: URL-validation
 *    rejects throw before any state is written, and the interactive-cancel
 *    tests cancel at the auth menu — `addProject` throws AUTH_REQUIRED at
 *    credential resolution, BEFORE it mkdirs the project dir, and the
 *    cancelled auth menu writes nothing either.
 *  - The CONFLICT tests pre-create bare project dirs (`repo`, `myrepo`)
 *    that persist for the rest of the file, so the seeded `project list`
 *    test is declared before them to keep its expected output exact.
 *  - Every seeded project slug is unique file-wide (repo-alpha/repo-beta,
 *    demo-*) so no test trips over another's clone.
 */

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

describe('yaac project (real CLI + real server)', () => {
  // Must run first: any project seeded into the shared data dir would
  // break the empty-state assertion.
  it('project list prints the empty-state hint when no projects exist', async () => {
    const { stdout, exitCode } = await runYaac(testEnv.env, 'project', 'list')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('No projects found')
    expect(stdout).toContain('yaac project add')
  })

  it('project add accepts a non-GitHub HTTPS URL (no longer rejected on host)', async () => {
    // Without credentials the CLI drops into the interactive auth flow.
    // Cancel out of that flow with a single newline; we just need to assert
    // that URL validation did NOT reject the non-github host.
    const { stdout, stderr } = await runYaac(
      testEnv.env, 'project', 'add', 'https://gitlab.example.com/foo/bar',
      { stdin: '\n' },
    )
    const combined = stdout + stderr
    // The old "Only GitHub repositories are supported" error must be gone.
    expect(combined).not.toMatch(/only github/i)
    // The interactive auth-update menu must have been shown — proves the
    // URL reached the server (rather than being blocked by validation).
    expect(combined).toMatch(/What would you like to authenticate\?/)
  })

  it('project add accepts SCP-style SSH URLs', async () => {
    const { stdout, stderr } = await runYaac(
      testEnv.env, 'project', 'add', 'git@github.com:org/repo.git',
      { stdin: '\n' },
    )
    const combined = stdout + stderr
    expect(combined).not.toMatch(/SSH URLs are not supported/i)
    expect(combined).toMatch(/What would you like to authenticate\?/)
  })

  it('project add rejects plain HTTP URLs', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'project', 'add', 'http://github.com/org/repo',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/HTTPS/i)
  })

  it('project add rejects ssh:// URLs pointing at SCP-style instead', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'project', 'add', 'ssh://git@github.com/org/repo',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/SCP-style/)
  })

  it('project add rejects unparseable URLs', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'project', 'add', 'not-a-url',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/Unrecognized|Invalid|HTTPS/i)
  })

  // Declared before the CONFLICT tests below: those pre-create bare
  // project dirs that would otherwise show up as extra list rows.
  it('project list shows each seeded project with slug, remote, and session count', async () => {
    const repoAlpha = path.join(testEnv.scratchDir, 'repo-alpha')
    const repoBeta = path.join(testEnv.scratchDir, 'repo-beta')
    await createTestRepo(repoAlpha)
    await createTestRepo(repoBeta)
    await addTestProject(repoAlpha)
    await addTestProject(repoBeta)

    const { stdout, exitCode } = await runYaac(testEnv.env, 'project', 'list')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('PROJECT')
    expect(stdout).toContain('WORKTREES')
    expect(stdout).toContain('repo-alpha')
    expect(stdout).toContain('repo-beta')
    expect(stdout).toContain(repoAlpha)
    expect(stdout).toContain(repoBeta)
    // No containers were started, so both projects should show 0 sessions.
    expect(stdout).toMatch(/repo-alpha\s+\S.*\s+0/)
    expect(stdout).toMatch(/repo-beta\s+\S.*\s+0/)
  })

  it('project add returns CONFLICT when a project with the same slug exists', async () => {
    // Pre-create the project dir so the server's `fs.access` check throws
    // CONFLICT before it reaches token resolution.
    await fs.mkdir(path.join(testEnv.dataDir, 'projects', 'repo'), { recursive: true })

    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'project', 'add', 'https://github.com/org/repo',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain('already exists')
  })

  it('project add lowercases the slug regardless of the URL case', async () => {
    // The slug is baked into image tags (yaac-user-<slug>:<hash>), which
    // Docker/Podman require to be all-lowercase, so the slug is forced to
    // lowercase even when the source URL has caps. The CONFLICT check fires
    // after slug derivation but before clone / credential resolution, so we
    // can assert the slug shape via the conflict message.
    await fs.mkdir(path.join(testEnv.dataDir, 'projects', 'myrepo'), { recursive: true })

    const github = await runYaac(
      testEnv.env, 'project', 'add', 'https://github.com/Acme/MyRepo',
    )
    expect(github.exitCode).not.toBe(0)
    expect(github.stderr).toContain('"myrepo"')
    expect(github.stderr).toContain('already exists')

    const gitlab = await runYaac(
      testEnv.env, 'project', 'add', 'https://gitlab.com/Acme/MyRepo',
    )
    expect(gitlab.exitCode).not.toBe(0)
    expect(gitlab.stderr).toContain('"myrepo"')
    expect(gitlab.stderr).toContain('already exists')
  })
})

describe('yaac config (real CLI + real server)', () => {
  // Stand-in editor: a tiny shell script that writes deterministic
  // content into whichever scratch file the CLI hands it. The CLI edits
  // a tmp copy and PUTs the result to the server, so assertions read the
  // server-side file afterwards.
  async function writeStubEditor(name: string, content: string): Promise<string> {
    const editorPath = path.join(testEnv.scratchDir, `editor-${name}.sh`)
    const contentFile = path.join(testEnv.scratchDir, `editor-${name}.content`)
    await fs.writeFile(contentFile, content)
    await fs.writeFile(editorPath, `#!/bin/sh\ncat '${contentFile}' > "$1"\n`, { mode: 0o755 })
    return editorPath
  }

  // Each test seeds its own project under a unique `demo-*` slug: with a
  // shared data dir, reusing the original `demo` slug would collide on the
  // second addTestProject (clone into an existing repo dir).
  async function seedProject(slug: string): Promise<void> {
    const repo = path.join(testEnv.scratchDir, slug)
    await createTestRepo(repo)
    await addTestProject(repo)
  }

  it('config edit round-trips yaac-config.json through the server (validated)', async () => {
    await seedProject('demo-edit')

    const editor = await writeStubEditor('config', '{ "env": { "MARKER": "1" } }')
    const { exitCode, stderr } = await runYaac(
      { ...testEnv.env, EDITOR: editor },
      'config', 'edit', 'demo-edit',
    )
    expect(exitCode, stderr).toBe(0)

    const target = path.join(testEnv.dataDir, 'projects', 'demo-edit', 'config', 'yaac-config.json')
    const saved = JSON.parse(await fs.readFile(target, 'utf8')) as { env?: Record<string, string> }
    expect(saved.env).toEqual({ MARKER: '1' })
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

    const target = path.join(testEnv.dataDir, 'projects', 'demo-badjson', 'config', 'yaac-config.json')
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
      testEnv.dataDir, 'projects', 'demo-dockerfile', 'config', 'build', 'Dockerfile.yaac',
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

    const target = path.join(testEnv.dataDir, 'build', 'Dockerfile.user')
    expect(await fs.readFile(target, 'utf8')).toBe(layered)
  })

  it('config edit opens the editor even when yaac-config.json is malformed', async () => {
    await seedProject('demo-malformed')

    // The raw read hands broken content to the editor verbatim so it can
    // be repaired; the validated write then stores clean JSON.
    const target = path.join(testEnv.dataDir, 'projects', 'demo-malformed', 'config', 'yaac-config.json')
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, '{ this is not valid json')

    const editor = await writeStubEditor('repair', '{ "env": { "REPAIRED": "1" } }')
    const { exitCode, stderr } = await runYaac(
      { ...testEnv.env, EDITOR: editor },
      'config', 'edit', 'demo-malformed',
    )
    expect(exitCode, stderr).toBe(0)
    const saved = JSON.parse(await fs.readFile(target, 'utf8')) as { env?: Record<string, string> }
    expect(saved.env).toEqual({ REPAIRED: '1' })
  })

  it('accepts the nestedContainers key through the config-write route', async () => {
    // The server's config-write route runs the same parser session-create
    // hits at load time; `nestedContainers` must parse cleanly.
    await seedProject('demo-nested')

    const client = makeServerApiClient(server)

    const nested = await client.project[':slug'].config.$put({
      param: { slug: 'demo-nested' },
      json: { config: { nestedContainers: true } },
    })
    expect(nested.status).toBe(200)
  })

  it('accepts virtualCluster but rejects it alongside nestedContainers: false', async () => {
    await seedProject('demo-vcluster')

    const client = makeServerApiClient(server)

    const vcluster = await client.project[':slug'].config.$put({
      param: { slug: 'demo-vcluster' },
      json: { config: { virtualCluster: true } },
    })
    expect(vcluster.status).toBe(200)

    // virtualCluster implies nestedContainers — the explicit opt-out is a
    // contradiction the parser rejects.
    const conflict = await client.project[':slug'].config.$put({
      param: { slug: 'demo-vcluster' },
      json: { config: { virtualCluster: true, nestedContainers: false } },
    })
    expect(conflict.status).not.toBe(200)
    const body = await conflict.text()
    expect(body).toMatch(/virtualCluster requires nestedContainers/)
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
