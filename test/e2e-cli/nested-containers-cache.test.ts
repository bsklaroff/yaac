import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import simpleGit from 'simple-git'
import { cloneRepo } from '@/lib/git'
import {
  createYaacTestEnv,
  spawnYaacDaemon,
  runYaac,
  type YaacTestEnv,
  type SpawnedDaemon,
} from '@test/helpers/cli'
import { requirePodman, TEST_RUN_ID, podmanRetry } from '@test/helpers/setup'
import {
  startMockLLM,
  startMockGit,
  seedMockGitRepo,
  cleanupMocks,
  type MockLLM,
  type MockGit,
} from '@test/helpers/mock-remotes'

/**
 * End-to-end verification of the per-session-graphroot + shared-image-cache
 * architecture (nestedContainers: true):
 *
 *   1. Create session 1, wait for its in-container podman to come up.
 *   2. Build a tiny image (FROM scratch) inside session 1 — lands in its
 *      per-session graphroot volume.
 *   3. Delete session 1 via the CLI. The detached cleanup script should run
 *      the promoter (graphroot → shared image cache) and then drop the
 *      per-session volume.
 *   4. Create session 2 in the same project.
 *   5. Rebuild the same Dockerfile in session 2. The image ID should match
 *      session 1's exactly — podman resolves the layers out of the shared
 *      store via `additionalimagestores` in /home/yaac/.config/containers/
 *      storage.conf, so the "build" is a pure cache hit.
 *   6. Delete session 2 + remove the project. The shared image cache volume
 *      should be gone afterwards, same as the per-session graphroot.
 *
 * This test is gated on whether doubly-nested rootless podman works in the
 * current environment (host → yaac session → inner podman). Containerized
 * CI hosts often can't grant the session's rootless podman the capabilities
 * newuidmap needs; when that happens we skip rather than false-fail.
 */
