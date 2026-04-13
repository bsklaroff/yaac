import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createTempDataDir, cleanupTempDir, createTestRepo, requirePodman, TEST_IMAGE_PREFIX, TEST_SSH_AGENT_CONFIG, TEST_PROXY_CONFIG } from '@test/helpers/setup'
import { projectAdd } from '@/commands/project-add'
import { podman } from '@/lib/podman'
import { ensureImage } from '@/lib/image-builder'
import { addWorktree, getDefaultBranch } from '@/lib/git'
import { resolveProjectConfig } from '@/lib/config'
import { repoDir, claudeDir, worktreeDir, worktreesDir, getDataDir } from '@/lib/paths'
import { buildRulesFromConfig } from '@/lib/secret-conventions'
import { ProxyClient } from '@/lib/proxy-client'
import { hasSshKeys, SshAgentClient } from '@/lib/ssh-agent'
import { findAvailablePort } from '@/lib/port'

const execFileAsync = promisify(execFile)

// Test-specific sidecar instances — isolated from the running application
const testProxyClient = new ProxyClient({
  ...TEST_PROXY_CONFIG,
  authSecret: crypto.randomBytes(32).toString('hex'),
})
const testSshAgent = new SshAgentClient(undefined, TEST_SSH_AGENT_CONFIG)

