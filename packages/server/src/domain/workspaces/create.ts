import fs from 'node:fs/promises'
import path from 'node:path'
import crypto, { createHash } from 'node:crypto'
import { allowlistAllows } from '#lib/allowed-hosts'
import { buildStatusRight } from '#lib/status-right'
import { mergeEnvEntries } from '#lib/env-entries'
import { testEnv } from '@yaac/shared/env'
import { workspaceDriver, workspacesSandboxed } from '#drivers/driver'
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
  terminalLogDir,
  agentHistoryDir,
  type AgentHistoryPart,
  CLAUDE_POD_CWD,
  CLAUDE_POD_REPO,
  claudeDir,
  codexDir,
  opencodeCheckpointDir,
  opencodeConfigDir,
  opencodeDataDir,
  ompDir,
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
  CONTAINER_TERMINAL_LOG_DIR,
  CONTAINER_OPENCODE_CHECKPOINT,
  CONTAINER_OPENCODE_DATA,
  CONTAINER_TMUX_DIR,
} from '@yaac/shared/paths'
import { buildCloneLinkExec, buildStatusWarmupExec } from '@yaac/shared/git'
import { parseGitRemote } from '@yaac/shared/git-remote'
import { fetchProjectCommit, fetchProjectOrigin, missingCredentialError, resolveProjectCredential, resolveProjectEnv, seedProjectOrigin, sshKeyMaterial } from '#domain/projects'
import { ghApiHostForGitHost } from '@yaac/shared/credentials'
import { readLock } from '@yaac/shared/lock'
import {
  PLACEHOLDER_API_KEY,
  PLACEHOLDER_GH_TOKEN,
  PLACEHOLDER_OMP_API_KEY,
  PLACEHOLDER_OPENCODE_API_KEY,
  PLACEHOLDER_PI_API_KEY,
} from '@yaac/shared/tool-auth'
import { NO_CREDENTIALS_OWNER_KEY, authEntryEndpoint, authEntryProvider, credentialOwnerKey, defaultModelFor, isCatalogModel, loadToolAuthEntry, modelEfforts, seedProjectToolHome, toolKeyProviders } from '#domain/auth'
import {
  createCheckout,
  getDefaultBranch,
  isGitAuthError,
  remoteBranchExists,
  writeKnownHostsFile,
} from '#domain/git'
import { serverLog } from '#lib/log'
import type { AcpConversation } from '#runtime/agents'
import { AgentLaunchDeadError, buildWindowsExec, ensureAgentReporters, ensureOmpSettings, ensureToolApiKeyConfig, finishSetupCommand, verifyAgentWindowAlive, whenAcpConversation, openSandboxDir } from '#runtime/agents'
import {
  applyWorkspaceEvent,
  getGitIdentity,
  getProjectRow,
  getTimeZone,
  getWorkspaceRow,
  insertSession,
  listWorkspaceSessions,
  markSessionsLaunched,
  setWorkspaceMamaTokenHash,
  unstageVolume,
  type SessionLaunchSettings,
  type SessionRow,
  type VolumeLease,
} from '#db'
import { leaveOpenings, sessionLaunches } from './session-launch'
import { reportAgentLaunchFailure, throwIfProvisionStopped } from './provisioning'
import { recordTrackedScratchDirs } from './tracked-scratch-dirs'
import { spareSettings } from './prewarm'
import { CODEX_CONTAINER_HOME, codexHomeMounts } from './codex-home'
import {
  prepareScratchDirs,
  seedClaudeJson,
  seedClaudeSettings,
} from './seed'
import {
  builtinSkillsDir, stageBuiltinSkills, builtinSkillMounts, reconcileSharedSkillRoots,
} from '#domain/skills'
import { convergeAgentHistory } from './history'
import { deleteWorkspaceState } from './cleanup'
import { attachVolume, stageVolume } from './volumes'
import { lifeHooksExec, recordLife, startStepsOf } from './life'
import { offeredForwards } from './forward-port'
import type { StepGraph } from '@yaac/shared/steps'
import { ACP_CONVERSATION_WAIT_MS } from './conversation-registry'
import {
  OPENCODE_CHECKPOINT_SCRIPT,
  WORKSPACE_INIT_SCRIPT,
  workspaceBinDir,
  workspaceBinMounts,
  stageWorkspaceBin,
} from './workspace-bin'
import { ServerError } from '@yaac/shared/errors'
import { waitFor } from '@yaac/shared/wait-for'
import {
  ACP_ADAPTERS,
  AGENT_CLIS,
  DEFAULT_AGENT_MODE,
  defaultPermissionMode,
  effortFor,
  launchablePermissionMode,
  resolveAgentOptions,
  resolveToolCreateDefaults,
  SUPPORTED_PERMISSION_MODES,
  TOOL_LABELS,
  toolAgentOptions,
  toolSupportsPermissionMode,
  type AgentMode,
  type AgentOption,
  type AgentOptions,
  type AgentTool,
  type DriverKind,
  type PermissionMode,
  type PortMapping,
} from '@yaac/shared/types'
import { toolApiKeyEnvVar, type CustomEndpoint } from '@yaac/shared/tool-providers'

/** In-pod claude home, where `claudeDir` is mounted. `CLAUDE_CONFIG_DIR`
 *  points here, which also puts claude's global config at
 *  `<here>/.claude.json`. */
const CLAUDE_CONTAINER_HOME = '/home/yaac/.claude'
/** The project's package cache, shared by its workspaces: pnpm's store and
 *  the backing dirs of the scratch-dirs mounts. */
const CACHED_PACKAGES_CONTAINER_DIR = '/home/yaac/.cached-packages'
/** In-pod pi home, where the project's shared `piDir` is mounted. */
const PI_CONTAINER_HOME = '/home/yaac/.pi'
/** In-pod opencode config dir, where the project's `opencodeConfigDir` is
 *  mounted. */
const OPENCODE_CONFIG_CONTAINER_DIR = '/home/yaac/.config/opencode'
/** Where pi writes its JSONL session logs (PI_CODING_AGENT_SESSION_DIR).
 *  Per-workspace history, kept outside the shared home so a pod can mount it
 *  as-is. */
const PI_SESSIONS_CONTAINER_DIR = '/home/yaac/.yaac-pi-sessions'
/** In-pod omp home, where the project's shared `ompDir` is mounted. */
const OMP_CONTAINER_HOME = '/home/yaac/.omp'
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
  workspaceId: string
  /**
   * The session a fresh create opens, its settings resolved and checked;
   * absent for a workspace that runs no agent, and for a resume, which
   * brings back the sessions it had.
   */
  session?: SessionLaunchSettings
  /**
   * Reference branch for the fresh workspace (a branch on `origin`, no
   * `origin/` prefix); unset → the remote's default branch. A resume passes
   * the row's base branch, used only if its checkout is gone.
   */
  branch?: string
  /**
   * A full commit to create the checkout at, in place of a branch's tip;
   * the workspace then has no base branch. A resume of a workspace with no
   * base branch passes its start commit, used only if its checkout is gone.
   */
  commit?: string
  /**
   * A fresh create's start workflow (docs/workflows.md), with the named
   * workflow it was chosen through: absent runs the project's init steps. A
   * resume starts what its row names.
   */
  workflow?: { id: string; steps: StepGraph; name?: string }
  /** Run `steps` untouched and stop when they settle. */
  nonInteractive?: boolean
  /** The non-interactive workspace this one reruns. */
  rerunOf?: string
  /**
   * The run secrets its revision gets, with their values
   * (`workflowLaunch`), for a non-interactive create or a site's release.
   * Refused on any other.
   */
  runSecrets?: Record<string, string>
  /**
   * Resume an existing workspace (a restart): reuse its checkout if present,
   * and relaunch each of its open sessions in its own window, resuming its
   * conversation (`sessionLaunches`).
   */
  resume?: boolean
  /**
   * Provision a prewarmed spare, hidden from user-facing views until a later
   * `workspace create` claims it. Set only by the prewarm reconciler.
   */
  prewarm?: boolean
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
  /** The title generated for the draft or queued entry it is created from. */
  generatedTitle?: string
  /** When the server stops it (`workspaces.deadline`). A resume without one
   *  clears the deadline the workspace had. */
  deadline?: Date
  /** The volume it mounts, already checked by `volumeForLaunch`; its
   *  lease is taken just before launch (docs/workspace-volumes.md). */
  volumeId?: string
  /**
   * A public site's release (docs/public-sites.md): the site's id, the
   * image to launch in place of the project's current one (a replacement
   * runs its predecessor's), the volume it mounts as next holder while
   * another release may still hold it, and the release whose node it must
   * share while both mount that volume.
   */
  siteId?: string
  image?: string
  stageVolumeId?: string
  colocateWith?: string
  /**
   * Called with each user-visible progress message. The HTTP route streams
   * them to the CLI as NDJSON events.
   */
  onProgress?: (message: string) => void
}

