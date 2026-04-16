import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createTempDataDir, cleanupTempDir, createTestRepo, requirePodman, TEST_IMAGE_PREFIX, TEST_PROXY_CONFIG, TEST_RUN_ID, addTestProject } from '@test/helpers/setup'
import { podman } from '@/lib/container/runtime'
import { ensureImage, packTar } from '@/lib/container/image-builder'
import { ProxyClient, buildRulesFromConfig } from '@/lib/container/proxy-client'
import { resolveAllowedHosts } from '@/lib/container/default-allowed-hosts'
import { PgRelayClient } from '@/lib/container/pg-relay'
import { findAvailablePort } from '@/lib/container/port'
import { addWorktree, getDefaultBranch } from '@/lib/git'
import { resolveProjectConfig } from '@/lib/project/config'
import { repoDir, claudeDir, worktreeDir, worktreesDir, getDataDir } from '@/lib/project/paths'

const execFileAsync = promisify(execFile)

async function podmanExecRetry(
  cmd: string,
  args: string[],
  opts?: { timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      return await execFileAsync(cmd, args, opts ?? {})
    } catch (err: unknown) {
      const stderr = (err as { stderr?: string })?.stderr ?? ''
      if (attempt < 8 && (stderr.includes('container state improper') || stderr.includes('no such container'))) {
        await new Promise((r) => setTimeout(r, Math.min(200 * 2 ** (attempt - 1), 3200)))
        continue
      }
      throw err
    }
  }
  throw new Error('podmanExecRetry: unexpected fall-through')
}

// Test-specific sidecar instances — initialized in createSessionNonInteractive
// with a dynamic port to avoid conflicts with other test suites.
let testProxyClient: ProxyClient | null = null

function getTestProxy(): ProxyClient {
  if (testProxyClient) return testProxyClient
  testProxyClient = new ProxyClient(TEST_PROXY_CONFIG)
  return testProxyClient
}

async function getImageEnv(imageName: string): Promise<string[]> {
  const info = await podman.getImage(imageName).inspect()
  return (info.Config?.Env as string[] | undefined) ?? []
}

