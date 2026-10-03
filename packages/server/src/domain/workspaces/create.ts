import fs from 'node:fs/promises'
import path from 'node:path'
import crypto, { createHash } from 'node:crypto'
import { hostMatchesPattern, resolveAllowedHosts } from '#lib/allowed-hosts'
import { buildStatusRight } from '#lib/status-right'
import { mergeEnvEntries } from '#lib/env-entries'
import { testEnv } from '@yaac/shared/env'
import { workspaceDriver } from '#drivers/driver'
import type {
  RuntimeHandle,
  TeardownTarget,
  WorkspaceGitCredential,
  WorkspaceMount,
  WorkspaceResources,
  WorkspaceSpec,
} from '#drivers/contract'
import {
  repoDir,
  acpLogDir,
  agentHistoryDir,
  type AgentHistoryPart,
  claudeDir,
  codexDir,
  opencodeCheckpointDir,
  opencodeConfigDir,
  opencodeDataDir,
  piDir,
  cachedPackagesDir,
  cacheVolumeDir,
  workspaceAttachmentsDir,
  workspaceStateDir,
  workspaceDir,
  projectDir,
} from '@yaac/shared/project-paths'
import {
  CONTAINER_ACP_LOG_DIR,
  CONTAINER_ATTACHMENTS_DIR,
  CONTAINER_OPENCODE_CHECKPOINT,
  CONTAINER_OPENCODE_DATA,
  CONTAINER_TMUX_DIR,
} from '@yaac/shared/paths'
import { fetchProjectOrigin, missingCredentialError, parseGitRemote, resolveEphemeralModulesPaths, resolveProjectConfig, resolveProjectCredential, resolveProjectEnv, sshKeyMaterial } from '#domain/projects'
import { ghApiHostForGitHost } from '@yaac/shared/credentials'
import { readLock } from '@yaac/shared/lock'
import {
  loadToolAuthEntry,
  PLACEHOLDER_API_KEY,
  PLACEHOLDER_GH_TOKEN,
  PLACEHOLDER_OPENCODE_API_KEY,
  PLACEHOLDER_PI_API_KEY,
} from '@yaac/shared/tool-auth'
import { defaultModelFor, seedProjectToolHome } from '#domain/auth'
import {
  createCheckout,
  getDefaultBranch,
  isGitAuthError,
  remoteBranchExists,
  writeKnownHostsFile,
} from '#domain/git'
import { serverLog } from '#log'
import {
  agentDriver,
  AgentLaunchDeadError,
  agentWindowName,
  CLAUDE_POD_CWD,
  CLAUDE_POD_REPO,
  buildCloneLinkExec,
  buildWindowsExec,
  ensureAgentReporters,
  ensureToolApiKeyConfig,
  openSandboxDir,
  validateInitWindows,
  verifyAgentWindowAlive,
  whenAcpConversation,
  type AcpConversation,
  type InitWindow,
} from '#runtime/agents'
import {
  applyWorkspaceEvent,
  getGitIdentity,
  getProjectRow,
  getTimeZone,
  setWorkspaceGroup,
  setWorkspaceMamaTokenHash,
  setWorkspaceTitle,
} from '#db'
import { reportAgentLaunchFailure } from './provisioning'
import { CODEX_CONTAINER_HOME, codexHomeMounts } from './codex-home'
import {
  prepareModuleDirs,
  seedClaudeJson,
  seedClaudeSettings,
} from './seed'
import {
  builtinSkillsDir, stageBuiltinSkills, builtinSkillMounts, reconcileSharedSkillRoots,
} from '#domain/skills'
import { convergeAgentHistory } from '#domain/agent-history'
import { deleteWorkspaceState } from './cleanup'
import { reconcileWorkspaceAgentSessions } from './agent-session-registry'
import {
  OPENCODE_CHECKPOINT_SCRIPT,
  WORKSPACE_INIT_SCRIPT,
  workspaceBinDir,
  workspaceBinMounts,
  stageWorkspaceBin,
} from './workspace-bin'
import { ServerError } from '@yaac/shared/errors'
import { waitFor } from '#lib/wait-for'
import {
  AGENT_CLIS,
  DEFAULT_AGENT_MODE,
  defaultPermissionMode,
  launchablePermissionMode,
  resolveToolCreateDefaults,
  SELF_NAMING_TOOLS,
  SUPPORTED_PERMISSION_MODES,
  TOOL_LABELS,
  toolSupportsPermissionMode,
  type AgentMode,
  type AgentTool,
  type DriverKind,
  type PermissionMode,
  type PortMapping,
  type YaacConfig,
} from '@yaac/shared/types'
import {
  opencodeProviderInfo,
  piProviderInfo,
  toolApiKeyEnvVar,
  type PiProvider,
} from '@yaac/shared/tool-providers'

/** How long a fresh acp create waits for its conversation's row. */
const ACP_CONVERSATION_WAIT_MS = 60_000

/** In-pod claude home, where `claudeDir` is mounted. `CLAUDE_CONFIG_DIR`
 *  points here, which also puts claude's global config at
 *  `<here>/.claude.json`. */
const CLAUDE_CONTAINER_HOME = '/home/yaac/.claude'
/** The project's package cache, shared by its workspaces: pnpm's store and
 *  the backing dirs of the ephemeral-modules mounts. */
const CACHED_PACKAGES_CONTAINER_DIR = '/home/yaac/.cached-packages'
/** In-pod pi home, where the project's shared `piDir` is mounted. */
const PI_CONTAINER_HOME = '/home/yaac/.pi'
/** In-pod opencode config dir, where the project's `opencodeConfigDir` is
 *  mounted. */
const OPENCODE_CONFIG_CONTAINER_DIR = '/home/yaac/.config/opencode'
/** Where pi writes its JSONL session logs (PI_CODING_AGENT_SESSION_DIR).
 *  Per-workspace history, kept outside the shared home so containerless can
 *  realize it as a plain link. */
const PI_SESSIONS_CONTAINER_DIR = '/home/yaac/.yaac-pi-sessions'
/** Where codex keeps its sqlite state (CODEX_SQLITE_HOME). Per workspace,
 *  outside the shared home, like pi's sessions. */
const CODEX_SQLITE_CONTAINER_DIR = '/home/yaac/.codex-sqlite'

/**
 * Each path plus its realpath where that differs, for places where a tool
 * records a directory and may store either form. A data dir behind a symlink
 * (macOS `/var` -> `/private/var`) otherwise gives two strings for one dir.
 * Paths that do not resolve on this host (container paths, dirs not created
 * yet) are kept as-is.
 */
async function withResolved(dirs: readonly string[]): Promise<string[]> {
  const out = new Set(dirs)
  for (const dir of dirs) {
    try {
      out.add(await fs.realpath(dir))
    } catch {
      // Not on this host, or not created yet.
    }
  }
  return [...out]
}

function emit(message: string, options: WorkspaceCreateOptions): void {
  console.log(message)
  options.onProgress?.(message)
}

