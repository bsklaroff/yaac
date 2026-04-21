import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
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
 * End-to-end coverage of the portForward field in yaac-config.json. One
 * session is created through the real CLI + daemon + podman path (same
 * harness as `session-create-happy.test.ts`); each `it()` then exec's a
 * fresh HTTP server inside that shared container on its own container
 * port and drives traffic through the host-side forwarder.
 *
 * The low-level `startPortForwarders` / `reserveAvailablePort` /
 * `podmanRelay` behavior is already unit-tested in test/unit/port*.ts;
 * this file is about proving that a project's yaac-config.json flows
 * through session-create → daemon → forwarder registry, and that the
 * podman-exec relay works against a real yaac session container.
 */

function httpGet(url: string, timeoutMs = 5000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('request timed out'))
    })
  })
}

describe('yaac session create honors portForward in yaac-config.json', () => {
  const networkName = `yaac-test-sessions-${TEST_RUN_ID}`

  // Container-port → host-port map, populated from the daemon's
  // "Forwarding host port ... -> container port ..." progress messages.
  const hostPortFor = new Map<number, number>()

  let testEnv: YaacTestEnv
  let daemon: SpawnedDaemon | null = null
  let mockLLM: MockLLM | null = null
  let mockGit: MockGit | null = null
  let containerName = ''

  beforeAll(async () => {
    await requirePodman()
    try {
      await podmanRetry(['network', 'create', networkName])
    } catch { /* already exists */ }

    testEnv = await createYaacTestEnv()
    mockLLM = await startMockLLM(networkName)
    mockGit = await startMockGit(networkName)

    // Commit the portForward entries into the bare repo so
    // `resolveProjectConfig` picks them up from origin/main. 20000+ host
    // port range avoids collisions with the 19xxx ports used by
    // test/unit/port*.ts that may run concurrently in other workers.
    const portForward = [
      { containerPort: 8080, hostPortStart: 20000 },
      { containerPort: 8081, hostPortStart: 20010 },
      { containerPort: 8082, hostPortStart: 20020 },
      { containerPort: 8083, hostPortStart: 20030 },
      { containerPort: 8084, hostPortStart: 20040 },
    ]
    await seedMockGitRepo(mockGit, 'repo-demo', {
      files: {
        'README.md': '# demo\n',
        'yaac-config.json': JSON.stringify({ portForward }, null, 2) + '\n',
      },
    })

    // Stage the project exactly as `yaac project add` would leave it.
    const projectsDir = path.join(testEnv.dataDir, 'projects')
    const projectDir = path.join(projectsDir, 'repo-demo')
    const repoDir = path.join(projectDir, 'repo')
    const claudeDir = path.join(projectDir, 'claude')
    await fs.mkdir(claudeDir, { recursive: true })
    const localBare = path.join(mockGit.reposDir, 'repo-demo.git')
    await cloneRepo(localBare, repoDir)
    const fakeRemote = 'https://github.com/test-org/repo-demo.git'
    await simpleGit(repoDir).remote(['set-url', 'origin', fakeRemote])
    await fs.writeFile(
      path.join(projectDir, 'project.json'),
      JSON.stringify({
        slug: 'repo-demo',
        remoteUrl: fakeRemote,
        addedAt: new Date().toISOString(),
      }) + '\n',
    )

    const credsDir = path.join(testEnv.dataDir, '.credentials')
    await fs.mkdir(credsDir, { recursive: true, mode: 0o700 })
    await fs.writeFile(
      path.join(credsDir, 'github.json'),
      JSON.stringify({
        tokens: [{ pattern: 'test-org/*', token: 'fake-ghp-token' }],
      }) + '\n',
    )
    await fs.writeFile(
      path.join(credsDir, 'claude.json'),
      JSON.stringify({
        kind: 'api-key',
        savedAt: new Date().toISOString(),
        apiKey: 'sk-ant-fake-real-key',
      }) + '\n',
    )
    await fs.writeFile(
      testEnv.gitConfigPath,
      '[user]\n\tname = Test User\n\temail = test@example.com\n',
    )

    const llmTarget = { host: mockLLM.networkIp, port: mockLLM.port, tls: false }
    const gitTarget = { host: mockGit.networkIp, port: mockGit.port, tls: false }
    const redirects = {
      'github.com': gitTarget,
      'api.github.com': gitTarget,
      'api.anthropic.com': llmTarget,
    }
    const daemonEnv: NodeJS.ProcessEnv = {
      ...testEnv.env,
      YAAC_E2E_UPSTREAM_REDIRECTS: JSON.stringify(redirects),
      YAAC_E2E_SKIP_FETCH: '1',
      YAAC_E2E_NO_ATTACH: '1',
    }
    daemon = await spawnYaacDaemon(daemonEnv)

    const { stdout, stderr, exitCode } = await runYaac(
      daemonEnv,
      'session', 'create', 'repo-demo', '--tool', 'claude',
    )
    if (exitCode !== 0) {
      console.error('session create stdout:\n' + stdout)
      console.error('session create stderr:\n' + stderr)
    }
    expect(exitCode).toBe(0)

    // Parse the daemon's progress stream for the resolved host ports.
    // Each portForward entry produces one such line — this both tells us
    // which host port to dial and proves the daemon read our config.
    for (const line of stdout.split('\n')) {
      const m = line.match(/Forwarding host port (\d+) -> container port (\d+)/)
      if (m) hostPortFor.set(Number(m[2]), Number(m[1]))
    }
    expect(hostPortFor.size).toBe(portForward.length)

    // Locate the session container — label scope keeps us from tripping
    // over leaks from other workers/runs.
    const { stdout: rows } = await podmanRetry([
      'ps', '--filter', `label=yaac.data-dir=${testEnv.dataDir}`,
      '--filter', 'label=yaac.project=repo-demo',
      '--format', '{{.Names}}|{{.CreatedAt}}',
    ])
    containerName = rows
      .split('\n').filter(Boolean)
      .sort((a, b) => a.split('|')[1].localeCompare(b.split('|')[1]))
      .map((row) => row.split('|')[0])[0]
    expect(containerName).toMatch(/^yaac-repo-demo-/)
  }, 120_000)

  afterAll(async () => {
    if (daemon) await daemon.stop()
    try {
      const { stdout } = await podmanRetry([
        'ps', '-a', '--filter', `label=yaac.data-dir=${testEnv.dataDir}`,
        '--format', '{{.Names}}',
      ])
      const names = stdout.split('\n').filter(Boolean)
      if (names.length > 0) await podmanRetry(['rm', '-f', ...names])
    } catch { /* best effort */ }
    await cleanupMocks([mockLLM, mockGit])
    await testEnv.cleanup()
  })

  /**
   * Spawn an HTTP server inside the shared session container via
   * `podman exec -d` and wait (in-container) for it to start accepting.
   * Each call should use a unique `containerPort` so concurrent tests
   * don't fight over the same listen socket.
   */
  async function startHttpServerInContainer(
    containerPort: number,
    bindAddress: '127.0.0.1' | '::1',
    responseText: string,
  ): Promise<void> {
    const script = `
      const http = require('http');
      http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(${JSON.stringify(responseText)});
      }).listen(${containerPort}, '${bindAddress}');
    `
    await podmanRetry(['exec', '-d', containerName, 'node', '-e', script])

    const curlHost = bindAddress === '::1' ? '[::1]' : bindAddress
    for (let i = 0; i < 40; i++) {
      try {
        const { stdout } = await podmanRetry([
          'exec', containerName, 'sh', '-c',
          `curl -sf http://${curlHost}:${containerPort}/`,
        ], { timeout: 3000 })
        if (stdout === responseText) return
      } catch {
        await new Promise((r) => setTimeout(r, 250))
      }
    }
    throw new Error(`HTTP server on ${bindAddress}:${containerPort} never became ready`)
  }

  it('forwards HTTP from host to an IPv4-loopback container server', async () => {
    await startHttpServerInContainer(8080, '127.0.0.1', 'hello ipv4')
    const hostPort = hostPortFor.get(8080)!
    const res = await httpGet(`http://127.0.0.1:${hostPort}/`)
    expect(res.status).toBe(200)
    expect(res.body).toBe('hello ipv4')
  }, 30_000)

  it('forwards HTTP from host to an IPv6-only container server', async () => {
    await startHttpServerInContainer(8081, '::1', 'hello ipv6')
    const hostPort = hostPortFor.get(8081)!
    const res = await httpGet(`http://127.0.0.1:${hostPort}/`)
    expect(res.status).toBe(200)
    expect(res.body).toBe('hello ipv6')
  }, 30_000)

  it('forwards multiple portForward entries to the same container independently', async () => {
    await startHttpServerInContainer(8082, '127.0.0.1', 'first server')
    await startHttpServerInContainer(8083, '127.0.0.1', 'second server')

    const [r1, r2] = await Promise.all([
      httpGet(`http://127.0.0.1:${hostPortFor.get(8082)}/`),
      httpGet(`http://127.0.0.1:${hostPortFor.get(8083)}/`),
    ])
    expect(r1.status).toBe(200)
    expect(r1.body).toBe('first server')
    expect(r2.status).toBe(200)
    expect(r2.body).toBe('second server')
  }, 30_000)

  it('relay accepts sequential requests while the event loop stays responsive', async () => {
    // Regression: startPortForwarders needs the Node event loop to
    // accept TCP connections. A wedged event loop would let the first
    // request through and silently drop the rest.
    await startHttpServerInContainer(8084, '127.0.0.1', 'sequential')
    const hostPort = hostPortFor.get(8084)!
    for (let i = 0; i < 3; i++) {
      const res = await httpGet(`http://127.0.0.1:${hostPort}/`)
      expect(res.status).toBe(200)
      expect(res.body).toBe('sequential')
    }
  }, 30_000)
})
