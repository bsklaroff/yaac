import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createTempDataDir, cleanupTempDir, createTestRepo, podmanAvailable } from '@test/helpers/setup'
import { projectAdd } from '@/commands/project-add'
import { podman } from '@/lib/podman'
import { ensureImage } from '@/lib/image-builder'
import { addWorktree, getDefaultBranch } from '@/lib/git'
import { loadProjectConfig } from '@/lib/config'
import { repoDir, claudeDir, worktreeDir, worktreesDir, getDataDir } from '@/lib/paths'
import { buildRulesFromConfig } from '@/lib/secret-conventions'
import { proxyClient } from '@/lib/proxy-client'
import { shellEscape } from '@/commands/session-create'
import { sshAgent, hasSshKeys, SshAgentClient } from '@/lib/ssh-agent'

const execFileAsync = promisify(execFile)

async function createSessionNonInteractive(projectSlug: string, options?: { prompt?: string }): Promise<{
  containerId: string
  containerName: string
  sessionId: string
}> {
  const imageName = await ensureImage(projectSlug)
  const sessionId = crypto.randomBytes(4).toString('hex')
  const repo = repoDir(projectSlug)
  const wtDir = worktreeDir(projectSlug, sessionId)

  await fs.mkdir(worktreesDir(projectSlug), { recursive: true })
  await getDefaultBranch(repo)
  await addWorktree(repo, wtDir, `yaac/${sessionId}`)

  const config = await loadProjectConfig(repo) ?? {}
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
    await proxyClient.ensureRunning()
    const rules = buildRulesFromConfig(config.envSecretProxy!, process.env)
    await proxyClient.updateProjectRules(projectSlug, rules)
    const proxyToken = proxyClient.generateSessionToken()
    await proxyClient.registerSession(proxyToken, projectSlug)
    env.push(...proxyClient.getProxyEnv(proxyToken))
    for (const name of Object.keys(config.envSecretProxy!)) {
      if (process.env[name]) {
        env.push(`${name}=placeholder`)
      }
    }
    networkMode = proxyClient.network
  }

  // SSH agent setup
  const sshBinds: string[] = []
  if (hasSshKeys()) {
    await sshAgent.ensureRunning()
    env.push(...sshAgent.getSshEnv())
    sshBinds.push(...sshAgent.getBinds())
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
    Env: env,
    HostConfig: {
      Binds: [
        `${wtDir}:/workspace:Z`,
        `${repo}/.git:/repo/.git:Z`,
        `${claude}:/home/yaac/.claude:Z`,
        ...sshBinds,
      ],
      NetworkMode: networkMode,
    },
  })

  await container.start()

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
    'exec', containerName, 'tmux', 'new-session', '-d', '-s', 'claude', tmuxCmd,
  ])

  // Configure tmux UX
  await execFileAsync('podman', [
    'exec', containerName, 'tmux', 'set-option', '-t', 'claude', 'mouse', 'on',
  ])
  await execFileAsync('podman', [
    'exec', containerName, 'tmux', 'set-option', '-t', 'claude', 'status-right', ` ${sessionId} `,
  ])
  await execFileAsync('podman', [
    'exec', containerName, 'tmux', 'set-option', '-t', 'claude', 'status-right-length', '50',
  ])

  const info = await container.inspect()
  return {
    containerId: info.Id,
    containerName,
    sessionId,
  }
}