/** Refuse a resume's checkout over `dir` if it holds the user's files. */
async function refuseCheckingOutOver(dir: string): Promise<void> {
  if (!await holdsFiles(dir)) return
  throw new ServerError(
    'CONFLICT',
    `${dir} holds files but no .git, so restarting would check out over them. `
    + 'Restore its .git or move the files aside, then restart.',
  )
}

/** Whether `dir` holds anything but empty directories; a missing one holds
 *  nothing. Links count as files and are not followed. */
async function holdsFiles(dir: string): Promise<boolean> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  })
  for (const e of entries) {
    if (!e.isDirectory() || await holdsFiles(path.join(dir, e.name))) return true
  }
  return false
}

export interface WorkspaceCreateResult {
  workspaceId: string
  jobName: string
  forwardedPorts: PortMapping[]
  /** The session a fresh create opened. */
  sessionId?: string
  /** The image it launched, where the driver runs images. */
  image?: string
}

/**
 * Resource requests and limits for one workspace. This is policy, sized for
 * ordinary developer hardware, so it lives here rather than in a driver.
 */
const WORKSPACE_RESOURCES: WorkspaceResources = {
  // An idle workspace already holds about 1 GiB, so the request covers that
  // plus room to spike. Less, and a node fills with workspaces whose idle
  // use alone nearly exhausts it, and one burst OOM-kills its neighbours.
  memoryRequestBytes: 2 * 1024 ** 3,
  // Room for a workspace driving a headless browser, which reaches
  // 11-19 GiB. Eviction, not this cap, handles a node full of workspaces.
  memoryLimitBytes: 16 * 1024 ** 3,
  // Matches the 2Gi memory request at 4 GB/core, so cpu and memory cap
  // concurrent workspaces at about the same count (16 on 8 cores/32 GB).
  cpuRequestMillis: 500,
  // Half a 16-core machine: enough for heavy parallel work, but one
  // workspace cannot take the whole node.
  cpuLimitMillis: 8000,
  // Repo, checkout and caches are on mounts. This covers the writable layer,
  // logs and pod-local scratch; the limit only bounds a runaway workspace.
  // The k8s driver adds the `scratchDirs` volumes' budget on top.
  ephemeralStorageRequestBytes: 2 * 1024 ** 3,
  ephemeralStorageLimitBytes: 16 * 1024 ** 3,
}

interface WorkspaceSetupParams {
  spec: WorkspaceSpec
  projectId: string
  workspaceId: string
  /** The sessions to bring up, in order. */
  sessions: SessionRow[]
  /** The life this launch starts, absent for a prewarmed spare, which
   *  starts one when it is claimed. */
  life: Date | undefined
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
  /** The checkout predates this launch, so it must be relinked to the main
   *  clone and `remoteUrl`, and its `origin/*` brought up to date. */
  reusedCheckout: boolean
  remoteUrl: string
}

/**
 * Launch the workspace's runtime and run the in-workspace setup, which opens
 * its sessions' windows. On failure the caller tears down what was launched.
 * Everything here goes through the driver contract. Resolves with the
 * runtime.
 */
async function launchWithSetup(params: WorkspaceSetupParams): Promise<RuntimeHandle> {
  const {
    spec, projectId, workspaceId, sessions, life, onLaunched, options, workspace, reusedCheckout, remoteUrl,
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

  // An acp agent reads nothing from the checkout until its conversation
  // opens, so one going into a checkout this create is writing starts now,
  // and acpd holds the conversation until the checkout's `.git` lands. The
  // adapter's boot then overlaps the checkout. Containerless only: there
  // acpd ships with this server, while a pod's comes from its image, which
  // may predate `--wait-for`. The life's log hooks go first, since a
  // session's window is logged into the life's dir as it opens.
  const early = runtime.kind === 'containerless' && !reusedCheckout && sessions.every((s) => s.mode === 'acp')
  const launches = await sessionLaunches(projectId, workspaceId, sessions, paths, { beforeCheckout: early })
  const tools = [...new Set(launches.map((l) => TOOL_LABELS[l.tool]))]
  const announceAgents = (): void => {
    throwIfProvisionStopped(workspaceId)
    if (tools.length > 0) emit(`Starting ${tools.join(', ')}...`, options)
  }
  const windows = [
    ...(life !== undefined ? [await lifeHooksExec(projectId, workspaceId, life, paths)] : []),
    buildWindowsExec(launches, paths),
  ].filter((cmd) => cmd !== '')
  const opensEarly = early && launches.length > 0
  if (opensEarly) {
    announceAgents()
    await runtime.exec(jobName, windows.join(' && '))
  }

  // Everything below reads the checkout, so join it now.
  await workspace

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

  // Then the life's log hooks and the sessions, unless they opened early,
  // in one command with the checkout's own setup to save round
  // trips, ending with the mark that setup is done, which lets the step
  // reconcile open the life's steps. A checkout this create made already
  // borrows from the main clone and holds its current refs; a reused one is
  // relinked so the agent starts current. A pod's file cache is warmed,
  // which a host's needs no help with.
  const setup = [
    ...(reusedCheckout ? [buildCloneLinkExec(path.join(repoDir(projectId), '.git'), paths.workspaceDir, remoteUrl)] : []),
    ...(runtime.kind === 'containerless' ? [] : [buildStatusWarmupExec(paths.workspaceDir)]),
    ...(opensEarly ? [] : windows),
    finishSetupCommand(paths),
  ]
  if (!early) announceAgents()
  await leaveOpenings({ projectId, workspaceId, jobName }, launches)
  await runtime.exec(jobName, setup.join(' && '))
  await markSessionsLaunched(launches.map((l) => l.session.id))

  // Check the agents actually started: opening a window succeeds even when
  // its command dies instantly. Not awaited, since the probe must wait for a
  // doomed command to exit; a failure lands later as a failed provisioning
  // row (reportAgentLaunchFailure). A `tui` agent is probed once, a moment
  // after launch. An acp adapter can also die later, before its handshake
  // ends (claude's fails at `session/new` on a bad login), so its windows
  // are watched until their conversations come up.
  for (const l of launches) {
    const { session } = l
    const launched = session.mode === 'tui'
      ? verifyAgentWindowAlive(jobName, [l.window])
      : whenAcpAgentUp(projectId, workspaceId, jobName, l.window)
    const installed = session.mode === 'tui'
      ? { binary: l.tool, package: AGENT_CLIS[l.tool].package, version: AGENT_CLIS[l.tool].version }
      : { binary: ACP_ADAPTERS[l.tool].binary, package: ACP_ADAPTERS[l.tool].package, version: ACP_ADAPTERS[l.tool].verified }
    void launched.catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      serverLog(`[server] create ${workspaceId}: ${message}`)
      // Report only a confirmed dead agent of a fresh create's session. A
      // failed provisioning row hides the workspace, so a probe that got no
      // answer must not report one, and a restart's agent that dies is left
      // as an exited session.
      if (!(err instanceof AgentLaunchDeadError) || options.session === undefined) return
      void reportAgentLaunchFailure({
        workspaceId,
        projectId,
        tool: l.tool,
        kind: 'create',
        ...(session.firstPrompt !== undefined ? { prompt: session.firstPrompt } : {}),
        error: runtime.kind === 'containerless'
          ? `${message}. Check that "${installed.binary}" runs on this host `
            + `(yaac runs its own install of ${installed.package}@${installed.version}).`
          : message,
      })
    })
  }

  return handle
}