export interface WorkspaceCreateOptions {
  /** Pre-generated workspace ID (resume uses it to know the job name). */
  workspaceId?: string
  /** Agent tool to run inside the container (default: 'claude'). */
  tool?: AgentTool
  /**
   * Which protocol drives the agent. `acp` runs the tool's ACP adapter under
   * acpd and the webapp renders a chat pane instead of a terminal.
   */
  mode: AgentMode
  /**
   * Reference branch for the fresh workspace (a branch on `origin`, no
   * `origin/` prefix); unset → the remote's default branch.
   */
  branch?: string
  /**
   * Resume an existing workspace: reuse the workspace at
   * `workspaceDir(projectSlug, workspaceId)` if present and launch the agent
   * with `--resume` so it loads the prior transcript. Requires `workspaceId`.
   */
  resume?: boolean
  /**
   * Agent sessions to resume, in window order (restart passes the stopped
   * workspace's active set). Each gets its own tmux window
   * (`agentWindowName`). Empty (the default) starts one fresh conversation
   * whose id is the workspace id.
   */
  resumeAgentSessions?: Array<{ agentSessionId: string; tool: AgentTool }>
  /**
   * Provision a prewarmed spare, hidden from user-facing views until a later
   * `workspace create` claims it. Set only by the prewarm reconciler.
   */
  prewarm?: boolean
  /**
   * Prompt pasted and submitted into the agent once its window is up (not
   * passed on the command line). From `yaac-mama create` and
   * `workspace create --prompt`.
   */
  initialPrompt?: string
  /**
   * Model override for the agent launch: a model id or alias for
   * claude/codex, `provider/model` for opencode and pi. The create route
   * validates it. Not persisted: a restart uses the default model.
   */
  model?: string
  /**
   * Sidebar group id (already resolved, not a name). Applied as soon as the
   * row exists, so the workspace never shows outside its group.
   */
  groupId?: string
  /**
   * The user's title, set before the first prompt is recorded so the
   * auto-title sweep never sees the workspace untitled.
   */
  title?: string
  /**
   * The permission mode the agents launch in. Absent means the project's
   * last-used mode, else the driver's default. An explicit value is a user
   * choice, so the project also remembers it. Restart passes the workspace's
   * recorded mode.
   */
  permissionMode?: PermissionMode
  /**
   * Called with each user-visible progress message. The HTTP route streams
   * them to the CLI as NDJSON events.
   */
  onProgress?: (message: string) => void
}

export interface WorkspaceCreateResult {
  workspaceId: string
  jobName: string
  forwardedPorts: PortMapping[]
  tool: AgentTool
  /** Callers that would attach a PTY need this: an `acp` workspace's window
   *  runs acpd, not a shell. */
  mode: AgentMode
}

/**
 * Resource requests and limits for one workspace. This is policy, sized for
 * ordinary developer hardware, so it lives here rather than in a driver.
 */
const WORKSPACE_RESOURCES: WorkspaceResources = {
  memoryRequestBytes: 1 * 1024 ** 3,
  memoryLimitBytes: 8 * 1024 ** 3,
  // Matches the 1Gi memory request at 4 GB/core, so cpu and memory cap
  // concurrent workspaces at about the same count (32 on 8 cores/32 GB).
  cpuRequestMillis: 250,
  // Half a 16-core machine: enough for heavy parallel work, but one
  // workspace cannot take the whole node.
  cpuLimitMillis: 8000,
  // Repo, checkout and caches are on mounts. This covers the writable layer,
  // logs and pod-local scratch; the limit only bounds a runaway workspace.
  // The k8s driver adds the `moduleDirs` volumes' budget on top.
  ephemeralStorageRequestBytes: 2 * 1024 ** 3,
  ephemeralStorageLimitBytes: 16 * 1024 ** 3,
}

interface WorkspaceSetupParams {
  spec: WorkspaceSpec
  projectSlug: string
  workspaceId: string
  tool: AgentTool
  mode: AgentMode
  /** Conversations to bring up, in window order. The same list the rows were
   *  written from, so the DB never names one the agent did not open. */
  launching: Array<{ agentSessionId: string; tool: AgentTool }>
  /** Pre-validated init windows (validateInitWindows ran in createWorkspace). */
  initWindows: InitWindow[]
  /** pi only — provider whose default model drives `pi --model`. */
  piProvider?: PiProvider
  permissionMode: PermissionMode
  /**
   * Called as soon as the runtime has launched, before setup that can fail,
   * so the caller holds the handle needed to tear down a half-started
   * workspace.
   */
  onLaunched: (handle: RuntimeHandle) => void
  options: WorkspaceCreateOptions
  /**
   * Host-side checkout provisioning (fetch, branch checks, `createCheckout`),
   * started before launch so it overlaps pod boot. A rejection means bad
   * input (bad branch, fetch failure).
   */
  workspace: Promise<void>
}

/**
 * Launch the workspace's runtime and run the in-workspace setup. On failure
 * the caller tears down what was launched. Everything here goes through the
 * driver contract.
 */
async function launchWithSetup(params: WorkspaceSetupParams): Promise<RuntimeHandle> {
  const {
    spec, projectSlug, workspaceId, tool, mode, launching, initWindows, piProvider,
    permissionMode, onLaunched, options, workspace,
  } = params
  const runtime = workspaceDriver()

  // Rejects when checkout provisioning fails and never settles otherwise.
  // Racing it against the boot waits makes common input errors (unknown
  // branch, git auth) fail fast instead of after the pod boots.
  const workspaceFailure: Promise<never> = workspace.then(
    () => new Promise<never>(() => { /* success: races resolve on the pod wait */ }),
  )
  // Avoid an unhandled rejection if no race observes it; the join below
  // reads the real outcome.
  workspaceFailure.catch(() => { /* observed via race/join */ })

  const handle = await runtime.launch(spec)
  onLaunched(handle)
  const jobName = handle.jobName
  const paths = runtime.workspacePaths(jobName)
  // Mark the waits handled so one abandoned by a race cannot surface later
  // as an unhandled rejection.
  const podReady = runtime.awaitReady(handle)
  podReady.catch(() => { /* observed via race */ })
  await Promise.race([podReady, workspaceFailure])

  const transportReady = runtime.awaitAgentTransport(jobName)
  transportReady.catch(() => { /* observed via race */ })
  await Promise.race([transportReady, workspaceFailure])

  // Everything below reads the checkout, so join it now.
  await workspace

  // Link the checkout to the main clone's objects and update its `origin/*`,
  // on every launch, so the agent starts current.
  await runtime.exec(jobName, buildCloneLinkExec(path.join(repoDir(projectSlug), '.git'), paths))

  // yaac-workspace-init starts the in-pod engine in the background. Wait for
  // it so a broken engine fails the create with a clear error.
  if (spec.nestedContainers) {
    emit('Waiting for the in-pod container engine...', options)
    let lastErr: unknown
    const engineUp = await waitFor(() => runtime.exec(jobName, 'docker version', { maxAttempts: 1, timeout: 10_000 })
      .then(() => true, (err: unknown) => { lastErr = err; return false }), { timeoutMs: 60_000, intervalMs: 500 })
    if (!engineUp) {
      throw new Error(
        'in-pod podman did not become ready within 60s — check '
        + `/tmp/podman-service.log and /tmp/yaac-engine-setup.log in session ${workspaceId} `
        + `(${String(lastErr)})`,
      )
    }
  }

  // Open the init windows and replace the placeholder window with the agents
  // (buildWindowsExec). A self-naming tool never ran under the workspace-id
  // placeholder id, so resuming by it would find nothing (`codex resume`
  // kills the window); such a conversation starts fresh instead.
  const driver = agentDriver(mode)
  const agentCmds = launching.map((a, i) => {
    const resume = options.resume === true
      && !(SELF_NAMING_TOOLS.includes(a.tool) && a.agentSessionId === workspaceId)
    return {
      tool: a.tool,
      ...(resume ? { resumes: a.agentSessionId } : {}),
      cmd: driver.launchCmd({
        tool: a.tool,
        agentSessionId: a.agentSessionId,
        resume,
        // Under acp this also names the acpd socket.
        windowName: agentWindowName(a.tool, i),
        paths,
        permissionMode,
        ...(piProvider !== undefined ? { piProvider } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
      }),
    }
  })
  emit(`Starting ${TOOL_LABELS[tool]}...`, options)
  await runtime.exec(jobName, buildWindowsExec(initWindows, tool, agentCmds, paths))

  // Check the agents actually started: `respawn-window` succeeds even when
  // its command dies instantly. Not awaited, since the probe must wait for a
  // doomed command to exit; a failure lands later as a failed provisioning
  // row (reportAgentLaunchFailure). `tui` only: an acp launch is proven by
  // its transport handshake.
  if (mode === 'tui') {
    const windows = launching.map((a, i) => agentWindowName(a.tool, i))
    void verifyAgentWindowAlive(jobName, windows).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      serverLog(`[server] create ${workspaceId}: ${message}`)
      // Report only a confirmed dead agent. A failed provisioning row hides
      // the workspace, so a probe that got no answer must not report one.
      if (!(err instanceof AgentLaunchDeadError)) return
      // A spare has no row; the claim runs this probe again.
      if (options.prewarm === true) return
      void reportAgentLaunchFailure({
        workspaceId,
        projectSlug,
        tool,
        kind: options.resume === true ? 'restart' : 'create',
        error: runtime.kind === 'containerless'
          ? `${message}. Check that "${tool}" runs on this host `
            + `(yaac runs its own install of ${AGENT_CLIS[tool].package}@${AGENT_CLIS[tool].version}).`
          : message,
      })
    })
  }

  return handle
}

