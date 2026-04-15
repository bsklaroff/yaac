import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import readline from 'node:readline/promises'
import { spawn, execSync } from 'node:child_process'
import simpleGit from 'simple-git'
import { ensureContainerRuntime, podman } from '@/lib/container/runtime'
import { ensureImage, packTar } from '@/lib/container/image-builder'
import { proxyClient, buildRulesFromConfig } from '@/lib/container/proxy-client'
import { resolveAllowedHosts } from '@/lib/container/default-allowed-hosts'
import type { InjectionRule } from '@/lib/container/proxy-client'
import { reserveAvailablePort, startPortForwarders, podmanRelay } from '@/lib/container/port'
import type { ReservedPort } from '@/lib/container/port'
import { pgRelay } from '@/lib/container/pg-relay'
import { repoDir, claudeDir, claudeJsonFile, codexDir, codexTranscriptDir, worktreeDir, worktreesDir, projectDir, getDataDir } from '@/lib/project/paths'
import { resolveProjectConfig } from '@/lib/project/config'
import { resolveTokenForUrl } from '@/lib/project/credentials'
import { addWorktree, getDefaultBranch, fetchOrigin, getGitUserConfig } from '@/lib/git'
import { isTmuxSessionAlive, cleanupSessionDetached } from '@/lib/session/cleanup'
import { claimPrewarmSession } from '@/lib/prewarm'
import { ensureCodexHooksJson, ensureCodexConfigToml } from '@/lib/session/codex-hooks'
import type { YaacConfig, AgentTool } from '@/types'