async function createSessionNonInteractive(projectSlug: string, options?: { addDir?: string[]; addDirRw?: string[] }): Promise<{
  containerId: string
  containerName: string
  sessionId: string
  forwardedPorts: Array<{ containerPort: number; hostPort: number }>
}> {
  const imageName = await ensureImage(projectSlug, TEST_IMAGE_PREFIX, true)
  const sessionId = crypto.randomBytes(4).toString('hex')
  const repo = repoDir(projectSlug)
  const wtDir = worktreeDir(projectSlug, sessionId)

  await fs.mkdir(worktreesDir(projectSlug), { recursive: true })
  await getDefaultBranch(repo)
  await addWorktree(repo, wtDir, `yaac/${sessionId}`)

  const config = await resolveProjectConfig(projectSlug) ?? {}

  // Preserve image ENV (container-create replaces rather than merges)
  const env: string[] = [...(await getImageEnv(imageName))]

  if (config.envPassthrough) {
    for (const name of config.envPassthrough) {
      const val = process.env[name]
      if (val !== undefined) {
        env.push(`${name}=${val}`)
      }
    }
  }

  // Proxy is always on — start it and register GitHub token rules
  const proxy = getTestProxy()
  await proxy.ensureRunning()

  const additionalRules = config.envSecretProxy
    ? buildRulesFromConfig(config.envSecretProxy, process.env)
    : []
  const allowedHosts = resolveAllowedHosts(config)
  await proxy.updateProjectRules(projectSlug, additionalRules, allowedHosts)

  await proxy.registerSession(sessionId, projectSlug)
  env.push(...proxy.getProxyEnv(sessionId))

  if (config.envSecretProxy) {
    for (const name of Object.keys(config.envSecretProxy)) {
      if (process.env[name]) {
        env.push(`${name}=placeholder`)
      }
    }
  }

  const networkMode = proxy.network

  // PostgreSQL relay setup
  const pgConfig = config.pgRelay
  const pgEnabled = !!(pgConfig && pgConfig.enabled !== false)
  let pgRelayIp: string | null = null
  let testPgRelay: PgRelayClient | null = null

  if (pgEnabled) {
    testPgRelay = new PgRelayClient({
      containerName: `yaac-test-pg-relay-${TEST_RUN_ID}`,
      network: TEST_PROXY_CONFIG.network,
    })
    await testPgRelay.ensureRunning(pgConfig)
    pgRelayIp = testPgRelay.ip
  }

  // Port forwarding setup (test helper uses podman PortBindings directly,
  // not startPortForwarders, so findAvailablePort is fine here)
  const forwardedPorts: Array<{ containerPort: number; hostPort: number }> = []
  const portBindings: Record<string, Array<{ HostPort: string; HostIp: string }>> = {}
  const exposedPorts: Record<string, Record<string, never>> = {}
  if (config.portForward?.length) {
    for (const { containerPort, hostPortStart } of config.portForward) {
      const hostPort = await findAvailablePort(hostPortStart)
      forwardedPorts.push({ containerPort, hostPort })
      const portKey = `${containerPort}/tcp`
      exposedPorts[portKey] = {}
      portBindings[portKey] = [{ HostPort: String(hostPort), HostIp: '127.0.0.1' }]
    }
  }

  const containerName = `yaac-${projectSlug}-${sessionId}`
  const claude = claudeDir(projectSlug)

  const container = await podman.createContainer({
    Image: imageName,
    name: containerName,
    Labels: {
      'yaac.project': projectSlug,
      'yaac.session-id': sessionId,
      'yaac.data-dir': getDataDir(),
      'yaac.test': 'true',
    },
    ExposedPorts: exposedPorts,
    Env: env,
    HostConfig: {
      Binds: [
        `${wtDir}:/workspace:Z`,
        `${repo}/.git:/repo/.git:Z`,
        `${claude}:/home/yaac/.claude:Z`,
        ...Object.entries(config.cacheVolumes ?? {}).map(
          ([key, containerPath]) => `yaac-cache-${projectSlug}-${key}:${containerPath}:Z`,
        ),
        ...(config.bindMounts ?? []).map(
          ({ hostPath, containerPath, mode }) => `${hostPath}:${containerPath}:${mode},Z`,
        ),
        ...(options?.addDir ?? []).map(
          (p) => `${p}:/add-dir${p}:ro,Z`,
        ),
        ...(options?.addDirRw ?? []).map(
          (p) => `${p}:/add-dir${p}:rw,Z`,
        ),
      ],
      PortBindings: portBindings,
      NetworkMode: networkMode,
    },
  })

  await container.start()

  // Inject CA cert for HTTPS MITM (matches production session-create)
  const caCert = await proxy.getCaCert()
  const archive = await packTar([{ name: 'proxy-ca.pem', content: caCert }])
  await container.putArchive(archive, { path: '/tmp' })

  // Fix ownership of named cache volumes (created as root, but container runs as yaac)
  for (const containerPath of Object.values(config.cacheVolumes ?? {})) {
    await podmanExecRetry('podman', [
      'exec', '--user', 'root', containerName, 'chown', 'yaac:yaac', containerPath,
    ])
  }

  // Forward localhost:<pgPort> inside the container to the pg-relay sidecar (IPv4 + IPv6)
  if (pgRelayIp && testPgRelay) {
    await podmanExecRetry('podman', [
      'exec', '-d', '--user', 'root', containerName,
      'socat', `TCP4-LISTEN:${testPgRelay.containerPort},fork,reuseaddr,bind=127.0.0.1`, `TCP:${pgRelayIp}:${testPgRelay.containerPort}`,
    ])
    await podmanExecRetry('podman', [
      'exec', '-d', '--user', 'root', containerName,
      'socat', `TCP6-LISTEN:${testPgRelay.containerPort},fork,reuseaddr,bind=::1`, `TCP:${pgRelayIp}:${testPgRelay.containerPort}`,
    ])
  }

  // Fix worktree git pointers for in-container paths
  await podmanExecRetry('podman', [
    'exec', containerName, 'sh', '-c',
    `echo 'gitdir: /repo/.git/worktrees/${sessionId}' > /workspace/.git`,
  ])
  await podmanExecRetry('podman', [
    'exec', containerName, 'sh', '-c',
    `echo '/workspace/.git' > /repo/.git/worktrees/${sessionId}/gitdir`,
  ])

  // Configure git identity inside container
  await podmanExecRetry('podman', [
    'exec', containerName, 'git', 'config', '--global', 'user.name', 'Test',
  ])
  await podmanExecRetry('podman', [
    'exec', containerName, 'git', 'config', '--global', 'user.email', 'test@test.com',
  ])

  // Start tmux shell for the session
  const tmuxCmd = 'zsh'
  await podmanExecRetry('podman', [
    'exec', containerName, 'tmux', 'new-session', '-d', '-s', 'yaac', '-n', 'claude', tmuxCmd,
  ])

  // Run init commands synchronously (production runs them in a background tmux window)
  if (config.initCommands?.length) {
    for (const cmd of config.initCommands) {
      await podmanExecRetry('podman', [
        'exec', '-w', '/workspace', containerName, 'sh', '-c', cmd,
      ], { timeout: 300_000 })
    }
  }

  // Configure tmux UX
  const portInfo = forwardedPorts.length > 0
    ? ' ' + forwardedPorts.map((p) => `:${p.hostPort}->${p.containerPort}`).join(' ')
    : ''
  await podmanExecRetry('podman', [
    'exec', containerName, 'tmux', 'set-option', '-t', 'yaac', 'status-right', ` ${projectSlug} ${sessionId.slice(0, 8)}${portInfo} `,
  ])
  await podmanExecRetry('podman', [
    'exec', containerName, 'tmux', 'set-option', '-t', 'yaac', 'status-right-length', '80',
  ])
  await podmanExecRetry('podman', [
    'exec', containerName, 'tmux', 'bind-key', 'k', 'kill-server',
  ])

  const info = await container.inspect()
  return {
    containerId: info.Id,
    containerName,
    sessionId,
    forwardedPorts,
  }
}