/**
 * The last step of a create, cold or claimed: hand the agent over.
 *
 * A fresh acp conversation has no id, and so no row or chat pane, until the
 * agent answers `session/new`. So an acp create waits for that, then
 * records the row itself rather than waiting for the reconciler's pass.
 * Then the initial prompt is delivered (pasted under `tui`,
 * `session/prompt` under `acp`) without waiting for a reply. Failures are
 * logged, not thrown: the workspace is usable either way.
 */
export async function handOverAgent(input: {
  projectSlug: string
  workspaceId: string
  jobName: string
  tool: AgentTool
  mode: AgentMode
  prompt?: string
  emit: (message: string) => void
}): Promise<void> {
  const { projectSlug, workspaceId, jobName, tool, mode, prompt, emit } = input
  const window = agentWindowName(tool, 0)
  let conversationUp = true
  if (mode === 'acp') {
    emit(`Connecting to ${TOOL_LABELS[tool]}...`)
    conversationUp = await awaitConversation(projectSlug, workspaceId, jobName, window)
    if (conversationUp) {
      await reconcileWorkspaceAgentSessions(projectSlug, workspaceId, mode, jobName).catch((err: unknown) => {
        serverLog(`[server] create ${workspaceId}: recording the conversation failed: ${String(err)}`)
      })
    }
  }
  if (prompt === undefined) return
  if (!conversationUp) {
    serverLog(`[server] create ${workspaceId}: initial prompt not delivered — no conversation`)
    return
  }
  emit('Sending initial prompt...')
  await agentDriver(mode).deliverPrompt({ slug: projectSlug, workspaceId, jobName, tool }, window, prompt)
    .catch((err: unknown) => {
      serverLog(`[server] create ${workspaceId}: initial prompt failed: ${String(err)}`)
    })
}

/**
 * Wait for the agent's conversation to complete its handshake, including
 * the launch model and mode that follow `session/new`, so the row recorded
 * next shows them; resolves whether it did. Gives up at the deadline or when the agent's window is
 * gone, which the window probe (an exec) checks every two seconds.
 */
async function awaitConversation(
  projectSlug: string,
  workspaceId: string,
  jobName: string,
  window: string,
): Promise<boolean> {
  let settled = false
  const conversation = whenAcpConversation(projectSlug, workspaceId, window, ACP_CONVERSATION_WAIT_MS)
    .finally(() => { settled = true })
  const windowGone = waitFor(async () => settled || await verifyAgentWindowAlive(jobName, [window])
    .then(() => false, (err: unknown) => err instanceof AgentLaunchDeadError),
  { timeoutMs: ACP_CONVERSATION_WAIT_MS, intervalMs: 2_000 })
  const outcome = await Promise.race([
    conversation,
    windowGone.then<AcpConversation | 'dead' | undefined>((stop) => (stop && !settled ? 'dead' : conversation)),
  ])
  if (outcome === 'dead') {
    serverLog(`[server] create ${workspaceId}: acp agent window exited before its handshake`)
    return false
  }
  if (outcome === undefined) {
    serverLog(`[server] create ${workspaceId}: no acp conversation after `
      + `${String(ACP_CONVERSATION_WAIT_MS / 1000)}s`)
    return false
  }
  return outcome.whenReady(ACP_CONVERSATION_WAIT_MS).then(() => true, (err: unknown) => {
    serverLog(`[server] create ${workspaceId}: acp handshake did not finish: ${String(err)}`)
    return false
  })
}

/**
 * Whether a failed create deletes its checkout: only when this create made
 * it. Getting this wrong deletes work that exists nowhere else.
 *
 * - A resume keeps it: the checkout predates this create and holds the
 *   user's work.
 * - A prewarm keeps it: its row survives flagged `spare`, and the startup
 *   sweep collects the checkout from that flag.
 */
export function failedCreateCollectsCheckout(
  options: Pick<WorkspaceCreateOptions, 'resume' | 'prewarm'>,
): boolean {
  return options.prewarm !== true && options.resume !== true
}

/**
 * Report that a create gave up so the matching `workspace-created` can be
 * undone. `#db` decides what undo means for a resume (apply-workspace-event.ts).
 */
async function reportCreateFailed(
  projectSlug: string,
  workspaceId: string,
  options: WorkspaceCreateOptions,
): Promise<void> {
  await applyWorkspaceEvent({
    type: 'workspace-create-failed',
    projectSlug,
    workspaceId,
    resume: options.resume,
  }).catch(() => {
    // Best-effort: the reaper also handles a row whose pod never arrived.
  })
}

/**
 * The permission mode a create launches in: the requested one, else
 * `defaultPermissionMode` for this driver and tool. No project memory here;
 * `resolveCreate` handles that for user-initiated creates.
 *
 * A requested mode the tool (or its ACP adapter, which may offer fewer
 * modes) does not support is refused rather than swapped for a weaker one.
 *
 * A resume is the exception: its mode comes from the row, possibly written by
 * another build, so it launches in the nearest mode that is no looser
 * (`launchablePermissionMode`) rather than failing or falling back to the
 * driver default. See docs/permission-modes.md.
 */
export function launchPermissionMode(args: {
  tool: AgentTool
  driver: DriverKind
  requested?: PermissionMode
  resume?: boolean
}): PermissionMode {
  const { tool, driver, requested } = args
  const fallback = defaultPermissionMode(driver, tool)
  if (requested === undefined) return fallback
  if (args.resume === true) {
    return launchablePermissionMode(tool, requested)
  }
  if (!toolSupportsPermissionMode(tool, requested)) {
    const supported = SUPPORTED_PERMISSION_MODES[tool].join(', ')
    throw new ServerError(
      'VALIDATION',
      `${tool} has no "${requested}" permission mode; it supports: ${supported}`,
    )
  }
  return requested
}

/** A create with every choice resolved: what the route launches and what a
 *  prewarmed spare is warmed as. */