/**
 * Wait for an acp session's conversation to be named (`session/new`
 * answered). Rejects with `AgentLaunchDeadError` if its window's agent
 * exits first, which the window probe (an exec) checks every two seconds,
 * and resolves with undefined at the deadline.
 */
export async function whenAcpAgentUp(
  projectId: string,
  workspaceId: string,
  jobName: string,
  window: string,
): Promise<AcpConversation | undefined> {
  let settled = false
  const conversation = whenAcpConversation(projectId, workspaceId, window, ACP_CONVERSATION_WAIT_MS)
    .finally(() => { settled = true })
  const windowGone = waitFor(async () => settled || await verifyAgentWindowAlive(jobName, [window])
    .then(() => false, (err: unknown) => err instanceof AgentLaunchDeadError),
  { timeoutMs: ACP_CONVERSATION_WAIT_MS, intervalMs: 2_000 })
  const outcome = await Promise.race([
    conversation,
    windowGone.then<AcpConversation | 'dead' | undefined>((stop) => (stop && !settled ? 'dead' : conversation)),
  ])
  if (outcome === 'dead') {
    throw new AgentLaunchDeadError(`acp agent "${window}" exited in ${jobName} before its handshake`)
  }
  if (outcome === undefined) {
    serverLog(`[server] create ${workspaceId}: no acp conversation on ${window} after `
      + `${String(ACP_CONVERSATION_WAIT_MS / 1000)}s`)
  }
  return outcome
}

/**
 * Whether a failed create deletes its checkout: only when this create made
 * it, which is every create but a resume. A resume's checkout predates it
 * and holds the user's work, which exists nowhere else.
 */
export function failedCreateCollectsCheckout(
  options: Pick<WorkspaceCreateOptions, 'resume'>,
): boolean {
  return options.resume === undefined
}

/**
 * Report that a create gave up so the matching `workspace-created` can be
 * undone. `#db` decides what undo means for a resume (apply-workspace-event.ts).
 */