describe('yaac session create', () => {
  const containersToCleanup: string[] = []
  const volumesToCleanup: string[] = []
  const tmpDirs: string[] = []

  afterEach(async () => {
    for (const name of containersToCleanup) {
      try {
        const c = podman.getContainer(name)
        await c.stop({ t: 1 })
        await c.remove()
      } catch {
        // already gone
      }
    }
    containersToCleanup.length = 0
    for (const vol of volumesToCleanup) {
      try {
        await execFileAsync('podman', ['volume', 'rm', vol])
      } catch {
        // already gone
      }
    }
    volumesToCleanup.length = 0
    for (const dir of tmpDirs) {
      await cleanupTempDir(dir)
    }
    tmpDirs.length = 0
  })

  describe('container basics (shared session)', () => {
    let result: { containerId: string; containerName: string; sessionId: string }
    let tmpDir: string

    beforeAll(async () => {
      await requirePodman()
      tmpDir = await createTempDataDir()
      const repoPath = path.join(tmpDir, 'basic-project')
      await createTestRepo(repoPath)
      await addTestProject(repoPath)
      result = await createSessionNonInteractive('basic-project')
    })

    afterAll(async () => {
      try {
        if (result) {
          const c = podman.getContainer(result.containerName)
          await c.stop({ t: 1 })
          await c.remove()
        }
      } catch {
        // already gone
      }
      if (tmpDir) await cleanupTempDir(tmpDir)
    })

    it('creates a container with correct labels', async () => {
      const info = await podman.getContainer(result.containerName).inspect()
      expect(info.State.Running).toBe(true)
      expect(info.Config.Labels['yaac.project']).toBe('basic-project')
      expect(info.Config.Labels['yaac.session-id']).toBe(result.sessionId)
    })

    it('creates worktree with correct branch', async () => {
      const wtPath = worktreeDir('basic-project', result.sessionId)
      const readme = await fs.readFile(path.join(wtPath, 'README.md'), 'utf8')
      expect(readme).toContain('Test repo')
    })

    it('mounts workspace and claude directories', async () => {
      const { stdout: lsOutput } = await execFileAsync('podman', [
        'exec', result.containerName, 'ls', '/workspace',
      ])
      expect(lsOutput).toContain('README.md')
      await execFileAsync('podman', [
        'exec', result.containerName, 'test', '-d', '/home/yaac/.claude',
      ])
    })

    it('has a working git repository in /workspace', async () => {
      const { stdout } = await execFileAsync('podman', [
        'exec', '-w', '/workspace', result.containerName, 'git', 'status', '--porcelain',
      ])
      expect(stdout.trim()).toBe('')
      const { stdout: branchOut } = await execFileAsync('podman', [
        'exec', '-w', '/workspace', result.containerName, 'git', 'rev-parse', '--abbrev-ref', 'HEAD',
      ])
      expect(branchOut.trim()).toBe(`yaac/${result.sessionId}`)
    })

    it('has tmux session running inside container', async () => {
      const { stdout } = await execFileAsync('podman', [
        'exec', result.containerName, 'tmux', 'list-sessions',
      ])
      expect(stdout).toContain('yaac')
    })

    it('shows session id in tmux status bar', async () => {
      const { stdout } = await execFileAsync('podman', [
        'exec', result.containerName, 'tmux', 'show-option', '-t', 'yaac', 'status-right',
      ])
      expect(stdout).toContain(result.sessionId.slice(0, 8))
    })
  })

  it('passes envPassthrough vars to container', async () => {
    await requirePodman()

    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)
    const repoPath = path.join(tmpDir, 'passthrough-project')
    await createTestRepo(repoPath, {
      yaacConfig: { envPassthrough: ['YAAC_TEST_VAR'] },
    })

    process.env.YAAC_TEST_VAR = 'hello-from-host'

    await addTestProject(repoPath)
    const result = await createSessionNonInteractive('passthrough-project')
    containersToCleanup.push(result.containerName)

    const { stdout } = await execFileAsync('podman', [
      'exec', result.containerName, 'env',
    ])
    expect(stdout).toContain('YAAC_TEST_VAR=hello-from-host')

    delete process.env.YAAC_TEST_VAR
  })

  it('starts tmux without creating prompt state', async () => {
    await requirePodman()

    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)
    const repoPath = path.join(tmpDir, 'noprompt-project')
    await createTestRepo(repoPath)
    await addTestProject(repoPath)

    const result = await createSessionNonInteractive('noprompt-project')
    containersToCleanup.push(result.containerName)

    const { stdout: tmuxOut } = await execFileAsync('podman', [
      'exec', result.containerName, 'tmux', 'list-sessions',
    ])
    expect(tmuxOut).toContain('yaac')

    try {
      await execFileAsync('podman', [
        'exec', result.containerName, 'cat', '/tmp/yaac-prompt',
      ])
      expect.fail('Expected /tmp/yaac-prompt to not exist')
    } catch {
      // Expected — file doesn't exist
    }
  })

  it('mounts cacheVolumes in container', async () => {
    await requirePodman()

    const volName = 'yaac-cache-cache-vol-project-test-cache'
    // Remove stale volume from prior runs to avoid podman lock conflicts
    try { await execFileAsync('podman', ['volume', 'rm', volName]) } catch { /* ignore */ }
    volumesToCleanup.push(volName)

    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)
    const repoPath = path.join(tmpDir, 'cache-vol-project')
    await createTestRepo(repoPath, {
      yaacConfig: {
        cacheVolumes: { 'test-cache': '/tmp/test-cache' },
      },
    })
    await addTestProject(repoPath)

    const result = await createSessionNonInteractive('cache-vol-project')
    containersToCleanup.push(result.containerName)

    // Write a file to the cache volume
    await execFileAsync('podman', [
      'exec', result.containerName, 'sh', '-c', 'echo hello > /tmp/test-cache/marker',
    ])

    // Verify the file exists
    const { stdout } = await execFileAsync('podman', [
      'exec', result.containerName, 'cat', '/tmp/test-cache/marker',
    ])
    expect(stdout.trim()).toBe('hello')
  })

  it('runs initCommands at session start', async () => {
    await requirePodman()

    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)
    const repoPath = path.join(tmpDir, 'init-cmd-project')
    await createTestRepo(repoPath, {
      yaacConfig: {
        initCommands: ['touch /tmp/init-ran'],
      },
    })
    await addTestProject(repoPath)

    const result = await createSessionNonInteractive('init-cmd-project')
    containersToCleanup.push(result.containerName)

    // Verify the init command ran
    const { stdout } = await execFileAsync('podman', [
      'exec', result.containerName, 'sh', '-c', 'test -f /tmp/init-ran && echo exists',
    ])
    expect(stdout.trim()).toBe('exists')
  })

  it('pnpm install reuses cached packages from store-dir on cache volume', async () => {
    await requirePodman()

    // Nested podman containers cannot resolve external DNS when running
    // inside a yaac session container — skip in that environment.
    try {
      await fs.access('/run/.containerenv')
      return // already inside a container — skip
    } catch { /* not in a container, proceed */ }

    const volName = 'yaac-cache-pnpm-cache-project-pnpm-store'
    // Remove stale volume from prior runs to avoid podman lock conflicts
    try { await execFileAsync('podman', ['volume', 'rm', volName]) } catch { /* ignore */ }
    volumesToCleanup.push(volName)

    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)
    const repoPath = path.join(tmpDir, 'pnpm-cache-project')
    await createTestRepo(repoPath, {
      yaacConfig: {
        cacheVolumes: { 'pnpm-store': '/home/yaac/.pnpm-store' },
        initCommands: ['pnpm install --store-dir /home/yaac/.pnpm-store'],
      },
    })

    // Add a minimal package.json so pnpm has something to install
    await fs.writeFile(
      path.join(repoPath, 'package.json'),
      JSON.stringify({ name: 'test', private: true, dependencies: { 'is-odd': '3.0.1' } }) + '\n',
    )
    await execFileAsync('pnpm', ['install', '--lockfile-only'], { cwd: repoPath })
    const git = (await import('simple-git')).default(repoPath)
    await git.add('.')
    await git.commit('add package.json')

    await addTestProject(repoPath)

    const result = await createSessionNonInteractive('pnpm-cache-project')
    containersToCleanup.push(result.containerName)

    // Verify pnpm resolves the store to our cache volume
    const { stdout: storePath } = await execFileAsync('podman', [
      'exec', '-w', '/workspace', result.containerName,
      'pnpm', 'store', 'path', '--store-dir', '/home/yaac/.pnpm-store',
    ])
    expect(storePath.trim()).toMatch(/^\/home\/yaac\/\.pnpm-store\//)

    // Verify the store has content after the init command ran
    const { stdout: fileCount } = await execFileAsync('podman', [
      'exec', result.containerName, 'sh', '-c',
      'find /home/yaac/.pnpm-store -type f | wc -l',
    ])
    expect(Number(fileCount.trim())).toBeGreaterThan(0)

    // Wipe node_modules and reinstall — packages should come from cache
    const { stdout: reinstallOutput } = await execFileAsync('podman', [
      'exec', '-w', '/workspace', result.containerName, 'sh', '-c',
      'rm -rf node_modules && pnpm install --store-dir /home/yaac/.pnpm-store 2>&1',
    ], { timeout: 120_000 })
    console.log('Reinstall output:\n' + reinstallOutput)

    // "downloaded 0" means everything came from the cache volume
    expect(reinstallOutput).toContain('downloaded 0')
  })

  it('runs podman inside container when nestedContainers is enabled', async () => {
    await requirePodman()

    // 3-level user namespace nesting is not supported by rootless podman.
    // When this test runs inside a container, skip it.
    try {
      await fs.access('/run/.containerenv')
      return // already inside a container — skip
    } catch { /* not in a container, proceed */ }

    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)
    const repoPath = path.join(tmpDir, 'nested-project')
    await createTestRepo(repoPath, {
      yaacConfig: { nestedContainers: true },
    })
    await addTestProject(repoPath)

    // Build the nestable image and create container with nested-container flags
    const imageName = await ensureImage('nested-project', TEST_IMAGE_PREFIX, true, true)
    const sessionId = crypto.randomBytes(4).toString('hex')
    const repo = repoDir('nested-project')
    const wtDir = worktreeDir('nested-project', sessionId)
    await fs.mkdir(worktreesDir('nested-project'), { recursive: true })
    await addWorktree(repo, wtDir, `yaac/${sessionId}`)

    const containerName = `yaac-nested-project-${sessionId}`
    containersToCleanup.push(containerName)

    const storageName = `yaac-test-podmanstorage-nested-project-${sessionId}`
    const container = await podman.createContainer({
      Image: imageName,
      name: containerName,
      Labels: { 'yaac.test': 'true' },
      Env: await getImageEnv(imageName),
      HostConfig: {
        Binds: [
          `${wtDir}:/workspace:Z`,
          `${repo}/.git:/repo/.git:Z`,
          `${storageName}:/home/yaac/.local/share/containers:Z`,
        ],
        SecurityOpt: ['label=disable', 'unmask=/proc/sys'],
        Devices: [{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }],
      },
    })
    await container.start()

    // Fix ownership of podman storage volume
    await execFileAsync('podman', [
      'exec', '--user', 'root', containerName, 'chown', 'yaac:yaac', '/home/yaac/.local/share/containers',
    ])

    // Run a nested container — this verifies the full podman-in-podman stack
    const { stdout } = await execFileAsync('podman', [
      'exec', containerName, 'podman', 'run', '--rm', 'docker.io/library/alpine', 'echo', 'nested-works',
    ], { timeout: 120_000 })
    expect(stdout.trim()).toBe('nested-works')

    // Clean up the test volume
    try {
      await execFileAsync('podman', ['volume', 'rm', storageName])
    } catch { /* ignore */ }
  }, 180_000)

  it('creates internal network with internet isolation when nestedContainers is enabled', async () => {
    await requirePodman()

    // 3-level user namespace nesting is not supported by rootless podman.
    try {
      await fs.access('/run/.containerenv')
      return // already inside a container — skip
    } catch { /* not in a container, proceed */ }

    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)
    const repoPath = path.join(tmpDir, 'nested-net-project')
    await createTestRepo(repoPath, {
      yaacConfig: { nestedContainers: true },
    })
    await addTestProject(repoPath)

    const imageName = await ensureImage('nested-net-project', TEST_IMAGE_PREFIX, true, true)
    const sessionId = crypto.randomBytes(4).toString('hex')
    const repo = repoDir('nested-net-project')
    const wtDir = worktreeDir('nested-net-project', sessionId)
    await fs.mkdir(worktreesDir('nested-net-project'), { recursive: true })
    await addWorktree(repo, wtDir, `yaac/${sessionId}`)

    const containerName = `yaac-nested-net-${sessionId}`
    containersToCleanup.push(containerName)

    const storageName = `yaac-test-podmanstorage-nested-net-${sessionId}`
    const container = await podman.createContainer({
      Image: imageName,
      name: containerName,
      Labels: { 'yaac.test': 'true' },
      Env: await getImageEnv(imageName),
      HostConfig: {
        Binds: [
          `${wtDir}:/workspace:Z`,
          `${repo}/.git:/repo/.git:Z`,
          `${storageName}:/home/yaac/.local/share/containers:Z`,
        ],
        SecurityOpt: ['label=disable', 'unmask=/proc/sys'],
        Devices: [{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }],
      },
    })
    await container.start()

    await execFileAsync('podman', [
      'exec', '--user', 'root', containerName, 'chown', 'yaac:yaac', '/home/yaac/.local/share/containers',
    ])
    await execFileAsync('podman', [
      'exec', '-d', containerName, 'podman', 'system', 'service', '--time=0',
      'unix:///run/user/1000/podman/podman.sock',
    ])
    // Wait for the podman service socket
    for (let i = 0; i < 20; i++) {
      try {
        await execFileAsync('podman', ['exec', containerName, 'podman', 'info', '--format', '{{.Host.Os}}'])
        break
      } catch {
        await new Promise((r) => setTimeout(r, 500))
      }
    }

    // Create an internal network inside the nested container
    await execFileAsync('podman', [
      'exec', containerName, 'podman', 'network', 'create', '--internal', '--disable-dns', 'test-internal',
    ])

    // Verify containers on the internal network cannot reach the internet
    const { stdout: blocked } = await execFileAsync('podman', [
      'exec', containerName, 'podman', 'run', '--rm', '--network=test-internal',
      'docker.io/library/alpine', 'sh', '-c',
      'wget -qO- --timeout=3 http://1.1.1.1 2>&1 || echo internet-blocked',
    ], { timeout: 30_000 })
    expect(blocked.trim()).toContain('internet-blocked')

    // Verify containers on the default (host) network CAN reach the internet
    const { stdout: works } = await execFileAsync('podman', [
      'exec', containerName, 'podman', 'run', '--rm',
      'docker.io/library/alpine', 'sh', '-c',
      'wget -qO- --timeout=10 http://1.1.1.1 >/dev/null 2>&1 && echo internet-works || echo internet-broken',
    ], { timeout: 30_000 })
    expect(works.trim()).toContain('internet-works')

    // Clean up
    try {
      await execFileAsync('podman', ['volume', 'rm', storageName])
    } catch { /* ignore */ }
  }, 180_000)

  it('forwards ports from host to container when portForward is configured', async () => {
    await requirePodman()

    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)
    const repoPath = path.join(tmpDir, 'portfwd-project')
    await createTestRepo(repoPath, {
      yaacConfig: {
        portForward: [
          { containerPort: 8080, hostPortStart: 18080 },
          { containerPort: 3000, hostPortStart: 13000 },
        ],
      },
    })
    await addTestProject(repoPath)

    const result = await createSessionNonInteractive('portfwd-project')
    containersToCleanup.push(result.containerName)

    expect(result.forwardedPorts).toHaveLength(2)
    expect(result.forwardedPorts[0].hostPort).toBeGreaterThanOrEqual(18080)
    expect(result.forwardedPorts[1].hostPort).toBeGreaterThanOrEqual(13000)

    // Verify port bindings are configured on the container
    const containerInfo = await podman.getContainer(result.containerName).inspect()
    const bindings = containerInfo.HostConfig.PortBindings as Record<string, Array<{ HostPort: string; HostIp: string }>>

    expect(bindings['8080/tcp']).toBeDefined()
    expect(bindings['8080/tcp'][0].HostPort).toBe(String(result.forwardedPorts[0].hostPort))
    expect(bindings['8080/tcp'][0].HostIp).toBe('127.0.0.1')

    expect(bindings['3000/tcp']).toBeDefined()
    expect(bindings['3000/tcp'][0].HostPort).toBe(String(result.forwardedPorts[1].hostPort))
    expect(bindings['3000/tcp'][0].HostIp).toBe('127.0.0.1')

    // Verify port info appears in tmux status bar
    const { stdout: statusRight } = await execFileAsync('podman', [
      'exec', result.containerName, 'tmux', 'show-option', '-t', 'yaac', 'status-right',
    ])
    expect(statusRight).toContain(`:${result.forwardedPorts[0].hostPort}->8080`)
    expect(statusRight).toContain(`:${result.forwardedPorts[1].hostPort}->3000`)
  })

  it('mounts bindMounts as read-only by default and read-write when specified', async () => {
    await requirePodman()

    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)

    // Create host directories to mount
    const roDir = path.join(tmpDir, 'ro-data')
    const rwDir = path.join(tmpDir, 'rw-data')
    await fs.mkdir(roDir, { recursive: true })
    await fs.mkdir(rwDir, { recursive: true })
    await fs.writeFile(path.join(roDir, 'readme.txt'), 'read-only content')
    await fs.writeFile(path.join(rwDir, 'data.txt'), 'writable content')

    const repoPath = path.join(tmpDir, 'bindmount-project')
    await createTestRepo(repoPath, {
      yaacConfig: {
        bindMounts: [
          { hostPath: roDir, containerPath: '/mnt/ro-data', mode: 'ro' as const },
          { hostPath: rwDir, containerPath: '/mnt/rw-data', mode: 'rw' as const },
        ],
      },
    })
    await addTestProject(repoPath)

    const result = await createSessionNonInteractive('bindmount-project')
    containersToCleanup.push(result.containerName)

    // Verify read-only mount content is accessible
    const { stdout: roContent } = await execFileAsync('podman', [
      'exec', result.containerName, 'cat', '/mnt/ro-data/readme.txt',
    ])
    expect(roContent.trim()).toBe('read-only content')

    // Verify read-only mount rejects writes
    await expect(execFileAsync('podman', [
      'exec', result.containerName, 'sh', '-c', 'echo test > /mnt/ro-data/fail.txt',
    ])).rejects.toThrow()

    // Verify read-write mount content is accessible
    const { stdout: rwContent } = await execFileAsync('podman', [
      'exec', result.containerName, 'cat', '/mnt/rw-data/data.txt',
    ])
    expect(rwContent.trim()).toBe('writable content')

    // Verify read-write mount accepts writes
    await execFileAsync('podman', [
      'exec', result.containerName, 'sh', '-c', 'echo new-data > /mnt/rw-data/new.txt',
    ])
    const { stdout: newContent } = await execFileAsync('podman', [
      'exec', result.containerName, 'cat', '/mnt/rw-data/new.txt',
    ])
    expect(newContent.trim()).toBe('new-data')
  })

  it('--add-dir mounts host directory as read-only', async () => {
    await requirePodman()

    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)

    const hostDir = path.join(tmpDir, 'ro-extra')
    await fs.mkdir(hostDir, { recursive: true })
    await fs.writeFile(path.join(hostDir, 'hello.txt'), 'read-only extra')

    const repoPath = path.join(tmpDir, 'adddir-ro-project')
    await createTestRepo(repoPath)
    await addTestProject(repoPath)

    const result = await createSessionNonInteractive('adddir-ro-project', { addDir: [hostDir] })
    containersToCleanup.push(result.containerName)

    // Verify content is readable at /add-dir/<hostDir>
    const { stdout: content } = await execFileAsync('podman', [
      'exec', result.containerName, 'cat', `/add-dir${hostDir}/hello.txt`,
    ])
    expect(content.trim()).toBe('read-only extra')

    // Verify writes are rejected
    await expect(execFileAsync('podman', [
      'exec', result.containerName, 'sh', '-c', `echo test > /add-dir${hostDir}/fail.txt`,
    ])).rejects.toThrow()
  })

  it('--add-dir-rw mounts host directory as read-write', async () => {
    await requirePodman()

    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)

    const hostDir = path.join(tmpDir, 'rw-extra')
    await fs.mkdir(hostDir, { recursive: true })
    await fs.writeFile(path.join(hostDir, 'data.txt'), 'writable extra')

    const repoPath = path.join(tmpDir, 'adddir-rw-project')
    await createTestRepo(repoPath)
    await addTestProject(repoPath)

    const result = await createSessionNonInteractive('adddir-rw-project', { addDirRw: [hostDir] })
    containersToCleanup.push(result.containerName)

    // Verify content is readable at /add-dir/<hostDir>
    const { stdout: content } = await execFileAsync('podman', [
      'exec', result.containerName, 'cat', `/add-dir${hostDir}/data.txt`,
    ])
    expect(content.trim()).toBe('writable extra')

    // Verify writes succeed
    await execFileAsync('podman', [
      'exec', result.containerName, 'sh', '-c', `echo new-data > /add-dir${hostDir}/new.txt`,
    ])
    const { stdout: newContent } = await execFileAsync('podman', [
      'exec', result.containerName, 'cat', `/add-dir${hostDir}/new.txt`,
    ])
    expect(newContent.trim()).toBe('new-data')
  })

  it('sets up pg-relay when pgRelay config is present', async () => {
    await requirePodman()

    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)
    const repoPath = path.join(tmpDir, 'pg-relay-project')
    await createTestRepo(repoPath, {
      yaacConfig: {
        pgRelay: { enabled: true },
      },
    })
    await addTestProject(repoPath)

    const pgRelay = new PgRelayClient()
    try {
      const result = await createSessionNonInteractive('pg-relay-project')
      containersToCleanup.push(result.containerName)

      // Verify socat is forwarding localhost:5432 inside the container
      const { stdout: socatOut } = await execFileAsync('podman', [
        'exec', result.containerName, 'sh', '-c', 'cat /proc/*/cmdline 2>/dev/null | tr "\\0" " "',
      ])
      expect(socatOut).toContain('TCP4-LISTEN:5432')
      expect(socatOut).toContain('TCP6-LISTEN:5432')

      // Verify localhost:5432 is reachable inside the container
      const { exitCode } = await execFileAsync('podman', [
        'exec', result.containerName, 'nc', '-z', 'localhost', '5432',
      ]).then(() => ({ exitCode: 0 })).catch(() => ({ exitCode: 1 }))
      expect(exitCode).toBe(0)

      // Verify the session container is on the yaac-sessions network
      const info = await podman.getContainer(result.containerName).inspect()
      const networks = Object.keys(info.NetworkSettings.Networks as Record<string, unknown>)
      expect(networks).toContain(TEST_PROXY_CONFIG.network)
    } finally {
      await pgRelay.stop()
    }
  })

  it('errors gracefully on unknown project', async () => {
    process.exitCode = undefined
    const { sessionCreate } = await import('@/commands/session-create')

    // Mock to avoid actual container runtime check
    const errs: string[] = []
    const origErr = console.error
    console.error = (msg: string) => errs.push(msg)

    await sessionCreate('nonexistent-project', {})

    console.error = origErr
    expect(process.exitCode).toBe(1)
    expect(errs.join('\n')).toContain('not found')
    process.exitCode = undefined
  })
})
