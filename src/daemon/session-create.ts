import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import simpleGit from 'simple-git'
import { ensureContainerRuntime, podman, shellPodmanWithRetry } from '@/lib/container/runtime'
import { ensureImage, packTar } from '@/lib/container/image-builder'
import {
  ensureNestedStorageVolumes,
  sessionGraphrootVolumeName,
  projectImageCacheVolumeName,
  SHARED_IMAGE_STORE_PATH,
} from '@/lib/container/image-promoter'
import { proxyClient, buildRulesFromConfig } from '@/lib/container/proxy-client'
import type { UpstreamRedirect } from '@/lib/container/proxy-client'
import { resolveAllowedHosts } from '@/lib/container/default-allowed-hosts'
import { reserveAvailablePort, startPortForwarders, podmanRelay } from '@/lib/container/port'
import type { ReservedPort } from '@/lib/container/port'
import { pgRelay } from '@/lib/container/pg-relay'
import {
  repoDir,
  claudeDir,
  claudeJsonFile,
  codexDir,
  codexTranscriptDir,
  cachedPackagesDir,
  worktreeDir,
  worktreesDir,
  projectDir,
  getDataDir,
} from '@/lib/project/paths'
import { resolveProjectConfig } from '@/lib/project/config'
import { resolveTokenForUrl } from '@/lib/project/credentials'
import {
  loadToolAuthEntry,
  loadClaudeCredentialsFile,
  loadCodexCredentialsFile,
  writeProjectClaudePlaceholder,
  writeProjectCodexPlaceholder,
} from '@/lib/project/tool-auth'
import { addWorktree, getDefaultBranch, fetchOrigin, getGitUserConfig } from '@/lib/git'
import { claimPrewarmSession } from '@/lib/prewarm'
import { ensureCodexHooksJson, ensureCodexConfigToml } from '@/lib/session/codex-hooks'
import { DaemonError } from '@/daemon/errors'
import {
  buildStatusRight,
  provisionSessionForwarders,
  registerSessionForwarders,
} from '@/lib/session/port-forwarders'
import type { AgentTool, PortMapping, YaacConfig } from '@/shared/types'