export interface CreateSetup {
  tool: AgentTool
  /** Absent when the catalog has no model for the tool's provider; the
   *  agent then launches without `--model`. */
  model?: string
  permissionMode: PermissionMode
  mode: AgentMode
}

/**
 * Resolve a create's settings field by field: the request's value, else what
 * this project last used for that tool (`project_tool_defaults`) if still
 * valid, else `resolveToolCreateDefaults`. The tool itself defaults to the
 * project's last tool, else claude.
 *
 * A requested permission mode the tool lacks is refused; a remembered one it
 * lacks falls back to the default. Restart skips this and calls
 * `createWorkspace` directly.
 */
export async function resolveCreate(
  projectSlug: string,
  request: { tool?: AgentTool; model?: string; permissionMode?: PermissionMode; mode?: AgentMode },
): Promise<CreateSetup> {
  const row = await getProjectRow(projectSlug)
  const tool = request.tool ?? row?.lastTool ?? 'claude'
  const remembered = row?.createDefaults[tool]
  const mode = request.mode ?? remembered?.mode ?? DEFAULT_AGENT_MODE
  const driver = workspaceDriver().kind
  const auth = await loadToolAuthEntry(tool)
  const provider = auth?.tool === 'opencode' ? auth.opencodeProvider
    : auth?.tool === 'pi' ? auth.piProvider
    : undefined
  const fallback = resolveToolCreateDefaults({
    driver,
    tool,
    remembered,
    ...(provider !== undefined ? { provider } : {}),
    defaultModel: defaultModelFor(tool, provider),
  })
  const model = request.model ?? fallback.model
  return {
    tool,
    ...(model !== '' ? { model } : {}),
    permissionMode: request.permissionMode !== undefined
      ? launchPermissionMode({ tool, driver, requested: request.permissionMode })
      : fallback.permissionMode,
    mode,
  }
}