async function reportCreateFailed(
  projectId: string,
  workspaceId: string,
  options: WorkspaceCreateOptions,
): Promise<void> {
  await applyWorkspaceEvent({
    type: 'workspace-create-failed',
    projectId,
    workspaceId,
    resume: options.resume !== undefined,
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
  /** Absent when the model has no effort setting. */
  effort?: string
  mode: AgentMode
  /** Every option the tool has. */
  agentOptions: AgentOptions
}

/**
 * Resolve a create's settings field by field: the request's value, else what
 * this project last used for that tool (`project_tool_defaults`) if still
 * valid, else `resolveToolCreateDefaults`. The tool itself defaults to the
 * project's last tool, else claude.
 *
 * A requested permission mode, effort or agent option the tool or model
 * lacks is refused; a remembered one it lacks falls back to the default. Restart skips this
 * and calls `createWorkspace` directly.
 */
export async function resolveCreate(
  projectId: string,
  request: {
    tool?: AgentTool
    model?: string
    permissionMode?: PermissionMode
    effort?: string
    mode?: AgentMode
    agentOptions?: AgentOptions
  },
): Promise<CreateSetup> {
  const row = await getProjectRow(projectId)
  const tool = request.tool ?? row?.lastTool ?? 'claude'
  const remembered = row?.createDefaults[tool]
  const mode = request.mode ?? remembered?.mode ?? DEFAULT_AGENT_MODE
  const driver = workspaceDriver().kind
  const auth = row && await loadToolAuthEntry(row.owner, tool)
  const provider = authEntryProvider(auth)
  const endpoint = authEntryEndpoint(auth)
  const fallback = resolveToolCreateDefaults({
    driver,
    tool,
    remembered,
    ...(provider !== undefined ? { provider } : {}),
    defaultModel: defaultModelFor(tool, provider, endpoint),
    effortsFor: (model) => modelEfforts(tool, model, endpoint),
  })
  const model = request.model ?? fallback.model
  const effort = request.effort !== undefined
    ? namedEffort(tool, model, request.effort, endpoint)
    // A named model re-resolves the remembered effort against itself.
    : request.model !== undefined
      ? rememberedEffort(tool, model, remembered?.effort, endpoint)
      : fallback.effort
  return {
    tool,
    ...(model !== '' ? { model } : {}),
    permissionMode: request.permissionMode !== undefined
      ? launchPermissionMode({ tool, driver, requested: request.permissionMode })
      : fallback.permissionMode,
    ...(effort !== undefined ? { effort } : {}),
    mode,
    agentOptions: resolveAgentOptions(tool, namedAgentOptions(tool, request.agentOptions), remembered?.agentOptions),
  }
}

/** Named agent options, refused when the tool lacks one. */
function namedAgentOptions(tool: AgentTool, options: AgentOptions | undefined): AgentOptions | undefined {
  const lacking = Object.keys(options ?? {}).filter((o) => !toolAgentOptions(tool).includes(o as AgentOption))
  if (lacking.length > 0) throw new ServerError('VALIDATION', `${tool} has no agent option ${lacking.join(', ')}`)
  return options
}

/** A remembered effort where `model` has it, else its default; none for a
 *  model without effort levels. */
function rememberedEffort(
  tool: AgentTool,
  model: string,
  remembered: string | undefined,
  endpoint: CustomEndpoint | undefined,
): string | undefined {
  const efforts = modelEfforts(tool, model, endpoint)
  return efforts !== undefined ? effortFor(efforts, remembered) : undefined
}

/**
 * A named effort, refused when the model's levels are known and lack it. A
 * model outside the catalog takes it as is, like a named model.
 */
function namedEffort(tool: AgentTool, model: string, effort: string, endpoint: CustomEndpoint | undefined): string {
  const efforts = modelEfforts(tool, model, endpoint)
  if (efforts !== undefined && !efforts.levels.includes(effort)) {
    throw new ServerError(
      'VALIDATION',
      `${model} has no "${effort}" effort; it supports: ${efforts.levels.join(', ')}`,
    )
  }
  if (efforts === undefined && model !== '' && isCatalogModel(tool, model, endpoint)) {
    throw new ServerError('VALIDATION', `${model} has no effort setting`)
  }
  return effort
}

export async function createWorkspace(
  projectId: string,
  options: WorkspaceCreateOptions,
): Promise<WorkspaceCreateResult> {
  const { workspaceId } = options
  const runtime = workspaceDriver()
  // Sandboxed, the workspace holds only placeholder credentials that the
  // proxy swaps, and per-workspace mounts sit over the shared tool homes.
  // Otherwise it must hold the real secrets, and skills and history are
  // linked into the shared homes instead (#domain/skills, and history.ts
  // here).
  const sandboxed = workspacesSandboxed()

  await runtime.ensureRuntimeReachable()

  const projectRow = await getProjectRow(projectId)
  if (!projectRow) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  const { remoteUrl, owner } = projectRow

  const gitUser = await getGitIdentity(owner)
  if (!gitUser) {
    throw new ServerError(
      'VALIDATION',
      'This project\u2019s owner has no git identity set, so a workspace would commit as nobody. '
      + 'Set yours in Settings \u2192 General, or with '
      + '`yaac config git-identity --name <name> --email <email>`.',
    )
  }

  const repo = repoDir(projectId)

  const { portForwards, cacheVolumes, nestedContainers, npmCache } = projectRow

  // Plain variables plus the secrets the egress path injects. Stored as rows,
  // since a remote client cannot set the server's own environment
  // (docs/remote-hosting.md).
  const projectEnv = await resolveProjectEnv(projectId)

  // Without a git credential the agent could neither fetch nor push. A
  // hosted remote is the server itself, so it has no host to check. A site's
  // release runs no git of its own (the server makes its checkout), so it is
  // given none and needs none.
  const remoteHost = projectRow.hosted ? null : parseGitRemote(remoteUrl).host
  const credential = options.siteId === undefined ? await resolveProjectCredential(projectId) : undefined
  if (!credential && options.siteId === undefined) throw missingCredentialError(projectRow.name)

  // Started before anything else, since the network is the slowest leg. The
  // checkout runs alongside it (`createCheckout`'s `fetched`). e2e fixtures
  // pre-populate the repo, so the fetch is skipped there.
  if (!testEnv.e2eSkipFetch) emit('Fetching latest from remote...', options)
  const fetched = testEnv.e2eSkipFetch
    ? Promise.resolve()
    : fetchProjectOrigin(projectId).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      if (remoteHost !== null && isGitAuthError(msg)) {
        throw new ServerError(
          'VALIDATION',
          `git authentication failed for ${remoteHost} — the project's credential was `
          + 'rejected (expired or revoked?). Assign it a new one in Settings → Git credentials, '
          + 'then retry.',
        )
      }
      throw new ServerError('INTERNAL', `could not fetch from remote: ${msg}`)
    })
  fetched.catch(() => { /* awaited by the checkout leg */ })

  // Fail now rather than let the agent hit a confusing proxy 403 on fetch.
  // Containerless has no proxy, so nothing to check, and the proxy relays
  // a hosted remote before it reads the allowlist.
  const allowlist = projectRow.egressAllowlist
  if (runtime.kind !== 'containerless' && remoteHost !== null && !allowlistAllows(allowlist, remoteHost)) {
    throw new ServerError(
      'VALIDATION',
      `Project remote host "${remoteHost}" is not in the egress allowlist. `
      + 'Add it in Settings \u2192 Project Config.',
    )
  }

  // The sessions this create brings up: a fresh create's one, or the ones a
  // resume had open.
  const resumed = options.resume === true ? await listWorkspaceSessions(workspaceId) : []
  const planned: Array<Pick<SessionRow, 'tool' | 'mode' | 'permissionMode'>> = options.session !== undefined
    ? [options.session]
    : resumed
  // Check this runtime can run each tool in its mode (a host installs the
  // pinned version on first use). Otherwise the workspace would die seconds
  // after reporting success. A fresh create's base branch is read alongside.
  const [, refBranch] = await Promise.all([
    Promise.all([...new Map(planned.map((s) => [`${s.tool}|${s.mode}`, s])).values()].map((s) =>
      runtime.assertCanLaunch({ tool: s.tool, mode: s.mode, onProgress: (message) => { emit(message, options) } }))),
    options.resume === true || options.commit !== undefined ? undefined : options.branch ?? getDefaultBranch(repo),
  ])

  // Warn: containerless has no sandbox, so bypass acts as the user on this
  // machine.
  if (planned.some((s) => s.permissionMode === 'bypass') && runtime.kind === 'containerless') {
    options.onProgress?.(
      'Note: this workspace runs with bypass permissions, and this server has '
      + 'no sandbox — the agent acts as you, on this machine.',
    )
  }

  // A resume reuses its checkout as it stands. One with files but no `.git`
  // (lost to a crash or a partial restore) is refused: checking out into it
  // would overwrite every tracked file with the base branch. Only a missing
  // `.git` counts as lost, so a read error fails the restart instead.
  const wtDir = workspaceDir(projectId, workspaceId)
  const reuseCheckout = options.resume === true && await fs.access(path.join(wtDir, '.git')).then(
    () => true,
    (err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw err
    },
  )
  if (options.resume === true && !reuseCheckout) await refuseCheckingOutOver(wtDir)
  // Record the row before provisioning anything, so no user workspace's pod
  // exists without one (a rowless pod is invisible to titles, groups and
  // restart). The insert also claims the id: a fresh create reusing a taken
  // id stops here, before touching that workspace's checkout. Title and
  // group go in with it, so the workspace shows in its group while it
  // provisions.
  //
  // A prewarmed spare gets no row until it is claimed; its settings are
  // kept in memory for the claim to match on, once its image is known. The
  // base branch is recorded now because a workspace queued after this one
  // defaults to it. The user's zone, as clients report it; a pod otherwise
  // runs in UTC, and a containerless server's host need not be where the
  // user is. Recorded so a spare warmed in another zone is never claimed.
  const { timeZone } = await getTimeZone(owner)
  const launch = {
    ...(refBranch !== undefined ? { baseBranch: refBranch } : {}),
    ...(timeZone !== null ? { timeZone } : {}),
    scratchDirs: projectRow.scratchDirs.dirs.map((d) => d.path),
  }
  throwIfProvisionStopped(workspaceId)
  if (options.prewarm !== true) {
    await applyWorkspaceEvent({
      type: 'workspace-created',
      projectId,
      workspaceId,
      ...launch,
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.generatedTitle !== undefined ? { generatedTitle: options.generatedTitle } : {}),
      ...(options.groupId !== undefined ? { groupId: options.groupId } : {}),
      ...(options.deadline !== undefined ? { deadline: options.deadline } : {}),
      ...(options.workflow !== undefined ? { workflowId: options.workflow.id } : {}),
      ...(options.workflow?.name !== undefined ? { workflowName: options.workflow.name } : {}),
      ...(options.nonInteractive === true ? { nonInteractive: true } : {}),
      ...(options.rerunOf !== undefined ? { rerunOf: options.rerunOf } : {}),
      ...(options.siteId !== undefined ? { siteId: options.siteId } : {}),
      resume: options.resume === true,
    })
  }

  // Pre-create the checkout dir so its hostPath mount (type Directory)
  // works while the checkout is still running.
  await fs.mkdir(wtDir, { recursive: true })
  // Create the scratch-dir mount points (inside the checkout) now;
  // otherwise the pod may create them root-owned 0700. createCheckout copes
  // with the non-empty destination.
  const scratchDirs = await prepareScratchDirs(wtDir, projectRow.scratchDirs.dirs)

  // A new life starts once the row exists, before any session is launched
  // in it. A fresh create's session is recorded with its prompt; an `acp`
  // one's waits on the row for its conversation, which the registry's sweep
  // sends it (`reconcileWorkspaceConversations`). A spare has neither.
  let sessions: SessionRow[] = []
  let life: Date | undefined
  if (options.prewarm !== true) {
    life = await recordLife(projectId, workspaceId, options.resume === true
      ? await startStepsOf(projectId, await getWorkspaceRow(projectId, workspaceId))
      : options.workflow?.steps ?? await startStepsOf(projectId, undefined))
    sessions = options.session !== undefined
      ? [await insertSession(projectId, workspaceId, options.session)]
      : resumed
  }

  // ── Concurrent provisioning ─────────────────────────────────────────
  // Image, checkout, substrate and host fs prep run concurrently. The
  // checkout leg is joined later, inside launchWithSetup, so it also
  // overlaps pod boot.

  const imageTask: Promise<string | undefined> = runtime.kind === 'containerless' || options.image !== undefined
    ? Promise.resolve(options.image)
    : runtime.prepareImage({
      projectId,
      owner,
      nestedContainers,
      onProgress: (m) => emit(m, options),
    })
  imageTask.catch(() => { /* awaited at the join */ })

  // The checkout leg first gives an origin with no branches its default one,
  // so no workspace's push picks it (`seedEmptyOrigin`). That push changes
  // the remote, so it starts only here, once the checks above (credential,
  // egress allowlist, tool, the row claiming the id) have passed. Only a
  // provisioning failure can still refuse the create after it.
  const workspaceTask = (async (): Promise<string | undefined> => {
    const seeded = fetched.then(() => seedProjectOrigin(projectId, gitUser).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      if (isGitAuthError(msg)) {
        throw new ServerError(
          'VALIDATION',
          'the remote is empty, and the project\u2019s git credential cannot push the first commit '
          + 'that gives it a default branch. Give the credential push access, or push a first '
          + 'commit to the default branch yourself, then retry.',
        )
      }
      throw new ServerError('INTERNAL', `could not give the empty remote its default branch: ${msg}`)
    }))
    if (reuseCheckout) {
      await seeded
      emit(`Reusing existing workspace at ${wtDir}`, options)
      return undefined
    }
    const branch = `agent/${workspaceId}`
    const commit = options.commit
    if (commit !== undefined && (options.resume !== true || options.branch === undefined)) {
      await seeded
      await fetchProjectCommit(projectId, commit).catch((err: unknown) => {
        throw new ServerError('VALIDATION', err instanceof Error ? err.message : String(err))
      })
      if (options.resume === true) await refuseCheckingOutOver(wtDir)
      emit(`Creating workspace at ${commit.slice(0, 12)}...`, options)
      return await createCheckout(repo, wtDir, { branch, commit, remoteUrl })
    }
    if (refBranch !== undefined) {
      // A fresh create checks out from what the main clone has while the
      // fetch runs, and checks the named branch once it lands.
      emit(`Creating workspace from ${refBranch}...`, options)
      const named = options.branch
      return await createCheckout(repo, wtDir, {
        branch,
        baseBranch: refBranch,
        remoteUrl,
        fetched: seeded.then(async () => {
          if (named === undefined || await remoteBranchExists(repo, named)) return
          throw new ServerError('VALIDATION', `branch "${named}" not found on origin.`)
        }),
      })
    }
    // A resume whose checkout is gone recreates it from its recorded base
    // branch, or from the default if origin no longer has that. The default
    // is then recorded as its base branch, since the webapp compares HEAD
    // against origin's copy of whatever the row names.
    await seeded
    const base = options.branch !== undefined && !(await remoteBranchExists(repo, options.branch))
      ? await getDefaultBranch(repo)
      : options.branch ?? await getDefaultBranch(repo)
    if (base !== options.branch) {
      await applyWorkspaceEvent({ type: 'base-branch-resolved', projectId, workspaceId, baseBranch: base })
    }
    // Again, since files may have landed while the fetch ran; the module
    // dirs made since are empty, so they do not count.
    await refuseCheckingOutOver(wtDir)
    emit(`Creating workspace from ${base}...`, options)
    return await createCheckout(repo, wtDir, { branch, baseBranch: base, remoteUrl })
  })().then(async (startCommit) => {
    // A spare's are read when it is claimed, against the branch it is
    // claimed for.
    if (options.prewarm === true) return
    if (startCommit !== undefined) {
      await applyWorkspaceEvent({ type: 'start-commit-resolved', projectId, workspaceId, startCommit })
    }
    await recordTrackedScratchDirs(projectId, workspaceId, refBranch ?? options.branch ?? options.commit, launch.scratchDirs)
  })
  workspaceTask.catch(() => { /* awaited later */ })

  // Egress registration and registry plumbing, owned by the workspace.
  const substrateTask = runtime.prepareSubstrate({
    projectId,
    workspaceId: workspaceId,
    owner: options.siteId !== undefined ? NO_CREDENTIALS_OWNER_KEY : credentialOwnerKey(owner),
    config: { portForwards, cacheVolumes, nestedContainers, npmCache },
    allowlist,
    remoteUrl,
    nestedContainers,
    proxySecretRules: Object.fromEntries(
      Object.entries(projectEnv.secrets).map(([name, { rule }]) => [name, rule]),
    ),
    onProgress: (m) => emit(m, options),
  })
  substrateTask.catch(() => { /* awaited at the join */ })

  const prepTask = (async () => {
    const claude = claudeDir(projectId)
    const codex = codexDir(projectId)
    const opencodeData = opencodeDataDir(projectId, workspaceId)
    const opencodeCheckpoint = opencodeCheckpointDir(projectId, workspaceId)
    const opencodeConfig = opencodeConfigDir(projectId)
    const pi = piDir(projectId)
    const omp = ompDir(projectId)
    const cachedPackages = cachedPackagesDir(projectId)
    // acpd's conversation records. Kept under the project dir (which
    // teardown does not prune) so the server can read them after the pod is
    // gone.
    const acpLogs = acpLogDir(projectId, workspaceId)
    // Terminal logs and step scripts, kept for the same reason.
    const terminalLogs = terminalLogDir(projectId, workspaceId)
    // Pasted images (`saveWorkspaceAttachment`); must exist for its mount.
    const attachments = workspaceAttachmentsDir(projectId, workspaceId)
    // A pod's own claude `sessions/`, where claude keeps a presence file per
    // process named by its pid. Every pod of a project shares the claude
    // home, and each pod numbers its processes from 1, so claudes in
    // different pods often get the same pid and would share one file in a
    // shared `sessions/`. Kept in the state dir so it goes when the pod
    // does. Host processes have distinct pids, so containerless keeps the
    // shared one.
    const claudeSessions = path.join(workspaceStateDir(projectId, workspaceId), 'claude-sessions')
    // Pre-created so they are server-owned (and so writable in-pod) rather
    // than root-owned. None may overlap the main clone's mount. A
    // containerless project has none (docs/project-config.md).
    const cacheVolumeEntries = Object.entries(cacheVolumes)
    const repoMount = `${repo}/.git`
    for (const [key, p] of cacheVolumeEntries) {
      if (p === repoMount || p.startsWith(`${repoMount}/`) || repoMount.startsWith(`${p}/`)) {
        throw new ServerError('VALIDATION', `cacheVolumes.${key} (${p}) overlaps the project's git mount at ${repoMount}`)
      }
    }

    // Every tool's credential, not just the active one's: a prewarmed spare
    // can be switched to any tool when claimed. Alongside, the shared dirs
    // the pod mounts, made before launch since the kubelet creates missing
    // subPaths root-owned. The checkpoint holds this workspace's opencode
    // history: a pod restores from and saves back to it, containerless uses
    // it directly. Node-local dirs (`opencodeData`, `cachedPackages`) may not
    // be reachable from here; the driver creates them where the workspace
    // runs.
    const [claudeAuth, codexAuth, opencodeAuth, piAuth, ompAuth] = await Promise.all([
      loadToolAuthEntry(owner, 'claude'),
      loadToolAuthEntry(owner, 'codex'),
      loadToolAuthEntry(owner, 'opencode'),
      loadToolAuthEntry(owner, 'pi'),
      loadToolAuthEntry(owner, 'omp'),
      ...[
        claude, codex, opencodeConfig, opencodeCheckpoint, pi, omp, attachments,
        acpLogs, terminalLogs,
        ...(sandboxed ? [claudeSessions] : []),
        ...cacheVolumeEntries.map(([key]) => cacheVolumeDir(projectId, key)),
      ].map((dir) => fs.mkdir(dir, { recursive: true })),
    ])
    const toolAuthByTool = {
      claude: claudeAuth, codex: codexAuth, opencode: opencodeAuth, pi: piAuth, omp: ompAuth,
    }
    // The api-key-only tools' providers (`#runtime/agents` tool-api-keys).
    const keyProviders = toolKeyProviders({ opencode: opencodeAuth, pi: piAuth, omp: ompAuth })

    // The rest at once, since each writes files of its own (claude's
    // settings.json, which two of them update, is locked) and the agent
    // waits on all of it.
    const builtinSkillsStaging = path.join(workspaceStateDir(projectId, workspaceId), 'builtin-skills')
    const workspaceBinStaging = path.join(workspaceStateDir(projectId, workspaceId), 'bin')
    // SSH remotes need a known_hosts file, written from the host key the
    // credential was assigned with. How it reaches the workspace is the
    // driver's concern.
    const sshKnownHostsFile = credential?.kind === 'ssh' ? path.join(projectDir(projectId), 'known_hosts') : undefined
    const [opencodeConfigFile, builtinSkillNames, workspaceBinNames] = await Promise.all([
      (async () => {
        // Seed every tool's config (a retooled spare needs it too). Claude
        // gets onboarding state so it skips the first-run wizard and login,
        // and its trusted roots as the agent will see them. The homes are
        // writable by the workspace, so writes go through a sandboxed dir
        // handle that replaces a planted symlink rather than following it.
        const [claudeHome, codexHome, piHome, ompHome, opencodeConfigHome] = await Promise.all([
          openSandboxDir(projectId, claude), openSandboxDir(projectId, codex),
          openSandboxDir(projectId, pi), openSandboxDir(projectId, omp),
          openSandboxDir(projectId, opencodeConfig),
        ])
        const [, , , , keys] = await Promise.all([
          (sandboxed ? Promise.resolve(['/workspace']) : withResolved([wtDir]))
            .then((roots) => seedClaudeJson(claudeHome, roots)),
          seedClaudeSettings(claudeHome, { denyWorktrees: runtime.kind !== 'containerless' }),
          // The reporters that publish each agent's conversation, model and
          // mode on its pane. Best-effort: agents still run without them.
          ensureAgentReporters({ claude: claudeHome, codex: codexHome, pi: piHome, omp: ompHome, opencodeConfig: opencodeConfigHome })
            .catch(() => {}),
          // Not best-effort: omp would open its setup wizard at launch.
          ensureOmpSettings(ompHome),
          // Not best-effort: without it opencode, pi and omp find no key.
          ensureToolApiKeyConfig({ opencodeConfig: opencodeConfigHome, pi: piHome, omp: ompHome }, keyProviders),
        ])
        return keys.opencodeConfigFile
      })(),
      // yaac's bundled skills: a pod gets a per-workspace copy mounted
      // read-only into each tool's skills root; containerless links them
      // into the project's shared skills roots instead.
      sandboxed
        ? stageBuiltinSkills(builtinSkillsDir(), builtinSkillsStaging)
        : reconcileSharedSkillRoots(builtinSkillsDir(), projectId, 'link'),
      // In-workspace helper commands (yaac-mama, yaac-workspace-init),
      // staged like the skills.
      stageWorkspaceBin(workspaceBinDir(), workspaceBinStaging),
      // Every tool's history for this workspace in the layout this driver
      // uses (mounted over the tool homes, or linked into them).
      convergeAgentHistory(projectId, workspaceId, { layers: sandboxed }),
      // Every tool's per-project credential files. With mediated egress they
      // hold placeholders the proxy swaps; without it, the real credentials
      // (docs/containerless-driver.md), merged so a token a running
      // workspace refreshed is not overwritten (#domain/auth).
      seedProjectToolHome(projectId, owner),
      ...(credential?.kind === 'ssh' && sshKnownHostsFile !== undefined
        ? [writeKnownHostsFile([credential.knownHostsEntry], sshKnownHostsFile)]
        : []),
    ])
    if (sandboxed && builtinSkillNames.length > 0) {
      // Pre-create the skills roots and per-skill mountpoints server-owned;
      // the kubelet would create them root-owned, blocking the agent's own
      // skills and a later containerless run. Best-effort: the skills mount
      // either way.
      await reconcileSharedSkillRoots(builtinSkillsDir(), projectId, 'mountpoint')
        .catch((err: unknown) => {
          serverLog(`[server] create ${workspaceId}: skills roots: ${String(err)}`)
        })
    }

    return {
      toolAuthByTool, keyProviders, opencodeConfigFile, sshKnownHostsFile, cacheVolumeEntries,
      builtinSkillsStaging, builtinSkillNames, workspaceBinStaging, workspaceBinNames,
      claude, codex, opencodeData, opencodeCheckpoint, opencodeConfig, pi, omp,
      cachedPackages, acpLogs, terminalLogs, attachments, claudeSessions,
    }
  })()

  const [imageRef, substrate, prep] = await Promise.all([imageTask, substrateTask, prepTask])
  // The image too, so a spare that outlives an image change is never claimed.
  if (options.prewarm === true) {
    spareSettings.set(workspaceId, { ...launch, ...(imageRef !== undefined ? { image: imageRef } : {}) })
  }
  const {
    toolAuthByTool, keyProviders, opencodeConfigFile, sshKnownHostsFile, cacheVolumeEntries,
    builtinSkillsStaging, builtinSkillNames, workspaceBinStaging, workspaceBinNames,
    claude, codex, opencodeData, opencodeCheckpoint, opencodeConfig, pi, omp,
    cachedPackages, acpLogs, terminalLogs, attachments, claudeSessions,
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
  // (docs/containerless-driver.md). The same token is the workspace's
  // credential for a hosted remote.
  let mama: { token: string; origin: string | undefined } | undefined
  if (!sandboxed && !options.prewarm) {
    const mamaToken = crypto.randomBytes(32).toString('hex')
    await setWorkspaceMamaTokenHash(
      projectId,
      workspaceId,
      createHash('sha256').update(mamaToken).digest('hex'),
    )
    env.push(`YAAC_MAMA_TOKEN=${mamaToken}`)
    secretEnvKeys.push('YAAC_MAMA_TOKEN')
    // Fixed at launch: if the server later moves to another port, yaac-mama
    // and a hosted remote break until the workspace restarts.
    const lock = await readLock()
    const origin = lock ? `http://127.0.0.1:${lock.port}` : undefined
    if (origin !== undefined) env.push(`YAAC_MAMA_URL=${origin}`)
    mama = { token: mamaToken, origin }
  }

  if (timeZone !== null && !projectSets('TZ')) env.push(`TZ=${timeZone}`)

  for (const [name, value] of Object.entries(projectEnv.plain)) {
    env.push(`${name}=${value}`)
  }

  // Proxied secrets: a placeholder with mediated egress, else the value.
  for (const [name, { value }] of Object.entries(projectEnv.secrets)) {
    env.push(`${name}=${sandboxed ? 'placeholder' : value}`)
    secretEnvKeys.push(name)
  }

  // Run secrets are real values under k8s too. With mediated egress the
  // runtime holds them, handed over by `workflowLaunch`, and the spec only
  // names them, so no value is written into the workspace's own spec.
  const runSecrets = Object.entries(options.runSecrets ?? {})
  if (runSecrets.length > 0 && options.nonInteractive !== true && options.siteId === undefined) {
    throw new Error('run secrets go only to a non-interactive workspace or a site\'s release')
  }
  if (!sandboxed) {
    for (const [name, value] of runSecrets) {
      env.push(`${name}=${value}`)
      secretEnvKeys.push(name)
    }
  }

  // API-key env vars for every tool (a spare may be retooled at claim), so
  // no tool prompts for login. With mediated egress these are placeholders
  // the proxy swaps by destination host and placeholder, regardless of the
  // workspace's tool (see k8s/proxy/injection.ts); without it they are the
  // real keys.
  const apiKeyFor = (real: string, placeholder = PLACEHOLDER_API_KEY): string =>
    sandboxed ? placeholder : real
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
  // opencode, pi and omp are api-key only, and read their key from a
  // variable of their own that their config names (`ensureToolApiKeyConfig`
  // above). A keyless custom endpoint gets no variable, so no placeholder
  // reaches it.
  for (const [tool, placeholder] of [
    ['opencode', PLACEHOLDER_OPENCODE_API_KEY], ['pi', PLACEHOLDER_PI_API_KEY], ['omp', PLACEHOLDER_OMP_API_KEY],
  ] as const) {
    const auth = toolAuthByTool[tool]
    const provider = keyProviders[tool]
    if (auth?.kind !== 'api-key' || !provider || auth.apiKey === '') continue
    const name = toolApiKeyEnvVar(tool, provider.id)
    env.push(`${name}=${apiKeyFor(auth.apiKey, placeholder)}`)
    secretEnvKeys.push(name)
  }
  // A project's own `OPENCODE_CONFIG` replaces this file, and with it the
  // pointer to yaac's key and any custom endpoint.
  if (opencodeConfigFile !== undefined && !projectSets('OPENCODE_CONFIG')) {
    env.push(`OPENCODE_CONFIG=${OPENCODE_CONFIG_CONTAINER_DIR}/${opencodeConfigFile}`)
  }
  // Codex OAuth reads the mounted .codex/auth.json. Setting OPENAI_API_KEY
  // could switch codex to api-key mode.

  // For an HTTPS GitHub remote, give `gh` the project's git token (a
  // placeholder the proxy swaps on api.github.com, if mediated) so it is
  // logged in. Skipped if the user set their own GH_TOKEN/GITHUB_TOKEN.
  const userWiresGithubToken = env.some((e) => e.startsWith('GH_TOKEN='))
    || projectEnv.secrets.GH_TOKEN !== undefined
    || projectEnv.secrets.GITHUB_TOKEN !== undefined
  if (credential?.kind === 'https' && remoteHost !== null
    && ghApiHostForGitHost(remoteHost) !== null
    && !userWiresGithubToken) {
    env.push(`GH_TOKEN=${sandboxed ? PLACEHOLDER_GH_TOKEN : credential.token}`)
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
  // workspace does not stall on a network probe. omp reads pi's variables,
  // so its agent dir gets a name of its own, which the installed `omp` (a
  // wrapper, dockerfiles/agent-patches/omp-homes.js) hands it under pi's.
  env.push(`CLAUDE_CONFIG_DIR=${CLAUDE_CONTAINER_HOME}`)
  env.push(`CODEX_HOME=${CODEX_CONTAINER_HOME}`)
  env.push(`PI_CODING_AGENT_DIR=${PI_CONTAINER_HOME}/agent`)
  env.push(`PI_CODING_AGENT_SESSION_DIR=${PI_SESSIONS_CONTAINER_DIR}`)
  env.push(`CODEX_SQLITE_HOME=${CODEX_SQLITE_CONTAINER_DIR}`)
  env.push('PI_SKIP_VERSION_CHECK=1')
  env.push(`YAAC_OMP_AGENT_DIR=${OMP_CONTAINER_HOME}/agent`)
  // Containerless: one pnpm store per project, so each workspace's
  // `node_modules` hardlinks into it instead of holding a full copy. Set
  // under both names since pnpm 11+ reads only `pnpm_config_` and 10.x only
  // `npm_config_`. Pods cannot share one: pnpm's SQLite (WAL) index needs
  // all writers on one kernel. A pod keeps its store in its `scratchDirs`.
  // The store path is absolute and pnpm records it in `node_modules`, so a
  // checkout whose data dir or project dir moved would make a non-TTY
  // `pnpm install` abort rather than relink; purging is allowed instead,
  // since `node_modules` is rebuilt from the store.
  if (runtime.kind === 'containerless') {
    for (const prefix of ['pnpm_config_', 'npm_config_']) {
      env.push(`${prefix}store_dir=${CACHED_PACKAGES_CONTAINER_DIR}/pnpm-store`)
      env.push(`${prefix}confirm_modules_purge=false`)
    }
  }

  // Decide each forwarded port before launch, since the status bar shows
  // them. Only a declaration: clients hold the listeners
  // (docs/port-forward-tunnel.md). `YAAC_PORT_<n>` tells the dev server
  // which port to bind for forward `n`: its own under k8s, and one
  // allocated for this workspace under containerless, where workspaces
  // share the host's ports (docs/workspace-hostnames.md).
  const offered = await offeredForwards(portForwards, options.siteId)
  const forwardedPorts = await runtime.declareForwards(workspaceId, offered)
  forwardedPorts.forEach(({ containerPort, hostPort }, i) => {
    env.push(`YAAC_PORT_${offered[i].containerPort}=${containerPort}`)
    emit(`Offering host port ${hostPort} -> container port ${containerPort}`, options)
  })

  // Inputs for yaac-workspace-init.
  env.push(`YAAC_GIT_NAME=${gitUser.name}`)
  env.push(`YAAC_GIT_EMAIL=${gitUser.email}`)
  env.push(`YAAC_STATUS_RIGHT=${buildStatusRight(workspaceId, forwardedPorts)}`)
  if (nestedContainers) env.push('YAAC_NESTED_ENGINE=1')

  // Mounts are declared against host paths; each driver realizes them its
  // own way (k8s: subPaths of the global claim or node-local dirs;
  // containerless: mostly the env values naming them). A path's storage
  // tier (global or node-local) comes from project-paths.ts. emptyDir is for
  // pod-local scratch.
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
  const history = (part: AgentHistoryPart): string => agentHistoryDir(projectId, workspaceId, part)
  const binMounts = workspaceBinMounts(workspaceBinStaging, workspaceBinNames)
  const allMounts: WorkspaceMount[] = [
    { source: { kind: 'hostPath', path: wtDir }, mountPath: '/workspace' },
    // Read-only, at the server's own path: the checkout's alternates file
    // names this path (docs/server-git.md).
    { source: { kind: 'hostPath', path: `${repo}/.git` }, mountPath: `${repo}/.git`, readOnly: true },
    { source: { kind: 'hostPath', path: claude }, mountPath: '/home/yaac/.claude' },
    { source: { kind: 'hostPath', path: acpLogs }, mountPath: CONTAINER_ACP_LOG_DIR },
    { source: { kind: 'hostPath', path: terminalLogs }, mountPath: CONTAINER_TERMINAL_LOG_DIR },
    { source: { kind: 'hostPath', path: attachments }, mountPath: CONTAINER_ATTACHMENTS_DIR, readOnly: true },
    ...codexHomeMounts(runtime.kind, codex),
    ...opencodeMounts,
    { source: { kind: 'hostPath', path: opencodeConfig }, mountPath: OPENCODE_CONFIG_CONTAINER_DIR },
    { source: { kind: 'hostPath', path: pi }, mountPath: PI_CONTAINER_HOME },
    { source: { kind: 'hostPath', path: omp }, mountPath: OMP_CONTAINER_HOME },
    // Per-workspace history. These are outside every tool home, so both
    // drivers can mount them as-is.
    { source: { kind: 'hostPath', path: history('codex-sqlite') }, mountPath: CODEX_SQLITE_CONTAINER_DIR },
    { source: { kind: 'hostPath', path: history('pi') }, mountPath: PI_SESSIONS_CONTAINER_DIR },
    // The rest sit inside the shared tool homes, so they are layered over
    // them, with claude's shared project memory put back on top, and the
    // pod's own claude `sessions/` beside them. Without layering,
    // convergeAgentHistory links the history in instead.
    ...(sandboxed
      ? [
        { source: { kind: 'hostPath' as const, path: history('claude') }, mountPath: `${CLAUDE_CONTAINER_HOME}/projects` },
        {
          source: { kind: 'hostPath' as const, path: path.join(claude, 'projects', CLAUDE_POD_REPO, 'memory') },
          mountPath: `${CLAUDE_CONTAINER_HOME}/projects/${CLAUDE_POD_CWD}/memory`,
        },
        { source: { kind: 'hostPath' as const, path: history('claude-file-history') }, mountPath: `${CLAUDE_CONTAINER_HOME}/file-history` },
        { source: { kind: 'hostPath' as const, path: claudeSessions }, mountPath: `${CLAUDE_CONTAINER_HOME}/sessions` },
        { source: { kind: 'hostPath' as const, path: history('codex') }, mountPath: `${CODEX_CONTAINER_HOME}/sessions` },
        // omp keeps its logs where its acp server finds a conversation to
        // load: under its agent dir, never a session dir it is handed.
        { source: { kind: 'hostPath' as const, path: history('omp') }, mountPath: `${OMP_CONTAINER_HOME}/agent/sessions` },
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
      source: { kind: 'hostPath', path: cacheVolumeDir(projectId, key) },
      mountPath: containerPath,
    })),
    // Server-staged skills and helper commands. Without layering the skills
    // are already linked in.
    ...(sandboxed ? builtinSkillMounts(builtinSkillsStaging, builtinSkillNames) : []),
    ...binMounts,
  ]
  // A public site's release runs no agent and faces the internet, so it
  // mounts only what is its own or read-only: nothing other workspaces of
  // the project read, such as a tool home, its memory or a cache volume, is
  // there for it to poison (docs/public-sites.md). A sandboxed workspace
  // given run secrets is held to the same, so nothing an agent wrote into
  // one of those runs beside the real values. Without a sandbox an agent
  // runs as the host user, who can read them anyway.
  const releaseMountPaths = new Set(['/workspace', `${repo}/.git`, CONTAINER_TERMINAL_LOG_DIR, CONTAINER_TMUX_DIR])
  const mounts = options.siteId === undefined && !(sandboxed && runSecrets.length > 0)
    ? allMounts
    : allMounts.filter((m) => releaseMountPaths.has(m.mountPath) || binMounts.includes(m))

  // Without a proxy to inject auth, the workspace's git needs the real
  // credential: the checkout's `origin` URL carries no token.
  let gitCredential: WorkspaceGitCredential | undefined
  if (!sandboxed) {
    if (credential?.kind === 'https' && remoteHost !== null) {
      gitCredential = { kind: 'https', host: remoteHost, token: credential.token }
    } else if (credential?.kind === 'ssh') {
      gitCredential = { kind: 'ssh', privateKey: await sshKeyMaterial(credential.id) }
    } else if (credential?.kind === 'hosted' && mama?.origin !== undefined) {
      gitCredential = { kind: 'hosted', origin: mama.origin, token: mama.token }
    }
  }

  const spec: WorkspaceSpec = {
    projectId,
    workspaceId: workspaceId,
    prewarm: options.prewarm === true,
    ...(imageRef !== undefined ? { image: imageRef } : {}),
    env,
    secretEnvKeys,
    ...(sandboxed && runSecrets.length > 0 ? { runSecrets: runSecrets.map(([name]) => name) } : {}),
    mounts,
    scratchDirs,
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
    ...(sshKnownHostsFile !== undefined && options.siteId === undefined ? { ssh: { knownHostsFile: sshKnownHostsFile } } : {}),
    ...(gitCredential !== undefined ? { gitCredential } : {}),
    substrate,
    ...(options.siteId !== undefined ? { siteId: options.siteId } : {}),
    ...(options.colocateWith !== undefined ? { colocateWith: options.colocateWith } : {}),
    onProgress: (m) => emit(m, options),
  }

  // What a teardown must address, once the runtime has launched.
  let target: TeardownTarget | undefined
  let handle: RuntimeHandle
  let attached: { volumeId: string; lease: VolumeLease } | undefined
  let staged: string | undefined
  try {
    if (options.volumeId !== undefined) {
      const volume = await attachVolume(workspaceId, options.volumeId)
      attached = { volumeId: options.volumeId, lease: volume.lease }
      mounts.push(volume.mount)
      env.push(...volume.env)
    }
    if (options.stageVolumeId !== undefined) {
      mounts.push(await stageVolume(workspaceId, options.stageVolumeId))
      staged = options.stageVolumeId
    }
    mergeEnvEntries(env, (name) => projectSets(name)
      ? `the project's environment variable ${name} conflicts with the value yaac sets for it; rename or remove it`
      : `environment variable ${name} is set to two different values`)
    throwIfProvisionStopped(workspaceId)
    handle = await launchWithSetup({
      spec, projectId, workspaceId, sessions, life,
      onLaunched: (h) => {
        target = { projectId, workspaceId: workspaceId, unitName: h.jobName }
      },
      options, workspace: workspaceTask, reusedCheckout: reuseCheckout, remoteUrl,
    })
  } catch (err) {
    // Tear down the half-started unit, or it would list as a bogus
    // workspace and collide with a relaunch. Keep the prepared substrate
    // (`unitOnly`) when the row survives (a resume). A fresh create or warm
    // tears down everything, since nothing of it is kept.
    const unitOnly = !failedCreateCollectsCheckout(options)

    // If `launch` failed after the unit was created, `onLaunched` never
    // ran, so ask the runtime what exists. `podGone` gates the checkout
    // removal below; an unreachable runtime counts as not gone. Only a
    // unit of this project is torn down.
    let podGone: boolean
    try {
      target ??= await workspaceDriver().findForTeardown(workspaceId, { spares: options.prewarm === true })
      if (target !== undefined && target.projectId !== projectId) target = undefined
      podGone = target === undefined
        ? true
        : await workspaceDriver().destroy(target, { salvageImages: false, unitOnly })
    } catch {
      podGone = false
    }

    // Free the declared host ports for the next create.
    await workspaceDriver().deregisterWorkspace(workspaceId)
      .catch(() => { /* best-effort; the reaper covers what this misses */ })
    // A unit that may still run keeps its volume; the lease sweep frees it.
    if (attached !== undefined && podGone) {
      await applyWorkspaceEvent({ type: 'volume-released', ...attached })
        .catch(() => { /* the lease sweep frees it */ })
    }
    if (staged !== undefined && podGone) {
      await unstageVolume(staged, workspaceId).catch(() => { /* the site's deploy clears it */ })
    }
    // A fresh create or warm deletes its own checkout (see
    // failedCreateCollectsCheckout); no sweep would find it once the row,
    // or the spare's unit, is gone. Chained after the checkout leg, which
    // may still be running after a pod-side failure and would otherwise
    // recreate the dir after the delete. Each step runs only if the previous
    // one succeeded; if the row stays, the stale reaper turns it into a
    // stopped workspace the user can delete. A warm has no row to delete:
    // no claim takes a spare still warming.
    if (failedCreateCollectsCheckout(options)) {
      void workspaceTask
        .catch(() => { /* the failure is already the caller's */ })
        .then(() => podGone && deleteWorkspaceState(projectId, workspaceId))
        .then((removed) => (removed && options.prewarm !== true
          ? reportCreateFailed(projectId, workspaceId, options)
          : undefined))
        .catch(() => { /* best-effort; nothing else can retry it */ })
    } else {
      await reportCreateFailed(projectId, workspaceId, options)
    }
    throw err
  }

  return {
    workspaceId,
    jobName: handle.jobName,
    forwardedPorts,
    ...(options.session !== undefined && sessions[0] !== undefined ? { sessionId: sessions[0].id } : {}),
    ...(imageRef !== undefined ? { image: imageRef } : {}),
  }
}