export function shellEscape(str: string): string {
  return str.replace(/'/g, "'\\''")
}

/**
 * Parse the `YAAC_E2E_UPSTREAM_REDIRECTS` env var into a redirect map for the
 * proxy. Test-only — lets e2e-cli tests rewire `api.anthropic.com` etc. to a
 * mock container without adding user-facing config. Expects a JSON object
 * keyed by hostname with values `{host, port, tls?}`. Returns undefined when
 * the env var is unset, empty, or unparseable.
 */
export function parseUpstreamRedirectsEnv(
  raw: string | undefined,
): Record<string, UpstreamRedirect> | undefined {
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object') return undefined
  const result: Record<string, UpstreamRedirect> = {}
  for (const [host, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (!val || typeof val !== 'object') continue
    const v = val as Record<string, unknown>
    if (typeof v.host !== 'string' || typeof v.port !== 'number') continue
    result[host] = {
      host: v.host,
      port: v.port,
      tls: typeof v.tls === 'boolean' ? v.tls : undefined,
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function emit(message: string, options: SessionCreateOptions): void {
  console.log(message)
  options.onProgress?.(message)
}

export function buildAgentCmd(
  tool: AgentTool,
  sessionId: string,
  addDirFlags: string,
): string {
  if (tool === 'codex') {
    return [
      'codex --yolo',
      addDirFlags,
    ].filter(Boolean).join(' ')
  }
  return [
    'claude --dangerously-skip-permissions',
    `--session-id ${sessionId}`,
    addDirFlags,
  ].filter(Boolean).join(' ')
}

async function containerExec(containerName: string, cmd: string): Promise<void> {
  await shellPodmanWithRetry(`podman exec ${containerName} ${cmd}`)
}

async function containerExecRoot(containerName: string, cmd: string): Promise<void> {
  await shellPodmanWithRetry(`podman exec --user root ${containerName} ${cmd}`)
}

export interface SessionCreateOptions {
  addDir?: string[]
  addDirRw?: string[]
  createPrewarm?: boolean
  /** Pre-generated session ID (used by prewarm to know the container name upfront). */
  sessionId?: string
  /** Agent tool to run inside the container (default: 'claude'). */
  tool?: AgentTool
  /**
   * Git identity to use inside the container. The CLI resolves this
   * up-front (prompting when missing) and passes it in.
   */
  gitUser?: { name: string; email: string }
  /**
   * Called for each user-visible progress message during provisioning.
   * The HTTP route forwards these to the CLI as NDJSON events so
   * `yaac session create` can show what the daemon is doing. Prewarm
   * and stream-picker callers omit this.
   */
  onProgress?: (message: string) => void
}

export interface SessionCreateResult {
  sessionId?: string
  containerName?: string
  forwardedPorts?: PortMapping[]
  tool?: AgentTool
  claimedPrewarm?: boolean
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
  cachedPackages: string
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
    wtDir, repo, claude, claudeJson, codex, cachedPackages, tool, config, options,
    networkMode, pgRelayIp, gitUser, forwardedPorts,
  } = params

  // Pre-create the per-session graphroot and project image-cache volumes
  // with identifying labels so orphan GC can distinguish them from other
  // yaac installs' volumes. Auto-created-on-mount volumes would be unlabeled.
  if (config.nestedContainers) {
    await ensureNestedStorageVolumes(projectSlug, sessionId)
  }

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
        `${claude}:/home/yaac/.claude:Z`,
        `${claudeJson}:/home/yaac/.claude.json:Z`,
        `${codex}:/home/yaac/.codex:Z`,
        `${cachedPackages}:/home/yaac/.cached-packages:Z`,
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
          ? [
              `${sessionGraphrootVolumeName(sessionId)}:/home/yaac/.local/share/containers:Z`,
              `${projectImageCacheVolumeName(projectSlug)}:${SHARED_IMAGE_STORE_PATH}:ro,Z`,
            ]
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
    await containerExecRoot(containerName, `chown yaac:yaac '${shellEscape(containerPath)}'`)
  }

  // Forward localhost:<pgPort> inside the container to the pg-relay sidecar (IPv4 + IPv6)
  if (pgRelayIp) {
    await shellPodmanWithRetry(`podman exec -d --user root ${containerName} socat TCP4-LISTEN:${pgRelay.containerPort},fork,reuseaddr,bind=127.0.0.1 TCP:${pgRelayIp}:${pgRelay.containerPort}`)
    await shellPodmanWithRetry(`podman exec -d --user root ${containerName} socat TCP6-LISTEN:${pgRelay.containerPort},fork,reuseaddr,bind=::1 TCP:${pgRelayIp}:${pgRelay.containerPort}`)
  }

  // Fix ownership of podman storage volume and start API socket for nested containers
  if (config.nestedContainers) {
    await containerExecRoot(containerName, 'chown yaac:yaac /home/yaac/.local/share/containers')
    await shellPodmanWithRetry(`podman exec -d ${containerName} podman system service --time=0 unix:///run/user/1000/podman/podman.sock`)
  }

  // Inject CA cert for HTTPS MITM (proxy is always active)
  const caCert = await proxyClient.getCaCert()
  const archive = await packTar([{ name: 'proxy-ca.pem', content: caCert }])
  const containerRef = podman.getContainer(containerName)
  await containerRef.putArchive(archive, { path: '/tmp' })

  // Fix worktree git pointers for in-container paths
  await containerExec(containerName, `sh -c "echo 'gitdir: /repo/.git/worktrees/${sessionId}' > /workspace/.git"`)
  await containerExec(containerName, `sh -c "echo '/workspace/.git' > /repo/.git/worktrees/${sessionId}/gitdir"`)

  // Configure git identity and trust mounted directories inside container
  await containerExec(containerName, `git config --global user.name '${shellEscape(gitUser.name)}'`)
  await containerExec(containerName, `git config --global user.email '${shellEscape(gitUser.email)}'`)
  await containerExec(containerName, 'git config --global --add safe.directory /workspace')
  await containerExec(containerName, 'git config --global --add safe.directory /repo')

  // Rewrite any SSH-style GitHub URLs to HTTPS (handled by the proxy)
  await containerExec(containerName, `git config --global url.'https://github.com/'.insteadOf 'git@github.com:'`)

  // Start the agent tool in a tmux session
  const addDirFlags = [...(options.addDir ?? []), ...(options.addDirRw ?? [])]
    .map((p) => `--add-dir /add-dir${shellEscape(p)}`)
    .join(' ')

  const agentCmd = buildAgentCmd(tool, sessionId, addDirFlags)
  const toolLabel = tool === 'codex' ? 'Codex' : 'Claude Code'
  emit(`Starting ${toolLabel}...`, options)
  await containerExec(containerName, `tmux -u new-session -d -s yaac -n ${tool} '${agentCmd}'`)

  // Run init commands in a background tmux window (parallel to Claude Code)
  if (config.initCommands?.length) {
    const initScript = config.initCommands
      .map((cmd) => shellEscape(cmd))
      .join(' && ')
    await containerExec(containerName, `tmux new-window -d -t yaac -n init 'cd /workspace && ${initScript}'`)
    if (!config.hideInitPane) {
      await containerExec(containerName, 'tmux set-option -t yaac:init remain-on-exit on')
    }
  }

  // Configure tmux UX
  await containerExec(containerName, 'tmux set-option -g history-limit 200000')
  await containerExec(containerName, 'tmux set-option -g mouse on')
  await containerExec(containerName, 'tmux set-option -g focus-events on')
  // Propagate terminal bells (\a) from any window through to the attached
  // client so the user's terminal emulator can surface notifications.
  await containerExec(containerName, 'tmux set-option -g monitor-bell on')
  await containerExec(containerName, 'tmux set-option -g bell-action any')
  await containerExec(containerName, 'tmux set-option -g visual-bell off')
  await containerExec(containerName, 'tmux set-option -g allow-passthrough on')
  await containerExec(containerName, 'tmux set-option -t yaac status-right-length 80')
  // Prewarm containers skip the status-right write: the claim path's
  // setSessionStatusRight races with this call, and since prewarm
  // forwardedPorts is always empty, an unlucky ordering would clobber the
  // claim's real port info with a no-ports string.
  if (!options.createPrewarm) {
    const statusRight = buildStatusRight(projectSlug, sessionId, forwardedPorts)
    await containerExec(containerName, `tmux set-option -t yaac status-right '${shellEscape(statusRight)}'`)
  }
  await containerExec(containerName, 'tmux bind-key k kill-server')
}

/**
 * Server-side implementation of `/session/create`. Provisions the
 * worktree, proxy rules, container, and port forwarders — all
 * long-lived resources that the daemon owns for the session's
 * lifetime. The CLI only prompts for git identity and then attaches
 * the user's terminal to the resulting tmux session.
 */
export async function createSession(
  projectSlug: string,
  options: SessionCreateOptions,
): Promise<SessionCreateResult | undefined> {
  // Verify project exists
  try {
    await fs.access(projectDir(projectSlug))
  } catch {
    throw new DaemonError('NOT_FOUND', `project ${projectSlug} not found`)
  }

  // Validate --add-dir / --add-dir-rw paths
  for (const dirPath of [...(options.addDir ?? []), ...(options.addDirRw ?? [])]) {
    if (!path.isAbsolute(dirPath)) {
      throw new DaemonError('VALIDATION', `--add-dir path must be absolute: "${dirPath}"`)
    }
    try {
      await fs.access(dirPath)
    } catch {
      throw new DaemonError('VALIDATION', `--add-dir path not found: "${dirPath}"`)
    }
  }

  // Try to claim a prewarmed session — it already has everything set up.
  // Skip when createPrewarm is true (prewarm creation path itself).
  // Skip when --add-dir / --add-dir-rw is set: prewarm containers are
  // created without those mounts and the fingerprint doesn't encode them,
  // so claiming one would silently drop the user's requested directories.
  // claimPrewarmSession checks that the requested tool matches the prewarmed tool.
  const tool: AgentTool = options.tool ?? 'claude'
  const hasAddDir = (options.addDir?.length ?? 0) > 0 || (options.addDirRw?.length ?? 0) > 0
  const canClaim = !options.createPrewarm && !hasAddDir
  const claimed = canClaim ? await claimPrewarmSession(projectSlug, tool) : null
  if (claimed) {
    emit(`Claiming prewarmed session ${claimed.sessionId.slice(0, 8)}...`, options)
    // Prewarm containers don't get port forwarders at creation time
    // (we don't yet know which host ports will be free when the session
    // is claimed). Provision them now so the claimed session actually
    // forwards the ports advertised in its tmux status bar. Failures
    // propagate — a session returned with no forwarders looks healthy
    // in the status bar but silently drops connections.
    const claimedConfig: YaacConfig = await resolveProjectConfig(projectSlug) ?? {}
    const forwardedPorts = await provisionSessionForwarders(
      projectSlug,
      claimed.sessionId,
      claimed.containerName,
      claimedConfig.portForward,
    )
    return {
      sessionId: claimed.sessionId,
      containerName: claimed.containerName,
      forwardedPorts,
      tool,
      claimedPrewarm: true,
    }
  }

  await ensureContainerRuntime()

  // Git identity is resolved by the CLI before the call. Prewarm creation
  // falls back to the global git config.
  let gitUser: { name: string; email: string } | null = options.gitUser ?? null
  if (!gitUser) gitUser = await getGitUserConfig()
  if (!gitUser) {
    throw new DaemonError(
      'VALIDATION',
      'Git user.name and user.email must be configured globally for non-interactive session creation.',
    )
  }

  const repo = repoDir(projectSlug)

  // Load project config (local override at ~/.yaac/projects/<slug>/ takes precedence)
  const config: YaacConfig = await resolveProjectConfig(projectSlug) ?? {}

  // Resolve the correct GitHub token for this project's remote URL
  const remoteUrl = (await simpleGit(repo).remote(['get-url', 'origin']))?.trim()
  if (!remoteUrl) {
    throw new DaemonError('VALIDATION', 'could not determine remote URL for this project.')
  }
  const githubToken = await resolveTokenForUrl(remoteUrl)
  if (!githubToken) {
    throw new DaemonError(
      'VALIDATION',
      `No GitHub token configured for ${remoteUrl}. Run "yaac auth update" to add one.`,
    )
  }
  // Test-only: e2e fixtures pre-populate the bare repo, so skip the host-side
  // fetchOrigin (which would try to reach the real remote from the daemon
  // process — outside the proxy's reach).
  if (process.env.YAAC_E2E_SKIP_FETCH !== '1') {
    emit('Fetching latest from remote...', options)
    try {
      await fetchOrigin(repo, githubToken)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new DaemonError('INTERNAL', `could not fetch from remote: ${msg}`)
    }
  }

  emit('Ensuring container images are built...', options)
  const imageName = await ensureImage(
    projectSlug,
    process.env.YAAC_IMAGE_PREFIX,
    process.env.YAAC_REQUIRE_PREBUILT_IMAGES === '1',
    config.nestedContainers ?? false,
  )

  const sessionId = options.sessionId ?? crypto.randomUUID()
  const wtDir = worktreeDir(projectSlug, sessionId)

  // Create worktree
  await fs.mkdir(worktreesDir(projectSlug), { recursive: true })
  const defaultBranch = await getDefaultBranch(repo)
  emit(`Creating worktree from ${defaultBranch}...`, options)
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

  // Proxy is always required — it reads the host-mounted credentials dir
  // directly and injects GitHub / Claude / Codex tokens into outbound HTTPS
  // requests. Credential updates via `yaac auth update` propagate to every
  // running session without needing to restart containers.
  emit('Starting proxy sidecar...', options)
  await proxyClient.ensureRunning()

  // Check that tool credentials exist on the host so the container can
  // authenticate via the proxy. For Claude OAuth this also drives the
  // per-project placeholder refresh below.
  const toolAuth = await loadToolAuthEntry(tool)

  // Forward rules from config (envSecretProxy) to the proxy along with the
  // rest of this session's state. GitHub / Claude / Codex auth is handled
  // dynamically by the proxy from the mounted credentials dir — no per-
  // session rule is needed for those.
  const additionalRules = config.envSecretProxy
    ? buildRulesFromConfig(config.envSecretProxy, process.env)
    : []
  const allowedHosts = resolveAllowedHosts(config)
  const upstreamRedirects = parseUpstreamRedirectsEnv(process.env.YAAC_E2E_UPSTREAM_REDIRECTS)
  await proxyClient.registerSession(sessionId, {
    rules: additionalRules,
    allowedHosts,
    repoUrl: remoteUrl,
    tool,
    upstreamRedirects,
  })

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

  // Add placeholder env var for the active tool so it doesn't prompt for login
  // inside the container. The proxy injects the real credentials on API calls.
  if (toolAuth) {
    if (tool === 'claude') {
      if (toolAuth.kind === 'api-key') {
        env.push('ANTHROPIC_API_KEY=placeholder')
      }
      // OAuth: Claude Code reads the placeholder bundle from the mounted
      // .claude/.credentials.json, so no env var is needed.
    } else if (toolAuth.kind === 'api-key') {
      env.push('OPENAI_API_KEY=placeholder')
    }
    // Codex OAuth: Codex reads the placeholder bundle from the mounted
    // .codex/auth.json. Setting OPENAI_API_KEY here would risk steering
    // Codex into api-key mode instead of ChatGPT OAuth.
  }

  const networkMode = proxyClient.network

  // Port forwarding: reserve host ports in the daemon process so no
  // other process can claim them between discovery and the forwarder
  // starting up. The daemon owns the forwarders for the container's
  // lifetime; they are torn down by `deleteSession` and the stale-
  // container reaper.
  //
  // Prewarm containers skip this step: we can't know which host ports
  // will be free when the session is eventually claimed, so reserving
  // them now (and then releasing before the claim) just bakes stale
  // port info into tmux status-right. Ports are provisioned on the
  // claim path instead.
  const forwardedPorts: ReservedPort[] = []
  if (!options.createPrewarm && config.portForward?.length) {
    for (const { containerPort, hostPortStart } of config.portForward) {
      emit(`Finding available host port starting from ${hostPortStart} for container port ${containerPort}...`, options)
      const reserved = await reserveAvailablePort(containerPort, hostPortStart)
      forwardedPorts.push(reserved)
      emit(`Forwarding host port ${reserved.hostPort} -> container port ${containerPort}`, options)
    }
  }

  // PostgreSQL relay setup
  const pgConfig = config.pgRelay
  const pgEnabled = !!(pgConfig && pgConfig.enabled)
  let pgRelayIp: string | null = null

  if (pgEnabled) {
    emit('Starting PostgreSQL relay sidecar...', options)
    await pgRelay.ensureRunning(pgConfig)
    pgRelayIp = pgRelay.ip
  }


  const containerName = `yaac-${projectSlug}-${sessionId}`
  const claude = claudeDir(projectSlug)
  const claudeJson = claudeJsonFile(projectSlug)
  const codex = codexDir(projectSlug)
  const cachedPackages = cachedPackagesDir(projectSlug)

  await fs.mkdir(claude, { recursive: true })
  await fs.mkdir(codex, { recursive: true })
  await fs.mkdir(cachedPackages, { recursive: true })

  // Refresh the per-project placeholder .credentials.json from the current
  // host OAuth bundle. Picks up expiresAt changes since the last session.
  if (tool === 'claude' && toolAuth?.kind === 'oauth') {
    const hostClaudeCreds = await loadClaudeCredentialsFile()
    if (hostClaudeCreds?.kind === 'oauth') {
      await writeProjectClaudePlaceholder(projectSlug, hostClaudeCreds.claudeAiOauth)
    }
  }
  if (tool === 'codex' && toolAuth?.kind === 'oauth') {
    const hostCodexCreds = await loadCodexCredentialsFile()
    if (hostCodexCreds?.kind === 'oauth') {
      await writeProjectCodexPlaceholder(projectSlug, hostCodexCreds.codexOauth)
    }
  }

  // Ensure claude.json exists so Podman mounts it as a file, not a directory.
  try {
    await fs.access(claudeJson)
  } catch {
    await fs.writeFile(claudeJson, '{}')
  }

  if (tool === 'codex') {
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
    wtDir, repo, claude, claudeJson, codex, cachedPackages, tool, config, options,
    networkMode, pgRelayIp, gitUser, forwardedPorts,
  }

  emit(`Creating container ${containerName}...`, options)

  for (let attempt = 1; attempt <= maxStartAttempts; attempt++) {
    try {
      await startContainerWithSetup(setupParams)
      break
    } catch (err) {
      // Always remove the half-created container. Otherwise a container
      // left running (e.g. tmux up but a later exec failed) gets picked up
      // by listActiveSessions as a bogus waiting session.
      try { await shellPodmanWithRetry(`podman rm -f ${containerName}`) } catch { /* already gone */ }
      if (attempt < maxStartAttempts) {
        emit(`Container startup failed (attempt ${attempt}/${maxStartAttempts}), retrying...`, options)
        continue
      }
      // Release any pre-bound host ports so a retry (or the reaper) can
      // rebind them.
      for (const p of forwardedPorts) p.server.close()
      throw err
    }
  }

  if (options.createPrewarm) {
    // Prewarmed sessions aren't attached immediately. Port forwarders
    // are provisioned on the claim path (see above); nothing to hand
    // off here.
    return { sessionId }
  }

  // Container is up — hand the reserved sockets off to long-lived
  // forwarders owned by the daemon. These stay alive across user
  // attaches/detaches and are torn down only by delete or the reaper.
  if (forwardedPorts.length > 0) {
    const stop = startPortForwarders(podmanRelay(containerName), forwardedPorts)
    registerSessionForwarders(sessionId, stop)
  }

  return {
    sessionId,
    containerName,
    forwardedPorts: forwardedPorts.map(({ containerPort, hostPort }) => ({ containerPort, hostPort })),
    tool,
    claimedPrewarm: false,
  }
}