describe('yaac session create', () => {
  let tmpDir: string
  let isPodmanAvailable: boolean
  const containersToCleanup: string[] = []

  beforeAll(async () => {
    isPodmanAvailable = await podmanAvailable()
  })

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    // Cleanup containers
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
    await cleanupTempDir(tmpDir)
  })

  it('creates a container with correct labels and mounts', async () => {
    if (!isPodmanAvailable) return

    const repoPath = path.join(tmpDir, 'test-project')
    await createTestRepo(repoPath)
    await projectAdd(repoPath)

    const result = await createSessionNonInteractive('test-project')
    containersToCleanup.push(result.containerName)

    // Verify container is running
    const info = await podman.getContainer(result.containerName).inspect()
    expect(info.State.Running).toBe(true)

    // Verify labels
    expect(info.Config.Labels['yaac.project']).toBe('test-project')
    expect(info.Config.Labels['yaac.session-id']).toBe(result.sessionId)
  })

  it('creates worktree with correct branch', async () => {
    if (!isPodmanAvailable) return

    const repoPath = path.join(tmpDir, 'wt-project')
    await createTestRepo(repoPath)
    await projectAdd(repoPath)

    const result = await createSessionNonInteractive('wt-project')
    containersToCleanup.push(result.containerName)

    // Verify worktree exists
    const wtPath = worktreeDir('wt-project', result.sessionId)
    const readme = await fs.readFile(path.join(wtPath, 'README.md'), 'utf8')
    expect(readme).toContain('Test repo')
  })

  it('mounts workspace and claude directories', async () => {
    if (!isPodmanAvailable) return

    const repoPath = path.join(tmpDir, 'mount-project')
    await createTestRepo(repoPath)
    await projectAdd(repoPath)

    const result = await createSessionNonInteractive('mount-project')
    containersToCleanup.push(result.containerName)

    // Check /workspace has repo files
    const { stdout: lsOutput } = await execFileAsync('podman', [
      'exec', result.containerName, 'ls', '/workspace',
    ])
    expect(lsOutput).toContain('README.md')

    // Check /home/yaac/.claude exists (test -d exits 0 if dir exists)
    await execFileAsync('podman', [
      'exec', result.containerName, 'test', '-d', '/home/yaac/.claude',
    ])
  })

  it('has a working git repository in /workspace', async () => {
    if (!isPodmanAvailable) return

    const repoPath = path.join(tmpDir, 'git-project')
    await createTestRepo(repoPath)
    await projectAdd(repoPath)

    const result = await createSessionNonInteractive('git-project')
    containersToCleanup.push(result.containerName)

    // git status should succeed (not "not a git repository")
    const { stdout } = await execFileAsync('podman', [
      'exec', '-w', '/workspace', result.containerName, 'git', 'status', '--porcelain',
    ])
    expect(stdout.trim()).toBe('')

    // Verify correct branch
    const { stdout: branchOut } = await execFileAsync('podman', [
      'exec', '-w', '/workspace', result.containerName, 'git', 'rev-parse', '--abbrev-ref', 'HEAD',
    ])
    expect(branchOut.trim()).toBe(`yaac/${result.sessionId}`)
  })

  it('has tmux session running inside container', async () => {
    if (!isPodmanAvailable) return

    const repoPath = path.join(tmpDir, 'tmux-project')
    await createTestRepo(repoPath)
    await projectAdd(repoPath)

    const result = await createSessionNonInteractive('tmux-project')
    containersToCleanup.push(result.containerName)

    const { stdout } = await execFileAsync('podman', [
      'exec', result.containerName, 'tmux', 'list-sessions',
    ])
    expect(stdout).toContain('claude')
  })

  it('shows session id in tmux status bar', async () => {
    if (!isPodmanAvailable) return

    const repoPath = path.join(tmpDir, 'statusbar-project')
    await createTestRepo(repoPath)
    await projectAdd(repoPath)

    const result = await createSessionNonInteractive('statusbar-project')
    containersToCleanup.push(result.containerName)

    const { stdout } = await execFileAsync('podman', [
      'exec', result.containerName, 'tmux', 'show-option', '-t', 'claude', 'status-right',
    ])
    expect(stdout).toContain(result.sessionId)
  })

  it('passes envPassthrough vars to container', async () => {
    if (!isPodmanAvailable) return

    const repoPath = path.join(tmpDir, 'passthrough-project')
    await createTestRepo(repoPath, {
      yaacConfig: { envPassthrough: ['YAAC_TEST_VAR'] },
    })

    // Set the env var
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
    if (!isPodmanAvailable) return

    const repoPath = path.join(tmpDir, 'prompt-project')
    await createTestRepo(repoPath)
    await projectAdd(repoPath)

    const result = await createSessionNonInteractive('prompt-project', { prompt: 'fix the login bug' })
    containersToCleanup.push(result.containerName)

    // Verify the prompt was written to the marker file inside the container
    const { stdout } = await execFileAsync('podman', [
      'exec', result.containerName, 'cat', '/tmp/yaac-prompt',
    ])
    expect(stdout).toContain('YAAC_PROMPT=fix the login bug')
  })

  it('handles prompt with special characters', async () => {
    if (!isPodmanAvailable) return

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
    if (!isPodmanAvailable) return

    const repoPath = path.join(tmpDir, 'noprompt-project')
    await createTestRepo(repoPath)
    await projectAdd(repoPath)

    const result = await createSessionNonInteractive('noprompt-project')
    containersToCleanup.push(result.containerName)

    // Verify tmux is running but no prompt marker file exists
    const { stdout: tmuxOut } = await execFileAsync('podman', [
      'exec', result.containerName, 'tmux', 'list-sessions',
    ])
    expect(tmuxOut).toContain('claude')

    // The marker file should NOT exist
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
    if (!isPodmanAvailable) return
    if (!hasSshKeys()) return // skip if no SSH keys on host

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
    if (!isPodmanAvailable) return

    // Generate a temporary SSH key for this test
    const sshDir = path.join(tmpDir, 'dot-ssh')
    await fs.mkdir(sshDir, { mode: 0o700 })
    await execFileAsync('ssh-keygen', [
      '-t', 'ed25519', '-f', path.join(sshDir, 'id_ed25519'), '-N', '', '-q',
    ])

    // Use a dedicated SshAgentClient pointing at our test keys
    const testAgent = new SshAgentClient(sshDir)
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

      const imageName = await ensureImage('ssh-agent-project')
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