export async function createWorkspace(
  projectSlug: string,
  options: WorkspaceCreateOptions,
): Promise<WorkspaceCreateResult> {
  try {
    await fs.access(projectDir(projectSlug))
  } catch {
    throw new ServerError('NOT_FOUND', `project ${projectSlug} not found`)
  }

  if (options.resume && !options.workspaceId) {
    throw new ServerError('VALIDATION', 'resume requires a workspaceId')
  }

  const tool: AgentTool = options.tool ?? 'claude'
  const runtime = workspaceDriver()
  // With mediated egress the workspace holds only placeholder credentials
  // that the proxy swaps; without it, it must hold the real secrets.
  const mediatedEgress = runtime.kind !== 'containerless'
  // Whether per-workspace mounts can sit over the shared tool homes. Without
  // a mount namespace, skills and history are linked into the shared homes
  // instead (#domain/skills, #domain/agent-history).
  const layersToolHomes = runtime.kind !== 'containerless'

  await runtime.ensureRuntimeReachable()

  const gitUser = await getGitIdentity()
  if (!gitUser) {
    throw new ServerError(
      'VALIDATION',
      'No git identity is set on this server, so a workspace would commit as nobody. '
      + 'Set one in Settings \u2192 General, or with '
      + '`yaac config git-identity --name <name> --email <email>`.',
    )
  }

  const repo = repoDir(projectSlug)

  const config: YaacConfig = await resolveProjectConfig(projectSlug) ?? {}

  // Plain variables plus the secrets the egress path injects. Stored as rows,
  // since a remote client cannot set the server's own environment
  // (docs/remote-hosting.md).
  const projectEnv = await resolveProjectEnv(projectSlug)

  const projectRow = await getProjectRow(projectSlug)
  if (!projectRow) throw new ServerError('NOT_FOUND', `project ${projectSlug} not found`)
  const { remoteUrl, id: projectId } = projectRow

  // Without a git credential the agent could neither fetch nor push.
  const parsedRemote = parseGitRemote(remoteUrl)
  const credential = await resolveProjectCredential(projectSlug)
  if (!credential) throw missingCredentialError(projectSlug)

  // Fail now rather than let the agent hit a confusing proxy 403 on fetch.
  const allowedHosts = resolveAllowedHosts(config)
  const hostAllowed = allowedHosts.length === 1 && allowedHosts[0] === '*'
    || allowedHosts.some((pattern) => hostMatchesPattern(parsedRemote.host, pattern))
  if (!hostAllowed) {
    throw new ServerError(
      'VALIDATION',
      `Project remote host "${parsedRemote.host}" is not in the resolved allowlist. `
      + `Add "${parsedRemote.host}" to addAllowedUrls in yaac-config.json.`,
    )
  }

  const nestedContainers = config.nestedContainers === true

  // Refuse rather than silently launch a workspace with no container engine.
  if (runtime.kind === 'containerless' && nestedContainers) {
    throw new ServerError(
      'VALIDATION',
      'nestedContainers needs a container runtime; this server runs workspaces on the host.',
    )
  }

  // Validate before provisioning anything.
  const initWindows = validateInitWindows(config)

  const { mode } = options
  // Check this runtime can run the tool in this mode (a host installs the
  // pinned version on first use). Otherwise the workspace would die seconds
  // after reporting success.
  await runtime.assertCanLaunch({
    tool,
    mode,
    onProgress: (message) => { emit(message, options) },
  })

  const permissionMode = launchPermissionMode({
    tool,
    driver: runtime.kind,
    resume: options.resume === true,
    ...(options.permissionMode !== undefined ? { requested: options.permissionMode } : {}),
  })
  // Warn: containerless has no sandbox, so bypass acts as the user on this
  // machine.
  if (permissionMode === 'bypass' && runtime.kind === 'containerless') {
    options.onProgress?.(
      'Note: this workspace runs with bypass permissions, and this server has '
      + 'no sandbox — the agent acts as you, on this machine.',
    )
  }

  const workspaceId = options.workspaceId ?? crypto.randomUUID()
  // A resume reuses its checkout as it stands.
  const refBranch = options.resume === true
    ? undefined
    : options.branch ?? await getDefaultBranch(repo)
  // Decided here so they are recorded with the workspace row. The tool and
  // first prompt are read from the first conversation, so a workspace with
  // none could not be restarted; discovery only adds to this list.
  const launching: Array<{ agentSessionId: string; tool: AgentTool }> =
    options.resumeAgentSessions !== undefined && options.resumeAgentSessions.length > 0
      ? options.resumeAgentSessions
      : [{ agentSessionId: workspaceId, tool }]

  // Record the row before provisioning anything, so no pod exists without
  // one (a rowless pod is invisible to titles, groups, restart and cannot be
  // told from a spare). The insert also claims the id: a fresh create reusing
  // a taken id stops here, before touching that workspace's checkout.
  //
  // A prewarmed spare is recorded flagged `spare`, which listings filter out
  // and reaping uses to tell it from a stopped workspace. The base branch is
  // recorded now because a workspace queued after this one defaults to it.
  // The user's zone, as clients report it; a pod otherwise runs in UTC, and
  // a containerless server's host need not be where the user is. Recorded so
  // a spare warmed in another zone is never claimed.
  const { timeZone } = await getTimeZone()
  await applyWorkspaceEvent({
    type: 'workspace-created',
    projectSlug,
    workspaceId,
    ...(refBranch !== undefined ? { baseBranch: refBranch } : {}),
    permissionMode,
    mode,
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(timeZone !== null ? { timeZone } : {}),
    resume: options.resume,
    ...(options.prewarm === true ? { spare: true } : {}),
  })

  const wtDir = workspaceDir(projectSlug, workspaceId)

  // Pre-create the checkout dir so its hostPath mount (type Directory)
  // works while the checkout is still running.
  await fs.mkdir(wtDir, { recursive: true })
  // Create the ephemeral-module mount points (inside the checkout) now;
  // otherwise the pod may create them root-owned 0700. createCheckout copes
  // with the non-empty destination.
  const moduleDirs = await prepareModuleDirs(wtDir, resolveEphemeralModulesPaths(config))

  // Set group and title now, so the workspace shows in its group while it
  // provisions.
  if (options.groupId !== undefined) {
    await setWorkspaceGroup(projectSlug, workspaceId, options.groupId)
  }
  if (options.title !== undefined) await setWorkspaceTitle(projectSlug, workspaceId, options.title)

  // Start a new life after the row exists and before any handle is
  // recorded; this clears the previous life's handles.
  await applyWorkspaceEvent({
    type: 'workspace-life-started',
    projectSlug,
    workspaceId,
  })

  if (!options.prewarm) {
    // Record the conversations now rather than leave them to discovery. A
    // fresh acp create cannot: the agent mints the id in `session/new`, and
    // the registry records it then. A resumed acp workspace already has ids.
    if (mode === 'tui' || (launching.length > 0 && options.resumeAgentSessions !== undefined)) {
      // Under acp the handle (window name) is known now and must be recorded,
      // or the restart's acpd handshake starts a new conversation. A tui pane
      // id is unknown until the pane exists; the registry fills it in.
      await applyWorkspaceEvent({
        type: 'sessions-launched',
        projectSlug,
        workspaceId,
        sessions: launching.map((a, i) => ({
          tool: a.tool,
          agentSessionId: a.agentSessionId,
          mode,
          ...(mode === 'acp' ? { paneId: agentWindowName(a.tool, i) } : {}),
          ...(i === 0 && options.initialPrompt !== undefined
            ? { firstPrompt: options.initialPrompt }
            : {}),
          // Lets the pane show the model before the agent reports one.
          ...(i === 0 && options.resume !== true && options.model !== undefined
            ? { model: options.model }
            : {}),
        })),
      })
    }
  }

  // ── Concurrent provisioning ─────────────────────────────────────────
  // Image, checkout, substrate and host fs prep run concurrently. The
  // checkout leg is joined later, inside launchWithSetup, so it also
  // overlaps pod boot.

  const imageTask: Promise<string | undefined> = runtime.kind === 'containerless'
    ? Promise.resolve(undefined)
    : runtime.prepareImage({
      project: { slug: projectSlug, id: projectId },
      nestedContainers,
      onProgress: (m) => emit(m, options),
    })
  imageTask.catch(() => { /* awaited at the join */ })

  const workspaceTask = (async (): Promise<void> => {
    // e2e fixtures pre-populate the repo, so the fetch is skipped there.
    if (!testEnv.e2eSkipFetch) {
      emit('Fetching latest from remote...', options)
      try {
        await fetchProjectOrigin(projectSlug)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (isGitAuthError(msg)) {
          throw new ServerError(
            'VALIDATION',
            `git authentication failed for ${parsedRemote.host} — the project's credential was `
            + 'rejected (expired or revoked?). Assign it a new one in Settings → Git credentials, '
            + 'then retry.',
          )
        }
        throw new ServerError('INTERNAL', `could not fetch from remote: ${msg}`)
      }
    }

    if (options.resume && await fs.access(path.join(wtDir, '.git')).then(() => true, () => false)) {
      emit(`Reusing existing workspace at ${wtDir}`, options)
      return
    }
    if (options.branch && !(await remoteBranchExists(repo, options.branch))) {
      throw new ServerError('VALIDATION', `branch "${options.branch}" not found on origin.`)
    }
    // A resume whose checkout is gone recreates it from the default.
    const base = refBranch ?? options.branch ?? await getDefaultBranch(repo)
    emit(`Creating workspace from ${base}...`, options)
    await createCheckout(repo, wtDir, { branch: `agent/${workspaceId}`, baseBranch: base, remoteUrl })
  })()
  workspaceTask.catch(() => { /* awaited later */ })

  // Egress registration and registry plumbing, owned by the workspace.
  const substrateTask = runtime.prepareSubstrate({
    projectSlug,
    projectId,
    workspaceId: workspaceId,
    tool,
    config,
    remoteUrl,
    nestedContainers,
    proxySecretRules: Object.fromEntries(
      Object.entries(projectEnv.secrets).map(([name, { rule }]) => [name, rule]),
    ),
    onProgress: (m) => emit(m, options),
  })
  substrateTask.catch(() => { /* awaited at the join */ })

  const prepTask = (async () => {
    // Every tool's credential, not just the active one's: a prewarmed spare
    // can be switched to any tool when claimed.
    const [claudeAuth, codexAuth, opencodeAuth, piAuth] = await Promise.all([
      loadToolAuthEntry('claude'),
      loadToolAuthEntry('codex'),
      loadToolAuthEntry('opencode'),
      loadToolAuthEntry('pi'),
    ])
    const toolAuthByTool = {
      claude: claudeAuth, codex: codexAuth, opencode: opencodeAuth, pi: piAuth,
    }
    // The api-key-only tools' providers (`#runtime/agents` tool-api-keys).
    const keyProviders = {
      ...(opencodeAuth?.kind === 'api-key' ? { opencode: opencodeProviderInfo(opencodeAuth.opencodeProvider) } : {}),
      ...(piAuth?.kind === 'api-key' ? { pi: piProviderInfo(piAuth.piProvider) } : {}),
    }

    const claude = claudeDir(projectSlug)
    const codex = codexDir(projectSlug)
    const opencodeData = opencodeDataDir(projectId, workspaceId)
    const opencodeCheckpoint = opencodeCheckpointDir(projectSlug, workspaceId)
    const opencodeConfig = opencodeConfigDir(projectSlug)
    const pi = piDir(projectSlug)
    const cachedPackages = cachedPackagesDir(projectId)

    // Create the shared dirs the pod mounts before launch, or the kubelet
    // creates missing subPaths root-owned. Node-local dirs (`opencodeData`,
    // `cachedPackages`) may not be reachable from here; the driver creates
    // them where the workspace runs.
    await fs.mkdir(claude, { recursive: true })
    await fs.mkdir(codex, { recursive: true })
    await fs.mkdir(opencodeConfig, { recursive: true })
    // Checkpoint of this workspace's opencode history. A pod restores from
    // and saves back to it; containerless uses it directly.
    await fs.mkdir(opencodeCheckpoint, { recursive: true })
    await fs.mkdir(pi, { recursive: true })
    // Put every tool's history for this workspace in the layout this driver
    // uses (mounted over the tool homes, or linked into them).
    await convergeAgentHistory(projectSlug, workspaceId, { layers: layersToolHomes })
    // acpd's conversation records. Kept under the project dir (which
    // teardown does not prune) so the server can read them after the pod is
    // gone. Only `acp` workspaces get the dir and mount.
    const acpLogs = mode === 'acp' ? acpLogDir(projectSlug, workspaceId) : undefined
    if (acpLogs !== undefined) await fs.mkdir(acpLogs, { recursive: true })
    // Pasted images (`saveWorkspaceAttachment`); must exist for its mount.
    const attachments = workspaceAttachmentsDir(projectSlug, workspaceId)
    await fs.mkdir(attachments, { recursive: true })

    // SSH remotes need a known_hosts file, written from the host key the
    // credential was assigned with. How it reaches the workspace is the
    // driver's concern.
    let sshKnownHostsFile: string | undefined
    if (credential.kind === 'ssh') {
      sshKnownHostsFile = path.join(projectDir(projectSlug), 'known_hosts')
      await writeKnownHostsFile([credential.knownHostsEntry], sshKnownHostsFile)
    }

    // Write every tool's per-project credential files. With mediated egress
    // they hold placeholders the proxy swaps; without it, the real
    // credentials (docs/containerless-driver.md), merged so a token a running
    // workspace refreshed is not overwritten (#domain/auth).
    await seedProjectToolHome(projectSlug, { mediatedEgress })

    // Seed every tool's config (a retooled spare needs it too). Claude gets
    // onboarding state so it skips the first-run wizard and login, and its
    // trusted roots as the agent will see them. The homes are writable by
    // the workspace, so writes go through a sandboxed dir handle that
    // replaces a planted symlink rather than following it.
    const claudeHome = await openSandboxDir(projectSlug, claude)
    await seedClaudeJson(
      claudeHome,
      mediatedEgress ? ['/workspace'] : await withResolved([wtDir]),
    )
    await seedClaudeSettings(claudeHome)
    const piHome = await openSandboxDir(projectSlug, pi)
    const opencodeConfigHome = await openSandboxDir(projectSlug, opencodeConfig)
    // Hook up the reporters that publish each agent's conversation, model and
    // mode on its pane. Best-effort: agents still run without them.
    await (async () => ensureAgentReporters({
      claude: claudeHome,
      codex: await openSandboxDir(projectSlug, codex),
      pi: piHome,
      opencodeConfig: opencodeConfigHome,
    }))().catch(() => {})
    // Not best-effort: without it opencode and pi find no key.
    const { opencodeConfigFile } = await ensureToolApiKeyConfig(
      { opencodeConfig: opencodeConfigHome, pi: piHome }, keyProviders)

    // Pre-create cacheVolumes dirs so they are server-owned (and so writable
    // in-pod) rather than root-owned. None may overlap the main clone's
    // mount.
    const cacheVolumeEntries = Object.entries(config.cacheVolumes ?? {})
    const repoMount = `${repo}/.git`
    for (const [key, p] of cacheVolumeEntries) {
      if (p === repoMount || p.startsWith(`${repoMount}/`) || repoMount.startsWith(`${p}/`)) {
        throw new ServerError('VALIDATION', `cacheVolumes.${key} (${p}) overlaps the project's git mount at ${repoMount}`)
      }
    }
    for (const [key] of cacheVolumeEntries) {
      await fs.mkdir(cacheVolumeDir(projectSlug, key), { recursive: true })
    }

    // yaac's bundled skills: a pod gets a per-workspace copy mounted
    // read-only into each tool's skills root; containerless links them into
    // the project's shared skills roots instead.
    const builtinSkillsStaging = path.join(workspaceStateDir(projectSlug, workspaceId), 'builtin-skills')
    const builtinSkillNames = layersToolHomes
      ? await stageBuiltinSkills(builtinSkillsDir(), builtinSkillsStaging)
      : await reconcileSharedSkillRoots(builtinSkillsDir(), projectSlug, 'link')

    // In-workspace helper commands (yaac-mama, yaac-workspace-init), staged
    // like the skills.
    const workspaceBinStaging = path.join(workspaceStateDir(projectSlug, workspaceId), 'bin')
    const workspaceBinNames = await stageWorkspaceBin(workspaceBinDir(), workspaceBinStaging)
    // Without the init script the pod has no git identity, tmux or streamd.
    if (!workspaceBinNames.includes(WORKSPACE_INIT_SCRIPT)) {
      throw new ServerError(
        'INTERNAL',
        `workspace-bin staging is missing ${WORKSPACE_INIT_SCRIPT} — broken yaac install?`,
      )
    }
    if (layersToolHomes && builtinSkillNames.length > 0) {
      // Pre-create the skills roots and per-skill mountpoints server-owned;
      // the kubelet would create them root-owned, blocking the agent's own
      // skills and a later containerless run. Best-effort: the skills mount
      // either way.
      await reconcileSharedSkillRoots(builtinSkillsDir(), projectSlug, 'mountpoint')
        .catch((err: unknown) => {
          serverLog(`[server] create ${workspaceId}: skills roots: ${String(err)}`)
        })
    }

    return {
      toolAuthByTool, keyProviders, opencodeConfigFile, sshKnownHostsFile, cacheVolumeEntries,
      builtinSkillsStaging, builtinSkillNames, workspaceBinStaging, workspaceBinNames,
      claude, codex, opencodeData, opencodeCheckpoint, opencodeConfig, pi,
      cachedPackages, acpLogs, attachments,
    }
  })()

  const [imageRef, substrate, prep] = await Promise.all([imageTask, substrateTask, prepTask])
  const {
    toolAuthByTool, keyProviders, opencodeConfigFile, sshKnownHostsFile, cacheVolumeEntries,
    builtinSkillsStaging, builtinSkillNames, workspaceBinStaging, workspaceBinNames,
    claude, codex, opencodeData, opencodeCheckpoint, opencodeConfig, pi,
    cachedPackages, acpLogs, attachments,
  } = prep

  const env: string[] = []
  // Names of vars that carry a credential (`WorkspaceSpec.secretEnvKeys`),
  // listed even when the value is a placeholder.
  const secretEnvKeys: string[] = []

  // A project may override `YAAC_WORKSPACE_ID`, `TZ` and `OPENCODE_CONFIG`;
  // any other name it shares with yaac's own variables fails the launch
  // (`mergeEnvEntries`).
  const projectSets = (name: string): boolean =>
    name in projectEnv.plain || name in projectEnv.secrets

  // Read by the zsh prompt and by a yaac server started inside the
  // workspace, which then treats unproxied requests as local (`identify` in
  // web-auth.ts).
  if (!projectSets('YAAC_WORKSPACE_ID')) env.push(`YAAC_WORKSPACE_ID=${workspaceId}`)

  // Without a proxy (which identifies a pod by its IP), `yaac-mama` calls the
  // server directly and authenticates with a token minted here
  // (docs/containerless-driver.md).
  if (!mediatedEgress && !options.prewarm) {
    const mamaToken = crypto.randomBytes(32).toString('hex')
    await setWorkspaceMamaTokenHash(
      projectSlug,
      workspaceId,
      createHash('sha256').update(mamaToken).digest('hex'),
    )
    env.push(`YAAC_MAMA_TOKEN=${mamaToken}`)
    secretEnvKeys.push('YAAC_MAMA_TOKEN')
    // Fixed at launch: if the server later moves to another port, yaac-mama
    // breaks until the workspace restarts.
    const lock = await readLock()
    if (lock) env.push(`YAAC_MAMA_URL=http://127.0.0.1:${lock.port}`)
  }

  if (timeZone !== null && !projectSets('TZ')) env.push(`TZ=${timeZone}`)

  for (const [name, value] of Object.entries(projectEnv.plain)) {
    env.push(`${name}=${value}`)
  }

  // Proxied secrets: a placeholder with mediated egress, else the value.
  for (const [name, { value }] of Object.entries(projectEnv.secrets)) {
    env.push(`${name}=${mediatedEgress ? 'placeholder' : value}`)
    secretEnvKeys.push(name)
  }

  // API-key env vars for every tool (a spare may be retooled at claim), so
  // no tool prompts for login. With mediated egress these are placeholders
  // the proxy swaps by destination host and placeholder, regardless of the
  // workspace's tool (see k8s/proxy/injection.ts); without it they are the
  // real keys.
  const apiKeyFor = (real: string, placeholder = PLACEHOLDER_API_KEY): string =>
    mediatedEgress ? placeholder : real
  if (toolAuthByTool.claude?.kind === 'api-key') {
    env.push(`ANTHROPIC_API_KEY=${apiKeyFor(toolAuthByTool.claude.apiKey)}`)
    secretEnvKeys.push('ANTHROPIC_API_KEY')
  }
  // Claude OAuth: Claude Code reads the placeholder bundle from the mounted
  // .claude/.credentials.json, so no env var is needed.
  if (toolAuthByTool.codex?.kind === 'api-key') {
    env.push(`OPENAI_API_KEY=${apiKeyFor(toolAuthByTool.codex.apiKey)}`)
    secretEnvKeys.push('OPENAI_API_KEY')
  }
  // opencode and pi are api-key only, and read their key from a variable of
  // their own that their config names (`ensureToolApiKeyConfig` above).
  if (toolAuthByTool.opencode?.kind === 'api-key' && keyProviders.opencode) {
    const name = toolApiKeyEnvVar('opencode', keyProviders.opencode.id)
    env.push(`${name}=${apiKeyFor(toolAuthByTool.opencode.apiKey, PLACEHOLDER_OPENCODE_API_KEY)}`)
    // A project's own `OPENCODE_CONFIG` replaces this file, and with it the
    // pointer to yaac's key.
    if (!projectSets('OPENCODE_CONFIG')) {
      env.push(`OPENCODE_CONFIG=${OPENCODE_CONFIG_CONTAINER_DIR}/${opencodeConfigFile}`)
    }
    secretEnvKeys.push(name)
  }
  if (toolAuthByTool.pi?.kind === 'api-key' && keyProviders.pi) {
    const name = toolApiKeyEnvVar('pi', keyProviders.pi.id)
    env.push(`${name}=${apiKeyFor(toolAuthByTool.pi.apiKey, PLACEHOLDER_PI_API_KEY)}`)
    secretEnvKeys.push(name)
  }
  // Codex OAuth reads the mounted .codex/auth.json. Setting OPENAI_API_KEY
  // could switch codex to api-key mode.

  // For an HTTPS GitHub remote, give `gh` the project's git token (a
  // placeholder the proxy swaps on api.github.com, if mediated) so it is
  // logged in. Skipped if the user set their own GH_TOKEN/GITHUB_TOKEN.
  const userWiresGithubToken = env.some((e) => e.startsWith('GH_TOKEN='))
    || projectEnv.secrets.GH_TOKEN !== undefined
    || projectEnv.secrets.GITHUB_TOKEN !== undefined
  if (credential.kind === 'https'
    && ghApiHostForGitHost(parsedRemote.host) !== null
    && !userWiresGithubToken) {
    env.push(`GH_TOKEN=${mediatedEgress ? PLACEHOLDER_GH_TOKEN : credential.token}`)
    secretEnvKeys.push('GH_TOKEN')
  }

  // Keep opencode and claude on their pinned versions, since launch commands
  // are written against those versions' flags. Set for every tool so a
  // retooled spare has them.
  env.push('OPENCODE_DISABLE_AUTOUPDATE=1')
  env.push('DISABLE_AUTOUPDATER=1')

  // Name each tool's home explicitly, in container paths. Containerless
  // translates them to the project's dirs (`remapMountedPath` in its
  // launch.ts) and clears any host value (`TOOL_HOME_VARS`). The exact string
  // matters: claude names its macOS Keychain item after a hash of it.
  // opencode has no such variable. Pi's version check is skipped so a fresh
  // workspace does not stall on a network probe.
  env.push(`CLAUDE_CONFIG_DIR=${CLAUDE_CONTAINER_HOME}`)
  env.push(`CODEX_HOME=${CODEX_CONTAINER_HOME}`)
  env.push(`PI_CODING_AGENT_DIR=${PI_CONTAINER_HOME}/agent`)
  env.push(`PI_CODING_AGENT_SESSION_DIR=${PI_SESSIONS_CONTAINER_DIR}`)
  env.push(`CODEX_SQLITE_HOME=${CODEX_SQLITE_CONTAINER_DIR}`)
  env.push('PI_SKIP_VERSION_CHECK=1')
  // Containerless: one pnpm store per project, so each workspace's
  // `node_modules` hardlinks into it instead of holding a full copy. Set
  // under both names since pnpm 11+ reads only `pnpm_config_` and 10.x only
  // `npm_config_`. Pods cannot share one: pnpm's SQLite (WAL) index needs
  // all writers on one kernel. A pod keeps its store in its `moduleDirs`.
  if (runtime.kind === 'containerless') {
    env.push(`pnpm_config_store_dir=${CACHED_PACKAGES_CONTAINER_DIR}/pnpm-store`)
    env.push(`npm_config_store_dir=${CACHED_PACKAGES_CONTAINER_DIR}/pnpm-store`)
  }

  // Decide each forwarded port's host port before launch, since the status
  // bar shows them. Only a declaration: clients hold the listeners
  // (docs/port-forward-tunnel.md).
  const forwardedPorts = runtime.declareForwards(workspaceId, config.portForward ?? [])
  for (const { containerPort, hostPort } of forwardedPorts) {
    emit(`Offering host port ${hostPort} -> container port ${containerPort}`, options)
  }

  // Inputs for yaac-workspace-init.
  env.push(`YAAC_TOOL=${tool}`)
  env.push(`YAAC_GIT_NAME=${gitUser.name}`)
  env.push(`YAAC_GIT_EMAIL=${gitUser.email}`)
  env.push(`YAAC_STATUS_RIGHT=${buildStatusRight(projectSlug, workspaceId, forwardedPorts)}`)
  if (nestedContainers) env.push('YAAC_NESTED_ENGINE=1')

  // Mounts are declared against host paths; each driver realizes them its
  // own way (k8s: subPaths of the global claim or node-local dirs;
  // containerless: symlinks). A path's storage tier (global or node-local)
  // comes from project-paths.ts. emptyDir is for pod-local scratch.
  //
  // Under k8s, opencode works on a node-local copy of its history (SQLite
  // fails on a network filesystem) and checkpoints it to the global tier.
  // Containerless opens the checkpoint directly.
  const opencodeMounts: WorkspaceMount[] = runtime.kind === 'containerless'
    ? [{ source: { kind: 'hostPath', path: opencodeCheckpoint }, mountPath: CONTAINER_OPENCODE_DATA }]
    : [
      { source: { kind: 'hostPath', path: opencodeData }, mountPath: CONTAINER_OPENCODE_DATA },
      { source: { kind: 'hostPath', path: opencodeCheckpoint }, mountPath: CONTAINER_OPENCODE_CHECKPOINT },
    ]
  const history = (part: AgentHistoryPart): string => agentHistoryDir(projectSlug, workspaceId, part)
  const mounts: WorkspaceMount[] = [
    { source: { kind: 'hostPath', path: wtDir }, mountPath: '/workspace' },
    // Read-only, at the server's own path: the checkout's alternates file
    // names this path (docs/server-git.md).
    { source: { kind: 'hostPath', path: `${repo}/.git` }, mountPath: `${repo}/.git`, readOnly: true },
    { source: { kind: 'hostPath', path: claude }, mountPath: '/home/yaac/.claude' },
    ...(acpLogs !== undefined
      ? [{ source: { kind: 'hostPath' as const, path: acpLogs }, mountPath: CONTAINER_ACP_LOG_DIR }]
      : []),
    { source: { kind: 'hostPath', path: attachments }, mountPath: CONTAINER_ATTACHMENTS_DIR, readOnly: true },
    ...codexHomeMounts(runtime.kind, codex),
    ...opencodeMounts,
    { source: { kind: 'hostPath', path: opencodeConfig }, mountPath: OPENCODE_CONFIG_CONTAINER_DIR },
    { source: { kind: 'hostPath', path: pi }, mountPath: PI_CONTAINER_HOME },
    // Per-workspace history. These two are outside every tool home, so both
    // drivers can mount them as-is.
    { source: { kind: 'hostPath', path: history('codex-sqlite') }, mountPath: CODEX_SQLITE_CONTAINER_DIR },
    { source: { kind: 'hostPath', path: history('pi') }, mountPath: PI_SESSIONS_CONTAINER_DIR },
    // The rest sit inside the shared tool homes, so they are layered over
    // them, with claude's shared project memory put back on top. Without
    // layering, convergeAgentHistory links them instead.
    ...(layersToolHomes
      ? [
        { source: { kind: 'hostPath' as const, path: history('claude') }, mountPath: `${CLAUDE_CONTAINER_HOME}/projects` },
        {
          source: { kind: 'hostPath' as const, path: path.join(claude, 'projects', CLAUDE_POD_REPO, 'memory') },
          mountPath: `${CLAUDE_CONTAINER_HOME}/projects/${CLAUDE_POD_CWD}/memory`,
        },
        { source: { kind: 'hostPath' as const, path: history('claude-file-history') }, mountPath: `${CLAUDE_CONTAINER_HOME}/file-history` },
        { source: { kind: 'hostPath' as const, path: history('codex') }, mountPath: `${CODEX_CONTAINER_HOME}/sessions` },
      ]
      : []),
    // Containerless only: the project's pnpm store (see the env above).
    ...(runtime.kind === 'containerless'
      ? [{ source: { kind: 'hostPath' as const, path: cachedPackages }, mountPath: CACHED_PACKAGES_CONTAINER_DIR }]
      : []),
    // The tmux socket; every client reaches it from inside the pod.
    { source: { kind: 'emptyDir' }, mountPath: CONTAINER_TMUX_DIR },
    // Global, so the next workspace gets the warm cache wherever it runs.
    ...cacheVolumeEntries.map(([key, containerPath]): WorkspaceMount => ({
      source: { kind: 'hostPath', path: cacheVolumeDir(projectSlug, key) },
      mountPath: containerPath,
    })),
    // Server-staged skills and helper commands. Without layering the skills
    // are already linked in.
    ...(layersToolHomes ? builtinSkillMounts(builtinSkillsStaging, builtinSkillNames) : []),
    ...workspaceBinMounts(workspaceBinStaging, workspaceBinNames),
  ]

  // Without a proxy to inject auth, the workspace's git needs the real
  // credential: the checkout's `origin` URL carries no token.
  let gitCredential: WorkspaceGitCredential | undefined
  if (!mediatedEgress) {
    gitCredential = credential.kind === 'https'
      ? { kind: 'https', host: parsedRemote.host, token: credential.token }
      : { kind: 'ssh', privateKey: await sshKeyMaterial(credential.id) }
  }

  const spec: WorkspaceSpec = {
    projectSlug,
    workspaceId: workspaceId,
    tool,
    mode,
    prewarm: options.prewarm === true,
    ...(imageRef !== undefined ? { image: imageRef } : {}),
    env,
    secretEnvKeys,
    mounts,
    moduleDirs,
    resources: WORKSPACE_RESOURCES,
    // In-workspace setup (git identity, tmux, agent transport, nested
    // engine); the runtime reports ready only after it finishes.
    postStartExec: [`/usr/local/bin/${WORKSPACE_INIT_SCRIPT}`],
    // A pod checkpoints and clears its opencode working copy on stop, so it
    // leaves nothing on its node. Containerless keeps no working copy.
    ...(runtime.kind === 'containerless'
      ? {}
      : { preStopExec: [`/usr/local/bin/${OPENCODE_CHECKPOINT_SCRIPT}`, 'stop'] }),
    nestedContainers,
    ...(sshKnownHostsFile !== undefined ? { ssh: { knownHostsFile: sshKnownHostsFile } } : {}),
    ...(gitCredential !== undefined ? { gitCredential } : {}),
    substrate,
    onProgress: (m) => emit(m, options),
  }

  // What a teardown must address, once the runtime has launched.
  let target: TeardownTarget | undefined
  let handle: RuntimeHandle
  try {
    mergeEnvEntries(env, (name) => projectSets(name)
      ? `the project's environment variable ${name} conflicts with the value yaac sets for it; rename or remove it`
      : `environment variable ${name} is set to two different values`)
    handle = await launchWithSetup({
      spec, projectSlug, workspaceId, tool, mode, launching, initWindows, permissionMode,
      piProvider: toolAuthByTool.pi?.piProvider,
      onLaunched: (h) => {
        target = { projectSlug, workspaceId: workspaceId, unitName: h.jobName }
      },
      options, workspace: workspaceTask,
    })
  } catch (err) {
    // Tear down the half-started unit, or it would list as a bogus
    // workspace and collide with a relaunch. Keep the prepared substrate
    // (`unitOnly`) when the row survives (resume, spare). A fresh create
    // tears down everything, since its row is about to go.
    const unitOnly = !failedCreateCollectsCheckout(options)

    // If `launch` failed after the unit was created, `onLaunched` never
    // ran, so ask the runtime what exists. `podGone` gates the checkout
    // removal below; an unreachable runtime counts as not gone. Only a
    // unit of this project is torn down.
    let podGone: boolean
    try {
      target ??= await workspaceDriver().findForTeardown(workspaceId, { spares: options.prewarm === true })
      if (target !== undefined && target.projectSlug !== projectSlug) target = undefined
      podGone = target === undefined
        ? true
        : await workspaceDriver().destroy(target, { salvageImages: false, unitOnly })
    } catch {
      podGone = false
    }

    // Free the declared host ports for the next create.
    await workspaceDriver().deregisterWorkspace(workspaceId)
      .catch(() => { /* best-effort; the reaper covers what this misses */ })
    if (!options.prewarm) {
      // A fresh create deletes its own checkout (see
      // failedCreateCollectsCheckout); no row-based sweep would find it
      // once the row is gone. Chained after the checkout leg, which may
      // still be running after a pod-side failure and would otherwise
      // recreate the dir after the delete. Each step runs only if the
      // previous one succeeded; if the row stays, the stale reaper turns it
      // into a stopped workspace the user can delete.
      if (failedCreateCollectsCheckout(options)) {
        void workspaceTask
          .catch(() => { /* the failure is already the caller's */ })
          .then(() => podGone && deleteWorkspaceState(projectSlug, workspaceId))
          .then((removed) => (removed
            ? reportCreateFailed(projectSlug, workspaceId, options)
            : undefined))
          .catch(() => { /* best-effort; nothing else can retry it */ })
      } else {
        await reportCreateFailed(projectSlug, workspaceId, options)
      }
    }
    throw err
  }

  // A spare's agent is handed over when it is claimed.
  if (options.prewarm !== true) {
    await handOverAgent({
      projectSlug,
      workspaceId,
      jobName: handle.jobName,
      tool,
      mode,
      ...(options.initialPrompt !== undefined ? { prompt: options.initialPrompt } : {}),
      emit: (message) => emit(message, options),
    })
  }

  return {
    workspaceId,
    jobName: handle.jobName,
    forwardedPorts,
    tool,
    mode,
  }
}