export function shellEscape(str: string): string {
  return str.replace(/'/g, "'\\''")
}

function containerExec(containerName: string, cmd: string): void {
  execSync(`podman exec ${containerName} ${cmd}`, { stdio: 'pipe' })
}

function containerExecRoot(containerName: string, cmd: string): void {
  execSync(`podman exec --user root ${containerName} ${cmd}`, { stdio: 'pipe' })
}

export interface SessionCreateOptions {
  prompt?: string
  addDir?: string[]
  addDirRw?: string[]
  createPrewarm?: boolean
  /** Pre-generated session ID (used by prewarm to know the container name upfront). */
  sessionId?: string
  /** Agent tool to run inside the container (default: 'claude'). */
  tool?: AgentTool
}

interface ContainerSetupParams {
  imageName: string
  containerName: string
  projectSlug: string
  sessionId: string
  env: string[]
  wtDir: string
  repo: string
  claude: string
  claudeJson: string
  codex: string
  tool: AgentTool
  config: YaacConfig
  options: SessionCreateOptions
  networkMode: string
  pgRelayIp: string | null
  gitUser: { name: string; email: string }
  forwardedPorts: ReservedPort[]
}

async function startContainerWithSetup(params: ContainerSetupParams): Promise<void> {
  const {
    imageName, containerName, projectSlug, sessionId, env,
    wtDir, repo, claude, claudeJson, codex, tool, config, options,
    networkMode, pgRelayIp, gitUser, forwardedPorts,
  } = params

  const container = await podman.createContainer({
    Image: imageName,
    name: containerName,
    Labels: {
      'yaac.project': projectSlug,
      'yaac.session-id': sessionId,
      'yaac.data-dir': getDataDir(),
      'yaac.proxy-container': proxyClient.containerName,
      'yaac.tool': tool,
    },
    Env: env,
    HostConfig: {
      Binds: [
        `${wtDir}:/workspace:Z`,
        `${repo}/.git:/repo/.git:Z`,
        ...(tool === 'claude' ? [
          `${claude}:/home/yaac/.claude:Z`,
          `${claudeJson}:/home/yaac/.claude.json:Z`,
        ] : [
          `${codex}:/home/yaac/.codex:Z`,
        ]),
        ...Object.entries(config.cacheVolumes ?? {}).map(
          ([key, containerPath]) => `yaac-cache-${projectSlug}-${key}:${containerPath}:Z`,
        ),
        ...(config.bindMounts ?? []).map(
          ({ hostPath, containerPath, mode }) => `${hostPath}:${containerPath}:${mode},Z`,
        ),
        ...(options.addDir ?? []).map(
          (p) => `${p}:/add-dir${p}:ro,Z`,
        ),
        ...(options.addDirRw ?? []).map(
          (p) => `${p}:/add-dir${p}:rw,Z`,
        ),
        ...(config.nestedContainers
          ? [`yaac-podmanstorage-${projectSlug}:/home/yaac/.local/share/containers:Z`]
          : []),
      ],
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

  // Forward localhost:<pgPort> inside the container to the pg-relay sidecar (IPv4 + IPv6)
  if (pgRelayIp) {
    execSync(`podman exec -d --user root ${containerName} socat TCP4-LISTEN:${pgRelay.containerPort},fork,reuseaddr,bind=127.0.0.1 TCP:${pgRelayIp}:${pgRelay.containerPort}`, { stdio: 'pipe' })
    execSync(`podman exec -d --user root ${containerName} socat TCP6-LISTEN:${pgRelay.containerPort},fork,reuseaddr,bind=::1 TCP:${pgRelayIp}:${pgRelay.containerPort}`, { stdio: 'pipe' })
  }

  // Fix ownership of podman storage volume and start API socket for nested containers
  if (config.nestedContainers) {
    containerExecRoot(containerName, 'chown yaac:yaac /home/yaac/.local/share/containers')
    execSync(`podman exec -d ${containerName} podman system service --time=0 unix:///run/user/1000/podman/podman.sock`, {
      stdio: 'pipe',
    })
  }

  // Inject CA cert for HTTPS MITM (proxy is always active)
  const caCert = await proxyClient.getCaCert()
  const archive = await packTar([{ name: 'proxy-ca.pem', content: caCert }])
  const containerRef = podman.getContainer(containerName)
  await containerRef.putArchive(archive, { path: '/tmp' })

  // Fix worktree git pointers for in-container paths
  containerExec(containerName, `sh -c "echo 'gitdir: /repo/.git/worktrees/${sessionId}' > /workspace/.git"`)
  containerExec(containerName, `sh -c "echo '/workspace/.git' > /repo/.git/worktrees/${sessionId}/gitdir"`)

  // Configure git identity and trust mounted directories inside container
  containerExec(containerName, `git config --global user.name '${shellEscape(gitUser.name)}'`)
  containerExec(containerName, `git config --global user.email '${shellEscape(gitUser.email)}'`)
  containerExec(containerName, 'git config --global --add safe.directory /workspace')
  containerExec(containerName, 'git config --global --add safe.directory /repo')

  // Rewrite any SSH-style GitHub URLs to HTTPS (handled by the proxy)
  containerExec(containerName, `git config --global url.'https://github.com/'.insteadOf 'git@github.com:'`)

  // Start the agent tool in a tmux session
  const addDirFlags = [...(options.addDir ?? []), ...(options.addDirRw ?? [])]
    .map((p) => `--add-dir /add-dir${shellEscape(p)}`)
    .join(' ')

  let agentCmd: string
  if (tool === 'codex') {
    agentCmd = [
      'codex --full-auto',
      addDirFlags,
      options.prompt ? `-p ${shellEscape(options.prompt)}` : '',
    ].filter(Boolean).join(' ')
  } else {
    agentCmd = [
      'claude --dangerously-skip-permissions',
      `--session-id ${sessionId}`,
      addDirFlags,
      options.prompt ? `-p ${shellEscape(options.prompt)}` : '',
    ].filter(Boolean).join(' ')
  }
  const toolLabel = tool === 'codex' ? 'Codex' : 'Claude Code'
  console.log(`Starting ${toolLabel}...`)
  containerExec(containerName, `tmux -u new-session -d -s yaac -n ${tool} '${agentCmd}'`)

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
  containerExec(containerName, 'tmux set-option -g focus-events on')
  containerExec(containerName, `tmux set-option -t yaac status-right ' ${projectSlug} ${sessionId.slice(0, 8)}${portInfo} '`)
  containerExec(containerName, 'tmux set-option -t yaac status-right-length 80')
  containerExec(containerName, 'tmux bind-key k kill-server')
}

export async function sessionCreate(projectSlug: string, options: SessionCreateOptions): Promise<string | undefined> {
  // Verify project exists
  try {
    await fs.access(projectDir(projectSlug))
  } catch {
    console.error(`Project "${projectSlug}" not found. Run "yaac project list" to see available projects.`)
    process.exitCode = 1
    return
  }

  // Validate --add-dir / --add-dir-rw paths
  for (const dirPath of [...(options.addDir ?? []), ...(options.addDirRw ?? [])]) {
    if (!path.isAbsolute(dirPath)) {
      console.error(`--add-dir path must be absolute: "${dirPath}"`)
      process.exitCode = 1
      return
    }
    try {
      await fs.access(dirPath)
    } catch {
      console.error(`--add-dir path not found: "${dirPath}"`)
      process.exitCode = 1
      return
    }
  }

  // Try to claim a prewarmed session — it already has everything set up.
  // Skip when createPrewarm is true (prewarm creation path itself).
  // claimPrewarmSession checks that the requested tool matches the prewarmed tool.
  const tool: AgentTool = options.tool ?? 'claude'
  const claimed = !options.createPrewarm ? await claimPrewarmSession(projectSlug, tool) : null
  if (claimed) {
    console.log(`Claiming prewarmed session ${claimed.sessionId.slice(0, 8)}...`)

    // Start host-side port forwarders would go here if the prewarmed session
    // had port forwarding, but for now we just attach directly.
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('podman', ['exec', '-it', claimed.containerName, 'tmux', 'attach-session', '-t', 'yaac'], {
          stdio: 'inherit',
        })
        child.on('close', () => resolve())
        child.on('error', reject)
      })
    } catch {
      // Container or tmux session was killed
    }

    if (!isTmuxSessionAlive(claimed.containerName)) {
      console.log('Claude Code exited. Cleaning up session...')
      cleanupSessionDetached({ containerName: claimed.containerName, projectSlug, sessionId: claimed.sessionId })
    }

    return claimed.sessionId
  }

  await ensureContainerRuntime()

  // Ensure git user identity is configured (needed for commits inside container)
  let gitUser = await getGitUserConfig()
  if (gitUser) {
    console.log(`Git identity: ${gitUser.name} <${gitUser.email}>`)
  } else if (options.createPrewarm) {
    console.error('Git user.name and user.email must be configured globally for non-interactive session creation.')
    process.exitCode = 1
    return
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

  // Resolve the correct GitHub token for this project's remote URL
  const remoteUrl = (await simpleGit(repo).remote(['get-url', 'origin']))?.trim()
  if (!remoteUrl) {
    console.error('Error: could not determine remote URL for this project.')
    process.exitCode = 1
    return
  }
  const githubToken = await resolveTokenForUrl(remoteUrl)
  if (!githubToken) {
    console.error(`No GitHub token configured for ${remoteUrl}. Run "yaac auth update" to add one.`)
    process.exitCode = 1
    return
  }
  console.log('Fetching latest from remote...')
  try {
    await fetchOrigin(repo, githubToken)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Error: could not fetch from remote: ${msg}`)
    process.exitCode = 1
    return
  }

  console.log('Ensuring container images are built...')
  const imageName = await ensureImage(projectSlug, undefined, false, config.nestedContainers ?? false)

  const sessionId = options.sessionId ?? crypto.randomUUID()
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

  // YAAC session ID — used by the Codex SessionStart hook to record the transcript path
  env.push(`YAAC_SESSION_ID=${sessionId}`)

  // Passthrough env vars
  if (config.envPassthrough) {
    for (const name of config.envPassthrough) {
      const val = process.env[name]
      if (val !== undefined) {
        env.push(`${name}=${val}`)
      }
    }
  }

  // Proxy is always required — injects GITHUB_TOKEN for all GitHub HTTPS requests
  console.log('Starting proxy sidecar...')
  await proxyClient.ensureRunning()

  // Build GitHub token injection rules — git smart HTTP requires Basic auth
  const gitBasicAuth = `Basic ${Buffer.from(`x-access-token:${githubToken}`).toString('base64')}`
  const githubRules: InjectionRule[] = [
    {
      hostPattern: 'github.com',
      pathPattern: '/*',
      injections: [{ action: 'set_header', name: 'authorization', value: gitBasicAuth }],
    },
    {
      hostPattern: 'api.github.com',
      pathPattern: '/*',
      injections: [{ action: 'set_header', name: 'authorization', value: gitBasicAuth }],
    },
  ]

  // Merge with any additional envSecretProxy rules from config
  const additionalRules = config.envSecretProxy
    ? buildRulesFromConfig(config.envSecretProxy, process.env)
    : []
  const allowedHosts = resolveAllowedHosts(config)
  await proxyClient.updateProjectRules(projectSlug, [...githubRules, ...additionalRules], allowedHosts)

  await proxyClient.registerSession(sessionId, projectSlug)

  // Add proxy env vars
  env.push(...proxyClient.getProxyEnv(sessionId))

  // Add placeholder values for proxied secrets so tools detect them
  if (config.envSecretProxy) {
    for (const name of Object.keys(config.envSecretProxy)) {
      if (process.env[name]) {
        env.push(`${name}=placeholder`)
      }
    }
  }

  const networkMode = proxyClient.network

  // Port forwarding setup — reserve ports immediately so a concurrent session
  // cannot claim the same host port between discovery and actual use.
  const forwardedPorts: ReservedPort[] = []
  if (config.portForward?.length) {
    for (const { containerPort, hostPortStart } of config.portForward) {
      console.log(`Finding available host port starting from ${hostPortStart} for container port ${containerPort}...`)
      const reserved = await reserveAvailablePort(containerPort, hostPortStart)
      forwardedPorts.push(reserved)
      console.log(`Forwarding host port ${reserved.hostPort} -> container port ${containerPort}`)
    }
  }

  // PostgreSQL relay setup
  const pgConfig = config.pgRelay
  const pgEnabled = !!(pgConfig && pgConfig.enabled)
  let pgRelayIp: string | null = null

  if (pgEnabled) {
    console.log('Starting PostgreSQL relay sidecar...')
    await pgRelay.ensureRunning(pgConfig)
    pgRelayIp = pgRelay.ip
  }


  const containerName = `yaac-${projectSlug}-${sessionId}`
  const claude = claudeDir(projectSlug)
  const claudeJson = claudeJsonFile(projectSlug)
  const codex = codexDir(projectSlug)

  if (tool === 'claude') {
    // Ensure claude.json exists so Podman mounts it as a file, not a directory
    try {
      await fs.access(claudeJson)
    } catch {
      await fs.writeFile(claudeJson, '{}')
    }
  } else {
    // Ensure codex dir and transcript symlink dir exist
    const transcriptDir = codexTranscriptDir(projectSlug)
    await fs.mkdir(transcriptDir, { recursive: true })

    // Write a SessionStart hook that symlinks the transcript into a
    // directory keyed by YAAC session ID, so yaac can read it directly.
    const codex_ = codexDir(projectSlug)
    const hookScript = path.join(codex_, '.yaac-hook.sh')
    await fs.writeFile(hookScript, [
      '#!/bin/sh',
      '# Reads JSON from stdin (Codex SessionStart hook) and symlinks the',
      '# transcript so yaac can find the right JSONL for this session.',
      '# Uses a relative symlink so it resolves on both host and container.',
      'INPUT=$(cat)',
      'TRANSCRIPT=$(echo "$INPUT" | sed -n \'s/.*"transcript_path"\\s*:\\s*"\\([^"]*\\)".*/\\1/p\')',
      'if [ -n "$TRANSCRIPT" ] && [ -n "$YAAC_SESSION_ID" ]; then',
      '  LINK_DIR=/home/yaac/.codex/.yaac-transcripts',
      '  mkdir -p "$LINK_DIR"',
      '  REL=$(python3 -c "import os.path; print(os.path.relpath(\'$TRANSCRIPT\', \'$LINK_DIR\'))")',
      '  ln -sf "$REL" "$LINK_DIR/$YAAC_SESSION_ID.jsonl"',
      'fi',
    ].join('\n') + '\n')
    await fs.chmod(hookScript, 0o755)

    await ensureCodexHooksJson(codex_)
    await ensureCodexConfigToml(codex_)
  }

  // Retry the entire container create + setup so that if the container dies
  // immediately after creation we start fresh instead of futilely retrying
  // individual exec calls against a dead container.
  const maxStartAttempts = 3
  const setupParams: ContainerSetupParams = {
    imageName, containerName, projectSlug, sessionId, env,
    wtDir, repo, claude, claudeJson, codex, tool, config, options,
    networkMode, pgRelayIp, gitUser, forwardedPorts,
  }

  console.log(`Creating container ${containerName}...`)

  for (let attempt = 1; attempt <= maxStartAttempts; attempt++) {
    try {
      await startContainerWithSetup(setupParams)
      break
    } catch (err) {
      if (attempt < maxStartAttempts) {
        console.warn(`Container startup failed (attempt ${attempt}/${maxStartAttempts}), retrying...`)
        try { execSync(`podman rm -f ${containerName}`, { stdio: 'pipe' }) } catch { /* already gone */ }
        continue
      }
      throw err
    }
  }

  if (options.createPrewarm) {
    return sessionId
  }

  // Start host-side port forwarders that relay into the container via
  // `podman exec nc`.  This connects to localhost inside the container so the
  // target service can listen on any address (IPv4 or IPv6, including loopback).
  let stopPortForwarders: (() => void) | null = null
  if (forwardedPorts.length > 0) {
    stopPortForwarders = startPortForwarders(
      podmanRelay(containerName),
      forwardedPorts,
    )
  }

  // Attach the user to the tmux session.
  // Use spawn (not execSync) so the Node.js event loop remains free to
  // process TCP connections for port forwarding.
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('podman', ['exec', '-it', containerName, 'tmux', 'attach-session', '-t', 'yaac'], {
        stdio: 'inherit',
      })
      child.on('close', () => resolve())
      child.on('error', reject)
    })
  } catch {
    // Container or tmux session was killed (e.g. ctrl-b k) — fall through to cleanup
  } finally {
    stopPortForwarders?.()
  }

  // Auto-cleanup if Claude Code exited (tmux session died)
  if (!isTmuxSessionAlive(containerName)) {
    const toolLabel = tool === 'codex' ? 'Codex' : 'Claude Code'
    console.log(`${toolLabel} exited. Cleaning up session...`)
    cleanupSessionDetached({ containerName, projectSlug, sessionId })
  }

  return sessionId
}