async function createSessionNonInteractive(projectSlug: string, options?: { prompt?: string }): Promise<{
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
  const env: string[] = ['TERM=xterm-256color', 'EDITOR=nvim']

  if (config.envPassthrough) {
    for (const name of config.envPassthrough) {
      const val = process.env[name]
      if (val !== undefined) {
        env.push(`${name}=${val}`)
      }
    }
  }

  let networkMode = 'podman'
  const hasSecretProxy = config.envSecretProxy && Object.keys(config.envSecretProxy).length > 0

  if (hasSecretProxy) {
    await testProxyClient.ensureRunning()
    const rules = buildRulesFromConfig(config.envSecretProxy!, process.env)
    await testProxyClient.updateProjectRules(projectSlug, rules)
    const proxyToken = testProxyClient.generateSessionToken()
    await testProxyClient.registerSession(proxyToken, projectSlug)
    env.push(...testProxyClient.getProxyEnv(proxyToken))
    for (const name of Object.keys(config.envSecretProxy!)) {
      if (process.env[name]) {
        env.push(`${name}=placeholder`)
      }
    }
    networkMode = testProxyClient.network
  }

  // SSH agent setup
  const sshBinds: string[] = []
  if (hasSshKeys()) {
    await testSshAgent.ensureRunning()
    env.push(...testSshAgent.getSshEnv())
    sshBinds.push(...testSshAgent.getBinds())
  }

  // Port forwarding setup
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
        ...sshBinds,
        ...Object.entries(config.cacheVolumes ?? {}).map(
          ([key, containerPath]) => `yaac-cache-${projectSlug}-${key}:${containerPath}:Z`,
        ),
      ],
      PortBindings: portBindings,
      NetworkMode: networkMode,
    },
  })

  await container.start()

  // Fix ownership of named cache volumes (created as root, but container runs as yaac)
  for (const containerPath of Object.values(config.cacheVolumes ?? {})) {
    await execFileAsync('podman', [
      'exec', '--user', 'root', containerName, 'chown', 'yaac:yaac', containerPath,
    ])
  }

  // Fix worktree git pointers for in-container paths
  await execFileAsync('podman', [
    'exec', containerName, 'sh', '-c',
    `echo 'gitdir: /repo/.git/worktrees/${sessionId}' > /workspace/.git`,
  ])
  await execFileAsync('podman', [
    'exec', containerName, 'sh', '-c',
    `echo '/workspace/.git' > /repo/.git/worktrees/${sessionId}/gitdir`,
  ])

  // Configure git identity inside container
  await execFileAsync('podman', [
    'exec', containerName, 'git', 'config', '--global', 'user.name', 'Test',
  ])
  await execFileAsync('podman', [
    'exec', containerName, 'git', 'config', '--global', 'user.email', 'test@test.com',
  ])

  // Start tmux — use the prompt if provided, otherwise just bash
  const tmuxCmd = options?.prompt
    ? `echo 'YAAC_PROMPT=${options.prompt.replace(/'/g, "'\\''")}' > /tmp/yaac-prompt && bash`
    : 'bash'
  await execFileAsync('podman', [
    'exec', containerName, 'tmux', 'new-session', '-d', '-s', 'yaac', '-n', 'claude', tmuxCmd,
  ])

  // Run init commands synchronously (production runs them in a background tmux window)
  if (config.initCommands?.length) {
    for (const cmd of config.initCommands) {
      await execFileAsync('podman', [
        'exec', '-w', '/workspace', containerName, 'sh', '-c', cmd,
      ], { timeout: 300_000 })
    }
  }

  // Configure tmux UX
  const portInfo = forwardedPorts.length > 0
    ? ' ' + forwardedPorts.map((p) => `:${p.hostPort}->${p.containerPort}`).join(' ')
    : ''
  await execFileAsync('podman', [
    'exec', containerName, 'tmux', 'set-option', '-t', 'yaac', 'status-right', ` ${projectSlug} ${sessionId.slice(0, 8)}${portInfo} `,
  ])
  await execFileAsync('podman', [
    'exec', containerName, 'tmux', 'set-option', '-t', 'yaac', 'status-right-length', '80',
  ])
  await execFileAsync('podman', [
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
      await projectAdd(repoPath)
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

    await projectAdd(repoPath)
    const result = await createSessionNonInteractive('passthrough-project')
    containersToCleanup.push(result.containerName)

    const { stdout } = await execFileAsync('podman', [
      'exec', result.containerName, 'env',
    ])
    expect(stdout).toContain('YAAC_TEST_VAR=hello-from-host')

    delete process.env.YAAC_TEST_VAR
  })

  it('passes prompt to tmux session when --prompt is provided', async () => {
    await requirePodman()

    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)
    const repoPath = path.join(tmpDir, 'prompt-project')
    await createTestRepo(repoPath)
    await projectAdd(repoPath)

    const result = await createSessionNonInteractive('prompt-project', { prompt: 'fix the login bug' })
    containersToCleanup.push(result.containerName)

    const { stdout } = await execFileAsync('podman', [
      'exec', result.containerName, 'cat', '/tmp/yaac-prompt',
    ])
    expect(stdout).toContain('YAAC_PROMPT=fix the login bug')
  })

  it('handles prompt with special characters', async () => {
    await requirePodman()

    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)
    const repoPath = path.join(tmpDir, 'special-prompt')
    await createTestRepo(repoPath)
    await projectAdd(repoPath)

    const prompt = "fix the user's login & add \"tests\""
    const result = await createSessionNonInteractive('special-prompt', { prompt })
    containersToCleanup.push(result.containerName)

    const { stdout } = await execFileAsync('podman', [
      'exec', result.containerName, 'cat', '/tmp/yaac-prompt',
    ])
    expect(stdout).toContain('fix the user')
  })

  it('starts claude without -p when no prompt given', async () => {
    await requirePodman()

    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)
    const repoPath = path.join(tmpDir, 'noprompt-project')
    await createTestRepo(repoPath)
    await projectAdd(repoPath)

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

  it('has SSH_AUTH_SOCK set when SSH keys exist', async () => {
    await requirePodman()
    if (!hasSshKeys()) return // skip if no SSH keys on host

    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)
    const repoPath = path.join(tmpDir, 'ssh-project')
    await createTestRepo(repoPath)
    await projectAdd(repoPath)

    const result = await createSessionNonInteractive('ssh-project')
    containersToCleanup.push(result.containerName)

    // Verify SSH_AUTH_SOCK is set
    const { stdout: envOut } = await execFileAsync('podman', [
      'exec', result.containerName, 'env',
    ])
    expect(envOut).toContain('SSH_AUTH_SOCK=/ssh-agent/socket')

    // Verify the socket file exists
    await execFileAsync('podman', [
      'exec', result.containerName, 'test', '-S', '/ssh-agent/socket',
    ])
  })

  it('can list SSH keys from session container via agent', async () => {
    await requirePodman()

    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)

    // Generate a temporary SSH key for this test
    const sshDir = path.join(tmpDir, 'dot-ssh')
    await fs.mkdir(sshDir, { mode: 0o700 })
    await execFileAsync('ssh-keygen', [
      '-t', 'ed25519', '-f', path.join(sshDir, 'id_ed25519'), '-N', '', '-q',
    ])

    // Use a dedicated SshAgentClient pointing at our test keys with isolated names
    const testAgent = new SshAgentClient(sshDir, TEST_SSH_AGENT_CONFIG)
    try {
      await testAgent.ensureRunning()

      const repoPath = path.join(tmpDir, 'ssh-agent-project')
      await createTestRepo(repoPath)
      await projectAdd(repoPath)

      const sessionId = crypto.randomBytes(4).toString('hex')
      const repo = repoDir('ssh-agent-project')
      const wtDir = worktreeDir('ssh-agent-project', sessionId)
      await fs.mkdir(worktreesDir('ssh-agent-project'), { recursive: true })
      await addWorktree(repo, wtDir, `yaac/${sessionId}`)

      const imageName = await ensureImage('ssh-agent-project', TEST_IMAGE_PREFIX, true)
      const containerName = `yaac-ssh-agent-project-${sessionId}`
      containersToCleanup.push(containerName)

      const container = await podman.createContainer({
        Image: imageName,
        name: containerName,
        Labels: { 'yaac.test': 'true' },
        Env: ['TERM=xterm-256color', ...testAgent.getSshEnv()],
        HostConfig: {
          Binds: [
            `${wtDir}:/workspace:Z`,
            `${repo}/.git:/repo/.git:Z`,
            ...testAgent.getBinds(),
          ],
        },
      })
      await container.start()

      // ssh-add -l must succeed and list the test key
      const { stdout } = await execFileAsync('podman', [
        'exec', containerName, 'ssh-add', '-l',
      ])
      expect(stdout).toMatch(/\d+ SHA256:/)
    } finally {
      await testAgent.stop()
    }
  }, 60_000)

  it('mounts cacheVolumes in container', async () => {
    await requirePodman()

    const tmpDir = await createTempDataDir()
    tmpDirs.push(tmpDir)
    const repoPath = path.join(tmpDir, 'cache-vol-project')
    await createTestRepo(repoPath, {
      yaacConfig: {
        cacheVolumes: { 'test-cache': '/tmp/test-cache' },
      },
    })
    await projectAdd(repoPath)

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

    // Clean up the test volume
    try {
      await execFileAsync('podman', ['volume', 'rm', 'yaac-cache-cache-vol-project-test-cache'])
    } catch { /* ignore */ }
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
    await projectAdd(repoPath)

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

    await projectAdd(repoPath)

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

    // Clean up the test volume
    try {
      await execFileAsync('podman', ['volume', 'rm', 'yaac-cache-pnpm-cache-project-pnpm-store'])
    } catch { /* ignore */ }
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
    await projectAdd(repoPath)

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
      Env: ['TERM=xterm-256color'],
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
    await projectAdd(repoPath)

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
      Env: ['TERM=xterm-256color'],
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

    // Verify containers on the default bridge CAN reach the internet
    const { stdout: works } = await execFileAsync('podman', [
      'exec', containerName, 'podman', 'run', '--rm', '--network=podman',
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
    await projectAdd(repoPath)

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