describe('yaac nested containers: cross-session image cache', () => {
  const networkName = `yaac-test-sessions-${TEST_RUN_ID}`
  let testEnv: YaacTestEnv
  let daemon: SpawnedDaemon | null = null
  let mockLLM: MockLLM | null = null
  let mockGit: MockGit | null = null
  let daemonEnv: NodeJS.ProcessEnv

  beforeAll(async () => {
    await requirePodman()
    try { await podmanRetry(['network', 'create', networkName]) } catch { /* exists */ }
  })

  async function seedCredentials(): Promise<void> {
    const credsDir = path.join(testEnv.dataDir, '.credentials')
    await fs.mkdir(credsDir, { recursive: true, mode: 0o700 })
    await fs.writeFile(path.join(credsDir, 'github.json'), JSON.stringify({
      tokens: [{ pattern: 'test-org/*', token: 'fake-ghp-token' }],
    }) + '\n')
    await fs.writeFile(path.join(credsDir, 'claude.json'), JSON.stringify({
      kind: 'api-key',
      savedAt: new Date().toISOString(),
      apiKey: 'sk-ant-fake-key',
    }) + '\n')
  }

  async function setupProject(slug: string): Promise<void> {
    await seedMockGitRepo(mockGit!, slug, {
      files: {
        'README.md': '# demo\n',
        'yaac-config.json': JSON.stringify({ nestedContainers: true }, null, 2) + '\n',
      },
    })
    const projectPath = path.join(testEnv.dataDir, 'projects', slug)
    const repoPath = path.join(projectPath, 'repo')
    await fs.mkdir(path.join(projectPath, 'claude'), { recursive: true })
    await cloneRepo(path.join(mockGit!.reposDir, `${slug}.git`), repoPath)
    const fakeRemote = `https://github.com/test-org/${slug}.git`
    await simpleGit(repoPath).remote(['set-url', 'origin', fakeRemote])
    await fs.writeFile(path.join(projectPath, 'project.json'), JSON.stringify({
      slug, remoteUrl: fakeRemote, addedAt: new Date().toISOString(),
    }) + '\n')
  }

  async function listProjectSessions(
    slug: string,
  ): Promise<Array<{ name: string; sessionId: string }>> {
    const { stdout } = await podmanRetry([
      'ps', '--filter', `label=yaac.data-dir=${testEnv.dataDir}`,
      '--filter', `label=yaac.project=${slug}`,
      '--format', '{{.Names}}|{{.CreatedAt}}',
    ])
    const rows = stdout.split('\n').filter(Boolean)
    // Container name format is `yaac-${slug}-${sessionId}` — sessionId is a
    // UUID that always contains the 4 dashes we carve around. Pull it off
    // the end, sort ascending by CreatedAt so "oldest" returns the
    // CLI-initiated session ahead of any prewarm the background loop has
    // had time to spin up.
    const prefix = `yaac-${slug}-`
    const sorted = rows.sort((a, b) => a.split('|')[1].localeCompare(b.split('|')[1]))
    const out: Array<{ name: string; sessionId: string }> = []
    for (const row of sorted) {
      const [name] = row.split('|', 1)
      if (!name.startsWith(prefix)) continue
      const sessionId = name.slice(prefix.length)
      out.push({ name, sessionId })
    }
    return out
  }

  async function sessionForProject(
    slug: string,
    excludeSessionIds: Set<string>,
  ): Promise<{ name: string; sessionId: string }> {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const sessions = await listProjectSessions(slug)
      const fresh = sessions.find((s) => !excludeSessionIds.has(s.sessionId))
      if (fresh) return fresh
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error(`no fresh session for project ${slug}`)
  }

  async function waitForInnerPodman(containerName: string): Promise<boolean> {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      try {
        await podmanRetry(['exec', containerName, 'podman', 'info', '--format', '{{.Host.OS}}'])
        return true
      } catch {
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    return false
  }

  async function volumeExists(name: string): Promise<boolean> {
    try {
      await podmanRetry(['volume', 'inspect', name])
      return true
    } catch {
      return false
    }
  }

  async function waitForVolumeGone(name: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!(await volumeExists(name))) return
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error(`volume ${name} still exists after ${timeoutMs}ms`)
  }

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
    await seedCredentials()
    await fs.writeFile(
      testEnv.gitConfigPath,
      '[user]\n\tname = Test User\n\temail = test@example.com\n',
    )
    mockLLM = await startMockLLM(networkName)
    mockGit = await startMockGit(networkName)

    const llmTarget = { host: mockLLM.networkIp, port: mockLLM.port, tls: false }
    const gitTarget = { host: mockGit.networkIp, port: mockGit.port, tls: false }
    daemonEnv = {
      ...testEnv.env,
      YAAC_E2E_UPSTREAM_REDIRECTS: JSON.stringify({
        'github.com': gitTarget,
        'api.github.com': gitTarget,
        'api.anthropic.com': llmTarget,
      }),
      YAAC_E2E_SKIP_FETCH: '1',
      YAAC_E2E_NO_ATTACH: '1',
    }
    daemon = await spawnYaacDaemon(daemonEnv)
  })

  afterEach(async () => {
    if (daemon) await daemon.stop()
    daemon = null
    try {
      const { stdout } = await podmanRetry([
        'ps', '-a', '--filter', `label=yaac.data-dir=${testEnv.dataDir}`,
        '--format', '{{.Names}}',
      ])
      const names = stdout.split('\n').filter(Boolean)
      if (names.length > 0) await podmanRetry(['rm', '-f', ...names])
    } catch { /* ok */ }
    try {
      const { stdout } = await podmanRetry([
        'volume', 'ls', '--filter', `label=yaac.data-dir=${testEnv.dataDir}`,
        '--format', '{{.Name}}',
      ])
      const vols = stdout.split('\n').filter(Boolean)
      if (vols.length > 0) await podmanRetry(['volume', 'rm', '-f', ...vols])
    } catch { /* ok */ }
    await cleanupMocks([mockLLM, mockGit])
    mockLLM = null
    mockGit = null
    await testEnv.cleanup()
  })

  it('creates per-session graphroot + shared cache, reuses layers across sessions, cleans up fully', async () => {
    const slug = 'nested-cache'
    await setupProject(slug)

    // --- Session 1 ---
    const { exitCode: c1, stdout: o1, stderr: e1 } = await runYaac(
      daemonEnv, 'session', 'create', slug, '--tool', 'claude',
    )
    if (c1 !== 0) throw new Error(`session create 1 failed\nstdout:\n${o1}\nstderr:\n${e1}`)

    const session1 = await sessionForProject(slug, new Set())
    expect(session1.sessionId).toBeTruthy()

    // Architectural assertions — these hold whether or not the in-container
    // podman can actually run nested containers:
    //   - per-session graphroot volume exists and is labeled for orphan GC
    //   - project-shared image cache volume exists and is labeled
    //   - storage.conf inside the session points at the shared store
    const session1Volume = `yaac-podmanstorage-${session1.sessionId}`
    const sharedCacheVolume = `yaac-imagecache-${slug}`
    expect(await volumeExists(session1Volume)).toBe(true)
    expect(await volumeExists(sharedCacheVolume)).toBe(true)
    const { stdout: s1VolInspect } = await podmanRetry([
      'volume', 'inspect', session1Volume, '--format',
      '{{index .Labels "yaac.session-id"}}|{{index .Labels "yaac.project"}}',
    ])
    expect(s1VolInspect.trim()).toBe(`${session1.sessionId}|${slug}`)
    const { stdout: cacheVolInspect } = await podmanRetry([
      'volume', 'inspect', sharedCacheVolume, '--format',
      '{{index .Labels "yaac.imagecache"}}|{{index .Labels "yaac.project"}}',
    ])
    expect(cacheVolInspect.trim()).toBe(`true|${slug}`)
    const { stdout: storageConf } = await podmanRetry([
      'exec', session1.name, 'cat', '/home/yaac/.config/containers/storage.conf',
    ])
    expect(storageConf).toContain('/var/lib/shared-images')

    // End-to-end layer-cache assertions — only run in an environment where a
    // session's rootless podman can itself create containers. Containerized
    // CI hosts typically can't grant the session's podman the newuidmap caps
    // it needs, so we short-circuit rather than false-fail.
    let imageId: string | null = null
    if (await waitForInnerPodman(session1.name)) {
      await podmanRetry([
        'exec', session1.name, 'sh', '-c',
        'mkdir -p /tmp/b && cd /tmp/b && '
        + 'echo cache-payload > marker && '
        + 'printf "FROM scratch\\nCOPY marker /marker\\n" > Dockerfile && '
        + 'podman build -t yaac-cache-probe:v1 .',
      ], { timeout: 120_000 })
      const { stdout: s1ImageId } = await podmanRetry([
        'exec', session1.name, 'podman', 'image', 'ls', '-q', '--no-trunc',
        'yaac-cache-probe:v1',
      ])
      imageId = s1ImageId.trim()
      expect(imageId).toBeTruthy()
    } else {
      console.warn(
        'nested-cache test: in-container podman is not functional (common in '
        + 'containerized CI). Skipping layer-cache-hit assertions; volume-'
        + 'lifecycle assertions still run.',
      )
    }

    // --- Delete session 1 ---
    // Detached cleanup order: stop → rm container → promoter → rm per-session
    // graphroot → rm worktree. The volume goes after the promoter, so polling
    // for its absence proves the whole pipeline ran.
    await runYaac(daemonEnv, 'session', 'delete', session1.sessionId)
    await waitForVolumeGone(session1Volume, 180_000)

    // The shared cache is project-scoped — it must outlive any single session.
    expect(await volumeExists(sharedCacheVolume)).toBe(true)

    // --- Session 2 ---
    const { exitCode: c2, stdout: o2, stderr: e2 } = await runYaac(
      daemonEnv, 'session', 'create', slug, '--tool', 'claude',
    )
    if (c2 !== 0) throw new Error(`session create 2 failed\nstdout:\n${o2}\nstderr:\n${e2}`)

    const session2 = await sessionForProject(slug, new Set([session1.sessionId]))
    expect(session2.sessionId).not.toBe(session1.sessionId)
    const session2Volume = `yaac-podmanstorage-${session2.sessionId}`
    expect(await volumeExists(session2Volume)).toBe(true)

    // Rebuild the same Dockerfile in session 2; with the promoter having
    // moved session 1's layers into the shared cache, this should be a
    // pure cache hit and the image ID must match session 1's exactly.
    if (imageId && await waitForInnerPodman(session2.name)) {
      await podmanRetry([
        'exec', session2.name, 'sh', '-c',
        'mkdir -p /tmp/b && cd /tmp/b && '
        + 'echo cache-payload > marker && '
        + 'printf "FROM scratch\\nCOPY marker /marker\\n" > Dockerfile && '
        + 'podman build -t yaac-cache-probe:v2 .',
      ], { timeout: 120_000 })
      const { stdout: s2ImageId } = await podmanRetry([
        'exec', session2.name, 'podman', 'image', 'ls', '-q', '--no-trunc',
        'yaac-cache-probe:v2',
      ])
      expect(s2ImageId.trim()).toBe(imageId)
    }

    // --- Delete session 2 ---
    await runYaac(daemonEnv, 'session', 'delete', session2.sessionId)
    await waitForVolumeGone(session2Volume, 180_000)

    // --- Remove project (no CLI command — hit the daemon API directly) ---
    const delRes = await fetch(
      `http://127.0.0.1:${daemon!.lock.port}/project/${slug}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${daemon!.lock.secret}` },
      },
    )
    expect(delRes.status).toBe(204)

    // Shared cache volume must be gone after project removal. Podman's
    // volume reap happens after the last referencing container is
    // removed, and both of those operations slow substantially under
    // the parallel e2e + e2e-cli load.
    await waitForVolumeGone(sharedCacheVolume, 60_000)
  }, 600_000)
})
