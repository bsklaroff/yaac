import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import readline from 'node:readline/promises'
import { execSyncRetry } from '@/lib/exec'
import { packTar } from '@/lib/tar-utils'
import simpleGit from 'simple-git'
import { ensureContainerRuntime, podman } from '@/lib/podman'
import { ensureImage } from '@/lib/image-builder'
import { repoDir, claudeDir, claudeJsonFile, worktreeDir, worktreesDir, projectDir, getDataDir } from '@/lib/paths'
import { addWorktree, getDefaultBranch, fetchOrigin, getGitUserConfig } from '@/lib/git'
import { resolveProjectConfig } from '@/lib/config'
import { buildRulesFromConfig } from '@/lib/secret-conventions'
import { isTmuxSessionAlive, cleanupSessionDetached } from '@/lib/session-cleanup'
import { proxyClient, INTERNAL_PORT } from '@/lib/proxy-client'
import { sshAgent, hasSshKeys } from '@/lib/ssh-agent'
import { findAvailablePort } from '@/lib/port'
import type { YaacConfig } from '@/types'

export function shellEscape(str: string): string {
  return str.replace(/'/g, "'\\''")
}

const podmanRetryPatterns = ['container state improper']

function containerExec(containerName: string, cmd: string): void {
  execSyncRetry(`podman exec ${containerName} ${cmd}`, {
    stdio: 'pipe', retryPatterns: podmanRetryPatterns,
  })
}

function containerExecRoot(containerName: string, cmd: string): void {
  execSyncRetry(`podman exec --user root ${containerName} ${cmd}`, {
    stdio: 'pipe', retryPatterns: podmanRetryPatterns,
  })
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

  // Load project config (local override at ~/.yaac/projects/<slug>/ takes precedence)
  const config: YaacConfig = await resolveProjectConfig(projectSlug) ?? {}

  // Fetch latest from remote before building images
  console.log('Fetching latest from remote...')
  try {
    await fetchOrigin(repo)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Error: could not fetch from remote: ${msg}`)
    process.exitCode = 1
    return
  }

  console.log('Ensuring container images are built...')
  const imageName = await ensureImage(projectSlug, undefined, false, config.nestedContainers ?? false)

  const sessionId = crypto.randomUUID()
  const wtDir = worktreeDir(projectSlug, sessionId)

  // Create worktree
  await fs.mkdir(worktreesDir(projectSlug), { recursive: true })
  const defaultBranch = await getDefaultBranch(repo)
  console.log(`Creating worktree from ${defaultBranch}...`)
  await addWorktree(repo, wtDir, `yaac/${sessionId}`, `origin/${defaultBranch}`)

  // Fetch the image's baked-in ENV so we can preserve it.
  // The container-create API's Env field *replaces* the image ENV rather
  // than merging, so we start from the image's values and let explicit
  // overrides win.
  const imageInfo = await podman.getImage(imageName).inspect()
  const imageEnv: string[] = (imageInfo.Config?.Env as string[] | undefined) ?? []

  // Build container env — start with image defaults
  const env: string[] = [...imageEnv]

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

  // Port forwarding setup
  const forwardedPorts: Array<{ containerPort: number; hostPort: number }> = []
  if (config.portForward?.length) {
    for (const { containerPort, hostPortStart } of config.portForward) {
      console.log(`Finding available host port starting from ${hostPortStart} for container port ${containerPort}...`)
      const hostPort = await findAvailablePort(hostPortStart)
      forwardedPorts.push({ containerPort, hostPort })
      console.log(`Forwarding host port ${hostPort} -> container port ${containerPort}`)
    }
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
  const portBindings: Record<string, Array<{ HostPort: string; HostIp: string }>> = {}
  const exposedPorts: Record<string, Record<string, never>> = {}
  for (const { containerPort, hostPort } of forwardedPorts) {
    const portKey = `${containerPort}/tcp`
    exposedPorts[portKey] = {}
    portBindings[portKey] = [{ HostPort: String(hostPort), HostIp: '127.0.0.1' }]
  }

  const container = await podman.createContainer({
    Image: imageName,
    name: containerName,
    Labels: {
      'yaac.project': projectSlug,
      'yaac.session-id': sessionId,
      'yaac.data-dir': getDataDir(),
    },
    ExposedPorts: exposedPorts,
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
        ...(config.bindMounts ?? []).map(
          ({ hostPath, containerPath, readonly: ro }) => `${hostPath}:${containerPath}:${ro ? 'ro' : 'rw'},Z`,
        ),
        ...(config.nestedContainers
          ? [`yaac-podmanstorage-${projectSlug}:/home/yaac/.local/share/containers:Z`]
          : []),
      ],
      PortBindings: portBindings,
      NetworkMode: networkMode,
      ...(config.nestedContainers ? {
        SecurityOpt: ['label=disable', 'unmask=/proc/sys'],
        Devices: [{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }],
      } : {}),
    },
  })

  await container.start()

  // Fix ownership of named cache volumes (created as root, but container runs as yaac)
  for (const containerPath of Object.values(config.cacheVolumes ?? {})) {
    containerExecRoot(containerName, `chown yaac:yaac '${shellEscape(containerPath)}'`)
  }

  // Fix ownership of podman storage volume and start API socket for nested containers
  if (config.nestedContainers) {
    containerExecRoot(containerName, 'chown yaac:yaac /home/yaac/.local/share/containers')
    execSyncRetry(`podman exec -d ${containerName} podman system service --time=0 unix:///run/user/1000/podman/podman.sock`, {
      stdio: 'pipe', retryPatterns: podmanRetryPatterns,
    })
  }

  // Inject CA cert and SSH proxy config if using proxy
  if (hasSecretProxy) {
    const caCert = await proxyClient.getCaCert()
    const archive = await packTar([{ name: 'proxy-ca.pem', content: caCert }])
    const container = podman.getContainer(containerName)
    await container.putArchive(archive, { path: '/tmp' })

    // Configure SSH to tunnel through the proxy via HTTP CONNECT
    const proxyAddr = `${proxyClient.proxyIp}:${INTERNAL_PORT}`
    containerExec(containerName, 'mkdir -p /home/yaac/.ssh')
    containerExec(containerName, `sh -c "cat > /home/yaac/.ssh/config << 'SSHEOF'\nHost *\n    ProxyCommand nc -X connect -x ${proxyAddr} %h %p\nSSHEOF"`)
    containerExec(containerName, 'chmod 700 /home/yaac/.ssh')
    containerExec(containerName, 'chmod 600 /home/yaac/.ssh/config')
  }

  // Fix worktree git pointers for in-container paths
  containerExec(containerName, `sh -c "echo 'gitdir: /repo/.git/worktrees/${sessionId}' > /workspace/.git"`)
  containerExec(containerName, `sh -c "echo '/workspace/.git' > /repo/.git/worktrees/${sessionId}/gitdir"`)

  // Configure git identity and trust mounted directories inside container
  containerExec(containerName, `git config --global user.name '${shellEscape(gitUser.name)}'`)
  containerExec(containerName, `git config --global user.email '${shellEscape(gitUser.email)}'`)
  containerExec(containerName, 'git config --global --add safe.directory /workspace')
  containerExec(containerName, 'git config --global --add safe.directory /repo')

  // Start Claude Code in a tmux session
  const claudeCmd = options.prompt
    ? `claude --dangerously-skip-permissions --session-id ${sessionId} -p ${shellEscape(options.prompt)}`
    : `claude --dangerously-skip-permissions --session-id ${sessionId}`
  console.log('Starting Claude Code...')
  containerExec(containerName, `tmux -u new-session -d -s yaac -n claude '${claudeCmd}'`)

  // Run init commands in a background tmux window (parallel to Claude Code)
  if (config.initCommands?.length) {
    const initScript = config.initCommands
      .map((cmd) => shellEscape(cmd))
      .join(' && ')
    containerExec(containerName, `tmux new-window -d -t yaac -n init 'cd /workspace && ${initScript}'`)
    if (!config.hideInitPane) {
      containerExec(containerName, 'tmux set-option -t yaac:init remain-on-exit on')
    }
  }

  // Configure tmux UX
  const portInfo = forwardedPorts.length > 0
    ? ' ' + forwardedPorts.map((p) => `:${p.hostPort}->${p.containerPort}`).join(' ')
    : ''
  containerExec(containerName, 'tmux set-option -g history-limit 200000')
  containerExec(containerName, 'tmux set-option -g mouse on')
  containerExec(containerName, `tmux set-option -t yaac status-right ' ${projectSlug} ${sessionId.slice(0, 8)}${portInfo} '`)
  containerExec(containerName, 'tmux set-option -t yaac status-right-length 80')
  containerExec(containerName, 'tmux bind-key k kill-server')

  // Attach the user to the tmux session
  try {
    execSyncRetry(`podman exec -it ${containerName} tmux attach-session -t yaac`, {
      stdio: 'inherit', retryPatterns: podmanRetryPatterns,
    })
  } catch {
    // Container or tmux session was killed (e.g. ctrl-b k) — fall through to cleanup
  }

  // Auto-cleanup if Claude Code exited (tmux session died)
  if (!isTmuxSessionAlive(containerName)) {
    console.log('Claude Code exited. Cleaning up session...')
    cleanupSessionDetached({ containerName, projectSlug, sessionId })
  }
}
