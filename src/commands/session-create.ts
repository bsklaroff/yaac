import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import readline from 'node:readline/promises'
import { execSync } from 'node:child_process'
import simpleGit from 'simple-git'
import { ensureContainerRuntime, podman } from '@/lib/podman'
import { ensureImage } from '@/lib/image-builder'
import { repoDir, claudeDir, claudeJsonFile, worktreeDir, worktreesDir, projectDir, getDataDir } from '@/lib/paths'
import { addWorktree, getDefaultBranch, fetchAndPullDefault, getGitUserConfig } from '@/lib/git'
import { resolveProjectConfig } from '@/lib/config'
import { buildRulesFromConfig } from '@/lib/secret-conventions'
import { isTmuxSessionAlive, cleanupSession } from '@/lib/session-cleanup'
import { proxyClient } from '@/lib/proxy-client'
import { sshAgent, hasSshKeys } from '@/lib/ssh-agent'
import type { YaacConfig } from '@/types'

export function shellEscape(str: string): string {
  return str.replace(/'/g, "'\\''")
}

export interface SessionCreateOptions {
  prompt?: string
}

export async function sessionCreate(projectSlug: string, options: SessionCreateOptions): Promise<void> {
  // Verify project exists
  try {
    await fs.access(projectDir(projectSlug))
  } catch {
    console.error(`Project "${projectSlug}" not found. Run "yaac project list" to see available projects.`)
    process.exitCode = 1
    return
  }

  await ensureContainerRuntime()

  // Ensure git user identity is configured (needed for commits inside container)
  let gitUser = await getGitUserConfig()
  if (gitUser) {
    console.log(`Git identity: ${gitUser.name} <${gitUser.email}>`)
  } else {
    console.log('No global git user configured. Git commits require a user identity.')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const name = await rl.question('Enter git user.name: ')
    const email = await rl.question('Enter git user.email: ')
    rl.close()
    if (!name || !email) {
      console.error('Git user.name and user.email are required.')
      process.exitCode = 1
      return
    }
    await simpleGit().addConfig('user.name', name, false, 'global')
    await simpleGit().addConfig('user.email', email, false, 'global')
    gitUser = { name, email }
  }

  const repo = repoDir(projectSlug)

  // Fetch latest from remote before building images
  console.log('Fetching latest from remote...')
  try {
    await fetchAndPullDefault(repo)
  } catch {
    console.warn('Warning: could not fetch from remote, using local state')
  }

  console.log('Ensuring container images are built...')
  const imageName = await ensureImage(projectSlug)

  const sessionId = crypto.randomUUID()
  const wtDir = worktreeDir(projectSlug, sessionId)

  // Create worktree
  await fs.mkdir(worktreesDir(projectSlug), { recursive: true })
  const defaultBranch = await getDefaultBranch(repo)
  console.log(`Creating worktree from ${defaultBranch}...`)
  await addWorktree(repo, wtDir, `yaac/${sessionId}`, `origin/${defaultBranch}`)

  // Load project config (local override at ~/.yaac/projects/<slug>/ takes precedence)
  const config: YaacConfig = await resolveProjectConfig(projectSlug) ?? {}

  // Build container env
  const env: string[] = []

  // Passthrough env vars
  if (config.envPassthrough) {
    for (const name of config.envPassthrough) {
      const val = process.env[name]
      if (val !== undefined) {
        env.push(`${name}=${val}`)
      }
    }
  }

  // Proxy setup
  let proxyToken: string | null = null
  const hasSecretProxy = config.envSecretProxy && Object.keys(config.envSecretProxy).length > 0
  let networkMode = 'podman'

  if (hasSecretProxy) {
    console.log('Starting proxy sidecar...')
    await proxyClient.ensureRunning()

    const rules = buildRulesFromConfig(config.envSecretProxy!, process.env)
    await proxyClient.updateProjectRules(projectSlug, rules)

    proxyToken = proxyClient.generateSessionToken()
    await proxyClient.registerSession(proxyToken, projectSlug)

    // Add proxy env vars
    env.push(...proxyClient.getProxyEnv(proxyToken))

    // Add placeholder values for proxied secrets so tools detect them
    for (const name of Object.keys(config.envSecretProxy!)) {
      if (process.env[name]) {
        env.push(`${name}=placeholder`)
      }
    }

    networkMode = proxyClient.network
  }

  // SSH agent setup (if user has SSH keys)
  const sshBinds: string[] = []
  if (hasSshKeys()) {
    console.log('Starting SSH agent sidecar...')
    await sshAgent.ensureRunning()
    env.push(...sshAgent.getSshEnv())
    sshBinds.push(...sshAgent.getBinds())
  }

  const containerName = `yaac-${projectSlug}-${sessionId}`
  const claude = claudeDir(projectSlug)
  const claudeJson = claudeJsonFile(projectSlug)

  // Ensure claude.json exists so Podman mounts it as a file, not a directory
  try {
    await fs.access(claudeJson)
  } catch {
    await fs.writeFile(claudeJson, '{}')
  }

  console.log(`Creating container ${containerName}...`)
  const container = await podman.createContainer({
    Image: imageName,
    name: containerName,
    Labels: {
      'yaac.project': projectSlug,
      'yaac.session-id': sessionId,
      'yaac.data-dir': getDataDir(),
    },
    Env: env,
    HostConfig: {
      Binds: [
        `${wtDir}:/workspace:Z`,
        `${repo}/.git:/repo/.git:Z`,
        `${claude}:/home/yaac/.claude:Z`,
        `${claudeJson}:/home/yaac/.claude.json:Z`,
        ...sshBinds,
        ...Object.entries(config.cacheVolumes ?? {}).map(
          ([key, containerPath]) => `yaac-cache-${projectSlug}-${key}:${containerPath}:Z`,
        ),
      ],
      NetworkMode: networkMode,
    },
  })

  await container.start()

  // Fix ownership of named cache volumes (created as root, but container runs as yaac)
  for (const containerPath of Object.values(config.cacheVolumes ?? {})) {
    execSync(`podman exec --user root ${containerName} chown yaac:yaac '${shellEscape(containerPath)}'`)
  }

  // Inject CA cert if using proxy
  if (hasSecretProxy) {
    const caCert = await proxyClient.getCaCert()
    execSync(`podman cp - ${containerName}:/tmp/proxy-ca.pem`, {
      input: caCert,
    })
  }

  // Fix worktree git pointers for in-container paths
  execSync(`podman exec ${containerName} sh -c "echo 'gitdir: /repo/.git/worktrees/${sessionId}' > /workspace/.git"`)
  execSync(`podman exec ${containerName} sh -c "echo '/workspace/.git' > /repo/.git/worktrees/${sessionId}/gitdir"`)

  // Configure git identity inside container
  execSync(`podman exec ${containerName} git config --global user.name '${shellEscape(gitUser.name)}'`)
  execSync(`podman exec ${containerName} git config --global user.email '${shellEscape(gitUser.email)}'`)

  // Run init commands (e.g., pnpm install against warm cache volumes)
  if (config.initCommands?.length) {
    console.log('Running init commands...')
    for (const cmd of config.initCommands) {
      execSync(`podman exec ${containerName} sh -c '${shellEscape(cmd)}'`, {
        stdio: 'inherit',
        timeout: 300_000,
      })
    }
  }

  // Start Claude Code in a tmux session
  const claudeCmd = options.prompt
    ? `claude --dangerously-skip-permissions --session-id ${sessionId} -p ${shellEscape(options.prompt)}`
    : `claude --dangerously-skip-permissions --session-id ${sessionId}`
  console.log('Starting Claude Code...')
  execSync(`podman exec ${containerName} tmux -u new-session -d -s claude '${claudeCmd}'`, {
    stdio: 'pipe',
  })

  // Configure tmux UX
  execSync(`podman exec ${containerName} tmux set-option -t claude mouse on`)
  execSync(`podman exec ${containerName} tmux set-option -t claude status-right ' ${projectSlug} ${sessionId.slice(0, 8)} '`)
  execSync(`podman exec ${containerName} tmux set-option -t claude status-right-length 50`)

  // Attach the user to the tmux session
  execSync(`podman exec -it ${containerName} tmux attach-session -t claude`, {
    stdio: 'inherit',
  })

  // Auto-cleanup if Claude Code exited (tmux session died)
  if (!isTmuxSessionAlive(containerName)) {
    console.log('Claude Code exited. Cleaning up session...')
    await cleanupSession({ containerName, projectSlug, sessionId })
  }
}
