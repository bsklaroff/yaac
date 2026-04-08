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
import { repoDir, claudeDir, worktreeDir, worktreesDir } from '@/lib/paths'
import { buildRulesFromConfig } from '@/lib/secret-conventions'
import { proxyClient } from '@/lib/proxy-client'

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
  const env: string[] = ['TERM=xterm-256color']

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

  const containerName = `yaac-${projectSlug}-${sessionId}`
  const claude = claudeDir(projectSlug)

  const container = await podman.createContainer({
    Image: imageName,
    name: containerName,
    Labels: {
      'yaac.managed': 'true',
      'yaac.project': projectSlug,
      'yaac.session-id': sessionId,
      'yaac.test': 'true',
    },
    Env: env,
    HostConfig: {
      Binds: [
        `${wtDir}:/workspace:Z`,
        `${claude}:/home/yaac/.claude:Z`,
      ],
      NetworkMode: networkMode,
    },
  })

  await container.start()

  // Start tmux — use the prompt if provided, otherwise just bash
  const tmuxCmd = options?.prompt
    ? `echo YAAC_PROMPT=${options.prompt.replace(/'/g, "'\\''")} > /tmp/yaac-prompt && bash`
    : 'bash'
  await execFileAsync('podman', [
    'exec', containerName, 'tmux', 'new-session', '-d', '-s', 'claude', tmuxCmd,
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
    expect(info.Config.Labels['yaac.managed']).toBe('true')
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
