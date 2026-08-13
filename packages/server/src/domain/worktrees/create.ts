import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { hostMatchesPattern, resolveAllowedHosts } from '#lib/allowed-hosts'
import { reserveAvailablePort } from '#lib/port'
import type { ReservedPort } from '#lib/port'
import { createKeyedMutex } from '#lib/keyed-mutex'
import { buildStatusRight } from '#lib/status-right'
// Aliased: this module uses a local `env: string[]` for the pod's env vars.
import { env as yaacEnv, testEnv } from '@yaac/shared/env'
import { worktreeDriver } from '#drivers/driver'
import type {
  RuntimeHandle,
  TeardownTarget,
  WorkspaceMount,
  WorkspaceResources,
  WorkspaceSpec,
} from '#drivers/contract'
import {
  repoDir,
  acpLogDir,
  claudeDir,
  claudeJsonFile,
  codexDir,
  opencodeConfigDir,
  opencodeDataDir,
  piDir,
  cachedPackagesDir,
  cacheVolumeDir,
  worktreeStateDir,
  worktreeDir,
  projectDir,
} from '@yaac/shared/project-paths'
import {
  CONTAINER_ACP_LOG_DIR,
  CONTAINER_SESSION_STARTS_LOG,
  CONTAINER_TMUX_DIR,
} from '@yaac/shared/paths'
import { loadKnownHostsEntryForHost, parseGitRemote, resolveCredentialForUrl, resolveEphemeralModulesPaths, resolveProjectConfig } from '#domain/projects'
import { ghApiHostForGitHost } from '@yaac/shared/credentials'
import { getGitUserConfig } from '@yaac/shared/git'
import {
  loadToolAuthEntry,
  loadClaudeCredentialsFile,
  loadCodexCredentialsFile,
  writeProjectClaudeCredentials,
  writeProjectClaudePlaceholder,
  writeProjectCodexAuth,
  writeProjectCodexPlaceholder,
  PLACEHOLDER_API_KEY,
  PLACEHOLDER_GH_TOKEN,
} from '@yaac/shared/tool-auth'
import {
  addWorktree,
  fetchOrigin,
  getDefaultBranch,
  isGitAuthError,
  originRemoteUrl,
  remoteBranchExists,
  writeKnownHostsFile,
} from '#domain/git'
import { serverLog } from '#log'
import {
  acpAdapterFor,
  agentDriver,
  agentWindowName,
  buildUpstreamExec,
  buildWindowsExec,
  buildWorktreeLinkExec,
  ensureClaudeHooks,
  ensureOpencodeConfigJson,
  validateInitWindows,
  type InitWindow,
} from '#runtime/agents'
import { applyWorktreeEvent } from '#db'
import { ensureSessionStartsLog, sessionStartsLogSize } from './session-starts'
import { resolveProxySecrets } from './proxy-secrets'
import { prepareEphemeralMounts, seedClaudeJson, seedClaudeSettings } from './seed'
import {
  builtinSkillsDir, stageBuiltinSkills, builtinSkillMounts, sharedSkillRoots, syncSharedBuiltinSkills,
} from '#domain/skills'
import { deleteWorktreeState } from './cleanup'
import {
  WORKTREE_INIT_SCRIPT,
  worktreeBinDir,
  worktreeBinMounts,
  stageWorktreeBin,
} from './spawn-script'
import { ServerError } from '@yaac/shared/errors'
import type { AgentMode, AgentTool, PortMapping, YaacConfig } from '@yaac/shared/types'
import {
  opencodeProviderInfo,
  piProviderInfo,
  type PiProvider,
} from '@yaac/shared/tool-providers'

/** In-pod pi home. The host-side `piDir` is mounted here (the whole `.pi`,
 *  mirroring `~/.claude`), so every worktree's pi session logs are visible to all. */
const PI_CONTAINER_HOME = '/home/yaac/.pi'
/** In-pod dir pi writes its JSONL session logs to (PI_CODING_AGENT_SESSION_DIR
 *  points here; it lives under the mounted `PI_CONTAINER_HOME`). */
const PI_SESSIONS_CONTAINER_DIR = `${PI_CONTAINER_HOME}/agent/sessions`

function emit(message: string, options: WorktreeCreateOptions): void {
  console.log(message)
  options.onProgress?.(message)
}

export interface WorktreeCreateOptions {
  /** Pre-generated worktree ID (used by resume to know the Job name upfront). */
  worktreeId?: string
  /** Agent tool to run inside the container (default: 'claude'). */
  tool?: AgentTool
  /**
   * Which protocol drives the agent (default: 'tui'). `acp` runs the tool's
   * ACP adapter under acpd instead of its TUI, and the webapp renders the
   * conversation as chat rather than attaching a PTY. Validated by the create
   * route against the tools that have an adapter.
   */
  mode?: AgentMode
  /**
   * Reference branch for the fresh worktree (a branch on `origin`, no
   * `origin/` prefix). Overrides the project's `referenceBranch` config
   * default; unset → that default, else the remote's default branch.
   */
  branch?: string
  /**
   * Resume an existing worktree: reuse the worktree at
   * `worktreeDir(projectSlug, worktreeId)` if present and launch the agent
   * with `--resume` so it loads the prior transcript. Requires `worktreeId`.
   */
  resume?: boolean
  /**
   * The agent sessions to bring up, in window order — what restart reads
   * back from the frozen active set. Each gets its own tmux window
   * (`agentWindowName`), the first respawning the placeholder. Empty (the
   * default) starts one fresh conversation pinned to the worktree id.
   */
  resumeAgentSessions?: Array<{ agentSessionId: string; tool: AgentTool }>
  /**
   * Provision a prewarmed spare: stamp the `yaac.prewarmed` pod label so the
   * worktree is hidden from user-facing views until claimed on a later
   * `worktree create`. Set by the prewarm reconciler; never by a user create.
   */
  prewarm?: boolean
  /**
   * Git identity to use inside the container. The CLI resolves this
   * up-front (prompting when missing) and passes it in.
   */
  gitUser?: { name: string; email: string }
  /**
   * Initial prompt typed into the agent's tmux pane once the agent window
   * is up (pasted + submitted, not passed on the agent's command line).
   * Used by `yaac-spawn` and `worktree create --prompt`.
   */
  initialPrompt?: string
  /**
   * Model override for the agent's launch command (`--model <model>`): a
   * model id or alias for claude/codex, `provider/model` for opencode and
   * pi (see buildAgentCmd). Validated to MODEL_RE by the create route.
   * Not persisted: a restart resumes with the default model.
   */
  model?: string
  /**
   * Launch this worktree's agents with their auto-approve flags ("yolo
   * mode") — the agent acts without asking.
   *
   * Absent means "the driver's default", which is what every caller that
   * has no opinion passes: on a sandboxed runtime that is on, because the
   * isolation is what makes unsupervised action safe, and on one without a
   * sandbox it is off, because there the agent's reach is this machine.
   * A restart passes the worktree's recorded answer rather than
   * re-deriving it.
   */
  autoApprove?: boolean
  /**
   * Called for each user-visible progress message during provisioning.
   * The HTTP route forwards these to the CLI as NDJSON events so
   * `yaac worktree create` can show what the server is doing.
   */
  onProgress?: (message: string) => void
}

export interface WorktreeCreateResult {
  worktreeId: string
  jobName: string
  forwardedPorts: PortMapping[]
  tool: AgentTool
  /** Which driver the pod came up under. Callers that would attach a PTY need
   *  it: an `acp` worktree's window runs acpd, not a shell. */
  mode: AgentMode
}

/**
 * What one worktree's pod costs and may burst to.
 *
 * Policy, and the reason it is stated here rather than inside the runtime:
 * every number is chosen against ordinary developer hardware — how many
 * worktrees should pack onto one machine, and how much one may take before
 * it is taking the machine.
 */
const WORKTREE_RESOURCES: WorkspaceResources = {
  memoryRequestBytes: 1 * 1024 ** 3,
  memoryLimitBytes: 8 * 1024 ** 3,
  // 250m per worktree pairs with the 1Gi memory request at 4 GB/core, so
  // the cpu-imposed ceiling on concurrent worktrees lands beside the
  // memory-imposed one on ordinary developer hardware (8 cores/32 GB:
  // 32 worktrees by cpu, 32 by memory) — honest for bin-packing without
  // becoming the reason a worktree stops scheduling. Real usage is far
  // below it: an agent session is idle between turns.
  cpuRequestMillis: 250,
  // 32x the request: high enough that interactive work never reaches it,
  // low enough that one worktree's parallel burst leaves the node usable.
  // The number that matters is the fraction of a node this is — half of a
  // 16-core box — because it caps both the burst and (under gVisor) the
  // sandbox's stub count. Worktrees doing heavy parallel work (e2e: image
  // builds, container starts) keep most of their headroom; what they lose
  // is the ability to take the whole node.
  cpuLimitMillis: 8000,
  // Worktrees keep their repo, worktrees and caches on mounts, which are
  // not ephemeral storage — what lands here is the writable layer, logs,
  // and the pod-local scratch (the tmux socket dir, the ssh-agent socket
  // dir, and nested-only the graphroot). 2Gi covers the steady state; the
  // 16Gi ceiling is a blast-radius bound on a worktree filling the node's
  // disk, not a budget anyone should hit.
  ephemeralStorageRequestBytes: 2 * 1024 ** 3,
  ephemeralStorageLimitBytes: 16 * 1024 ** 3,
}

interface WorktreeSetupParams {
  spec: WorkspaceSpec
  projectSlug: string
  worktreeId: string
  tool: AgentTool
  /** Which driver launches and observes the agents. */
  mode: AgentMode
  /** The conversations to bring up, in window order — the same list the
   *  worktree's rows were written from, so the DB can never name one the
   *  agent did not open. */
  launching: Array<{ agentSessionId: string; tool: AgentTool }>
  /** Pre-validated init windows (validateInitWindows ran in createWorktree). */
  initWindows: InitWindow[]
  /** pi only — provider whose default model drives `pi --model`. */
  piProvider?: PiProvider
  /** Whether the agents launch with their auto-approve flags. */
  autoApprove: boolean
  /**
   * Called the moment the runtime has something running, before any of the
   * setup that can still fail. What it hands back is the only thing that
   * can address the new unit for a teardown — so the caller learns of a
   * half-started workspace even when the failure comes several steps later.
   */
  onLaunched: (handle: RuntimeHandle) => void
  options: WorktreeCreateOptions
  /**
   * The concurrent host-side worktree provisioning (fetch → branch checks
   * → `git worktree add`), started before the Job so the checkout overlaps
   * pod boot. Resolves `origin/<refBranch>` for a fresh worktree (its
   * upstream is then set from inside the pod) or undefined when resuming
   * onto an existing worktree, whose upstream is left untouched. A
   * rejection (bad branch, fetch failure) is the caller's input being
   * wrong, not the pod's — surfaced as SetupInputError so the Job retry
   * loop fails fast instead of recreating the pod against it.
   */
  worktree: Promise<{ upstreamStartPoint?: string }>
}

/** Wraps worktree-provisioning failures so the Job retry loop can tell
 *  "the pod setup failed" (retryable) from "the inputs are bad" (not). */
class SetupInputError extends Error {
  constructor(readonly inner: unknown) {
    super(inner instanceof Error ? inner.message : String(inner))
  }
}

/**
 * Per-project queue for the in-flight in-pod upstream-config execs. Each
 * fresh worktree sets its branch upstream from inside its own pod (see
 * below), and that write takes git's config lock on the shared
 * `/repo/.git/config` — two concurrent creates on one project (a user
 * create and a prewarm spare warm, say) would race it and fail one side
 * with "could not lock config file".
 */
const upstreamConfigMutex = createKeyedMutex()

/**
 * Run `task` serialized against every other in-flight upstream-config write
 * for the project. Both the fresh-create setup and the claim-time re-branch
 * prep write `branch.<name>.merge` into the shared `/repo/.git/config`
 * (taking git's config lock), so all such writes flow through here.
 */
export async function withUpstreamConfigLock(projectSlug: string, task: () => Promise<void>): Promise<void> {
  await upstreamConfigMutex(projectSlug, task)
}

/**
 * Launch the worktree's runtime and drive the in-pod setup on top of it.
 *
 * One attempt: the caller's retry loop runs it again (having torn the last
 * one down) when what failed was the pod rather than the create's inputs.
 * Everything here is either a wait the runtime answers or a command run
 * inside the worktree — how a workspace becomes a running thing is the
 * runtime's, and nothing below names a substrate object.
 */
async function launchWithSetup(params: WorktreeSetupParams): Promise<RuntimeHandle> {
  const {
    spec, projectSlug, worktreeId, tool, mode, launching, initWindows, piProvider,
    autoApprove, onLaunched, options, worktree,
  } = params
  const runtime = worktreeDriver()

  // Reject-only view of the worktree leg, raced against the boot waits
  // below: its failures — unknown branch, referenceBranch typo, git auth —
  // are the most common user-facing create errors, and before the legs ran
  // concurrently they surfaced in well under a second. Racing them here
  // keeps that: a bad input aborts the boot the moment it's known instead
  // of paying image pull + gVisor boot + the streamd gate first. On
  // worktree success it never settles, so the races resolve on their pod
  // wait; the value is read at the join below.
  const worktreeFailure: Promise<never> = worktree.then(
    () => new Promise<never>(() => { /* success: races resolve on the pod wait */ }),
    (err) => { throw new SetupInputError(err) },
  )
  // The races may both complete before a late worktree rejection lands (or
  // never observe it when a wait throws first) — keep that from surfacing
  // as an unhandled rejection; the join below still reads the real outcome.
  worktreeFailure.catch(() => { /* observed via race/join */ })

  const handle = await runtime.launch(spec)
  onLaunched(handle)
  const jobName = handle.jobName
  // Where this workspace's things are, in its own world. Every command
  // below is addressed inside it, and the answer differs per driver — a pod
  // sees fixed container paths, a host process sees its own checkout.
  const paths = runtime.workspacePaths(jobName)
  // Each race can abandon a still-pending wait when the worktree leg
  // rejects first — pre-mark the waits handled so a later rejection from
  // an abandoned one (e.g. a timeout against the runtime the retry loop is
  // already tearing down) can't surface as an unhandled rejection.
  const podReady = runtime.awaitReady(handle)
  podReady.catch(() => { /* observed via race */ })
  await Promise.race([podReady, worktreeFailure])

  // First relay contact doubles as the transport readiness gate; every
  // setup command below rides the relay (single-digit ms per command)
  // instead of a ~300ms exec through the apiserver.
  const transportReady = runtime.awaitAgentTransport(jobName)
  transportReady.catch(() => { /* observed via race */ })
  await Promise.race([transportReady, worktreeFailure])

  // No ownership fixup is needed for server-created hostPath mounts: the
  // image's yaac user is built with the server's uid (YAAC_UID build arg,
  // see podUid in image-builder). Under gVisor there is no userns and no
  // idmapped mount, so numeric uids pass through raw — server-owned dirs are
  // yaac-writable as-is.

  // The worktree checkout has been running concurrently with the pod boot;
  // everything below reads /workspace, so join it now. Its failures are the
  // create's inputs being bad — never the pod's fault — so they must not
  // burn Job-recreate retries (SetupInputError fails the retry loop fast).
  let upstreamStartPoint: string | undefined
  try {
    ({ upstreamStartPoint } = await worktree)
  } catch (err) {
    throw new SetupInputError(err)
  }

  // Re-point the worktree's git plumbing at in-workspace paths and lock it
  // against `git worktree prune` — one exec (see buildWorktreeLinkExec).
  //
  // Skipped when the workspace sees the checkout at the very path the host
  // `git worktree add` wrote into it: there is nothing to re-point, and the
  // rewrite would be actively wrong, replacing correct host paths with
  // themselves-via-a-different-route only if they happened to agree. The
  // `locked` file that half of it writes is not lost — `addWorktree` writes
  // it host-side for every driver.
  if (paths.workspaceDir !== worktreeDir(projectSlug, worktreeId)) {
    await runtime.exec(jobName, buildWorktreeLinkExec(worktreeId, paths))
  }

  // Fresh worktree: set the worktree branch's upstream from inside the pod
  // (virtiofs cache coherence — see buildUpstreamExec), serialized against
  // every other in-flight upstream write on this project's shared config.
  if (upstreamStartPoint) {
    const upstream = upstreamStartPoint
    await withUpstreamConfigLock(projectSlug, async () => {
      await runtime.exec(jobName, buildUpstreamExec(upstream, paths))
    })
  }

  // Nested worktrees: the postStart hook started the rootful in-pod engine
  // in the background (yaac-worktree-init, which also writes the project
  // registries.conf drop-in from YAAC_REGISTRY_CONF_B64).
  // Gate on `docker version` here so a broken engine fails the create with
  // a clear error instead of a confusing "cannot connect to docker" the
  // first time the agent runs.
  if (spec.nestedContainers) {
    emit('Waiting for the in-pod container engine...', options)
    const deadline = Date.now() + 60_000
    for (;;) {
      try {
        await runtime.exec(jobName, 'docker version', { maxAttempts: 1, timeout: 10_000 })
        break
      } catch (err) {
        if (Date.now() > deadline) {
          throw new Error(
            'in-pod podman did not become ready within 60s — check '
            + `/tmp/podman-service.log and /tmp/yaac-engine-setup.log in session ${worktreeId} `
            + `(${(err as Error).message})`,
          )
        }
        await new Promise((r) => setTimeout(r, 500))
      }
    }

  }

  // Open the init windows and swap the keepalive placeholder for the real
  // agent — one exec (see buildWindowsExec). The tmux server, its UX
  // options, and the placeholder window were configured by the postStart
  // hook; the placeholder never reaches the user, who attaches after setup
  // completes.
  // One command per conversation, from the same list that was recorded with
  // the worktree row — the two must not diverge, or the DB would name a
  // conversation the agent never opened.
  //
  // Only a *resume* passes `--resume`: a restart with nothing recorded falls
  // back to the worktree-id pin, which is the pre-hook worktree's path.
  const resumesConversation = (options.resumeAgentSessions ?? []).length > 0
    || options.resume === true
  const driver = agentDriver(mode)
  const agentCmds = launching.map((a, i) => ({
    tool: a.tool,
    cmd: driver.launchCmd({
      tool: a.tool,
      agentSessionId: a.agentSessionId,
      resume: resumesConversation,
      // The window a conversation lands in — the primary keeps the tool's own
      // name, extras get `<tool>-2`, … . Under acp it doubles as the acpd
      // socket's name, which is why the driver needs it and the TUI one
      // ignores it.
      windowName: agentWindowName(a.tool, i),
      paths,
      autoApprove,
      ...(piProvider !== undefined ? { piProvider } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
    }),
  }))
  const toolLabel =
    tool === 'codex' ? 'Codex' :
    tool === 'opencode' ? 'OpenCode' :
    tool === 'pi' ? 'Pi' :
    'Claude Code'
  emit(`Starting ${toolLabel}...`, options)
  await runtime.exec(jobName, buildWindowsExec(initWindows, tool, agentCmds, paths))

  if (options.initialPrompt !== undefined) {
    emit('Sending initial prompt...', options)
    // Mode-agnostic: `tui` pastes it into the pane and submits, `acp` waits
    // for the conversation's handshake and sends `session/prompt`. Neither
    // waits for the agent to answer.
    await driver.deliverPrompt(
      { slug: projectSlug, worktreeId, jobName, tool },
      agentWindowName(tool, 0),
      options.initialPrompt,
    ).catch((err: unknown) => {
      serverLog(`[server] create ${worktreeId}: initial prompt failed: ${String(err)}`)
    })
  }

  return handle
}

/**
 * Does a create that gave up take its checkout with it?
 *
 * Only when the checkout is the create's OWN product, which is the whole of
 * the rule and the reason it is written down rather than inlined: getting it
 * backwards deletes work that exists in no other copy.
 *
 * - A *resume* keeps it. That checkout predates this create — it is the work
 *   the user came back for — which is also why db puts a failed resume's
 *   row back as the restart found it instead of deleting it.
 * - A *prewarm* keeps it too, for the opposite reason: its row survives
 *   flagged `spare`, and that flag is exactly what the startup sweep collects
 *   a dead spare's checkout on. Removing it here would only race that sweep.
 */
export function failedCreateCollectsCheckout(
  options: Pick<WorktreeCreateOptions, 'resume' | 'prewarm'>,
): boolean {
  return options.prewarm !== true && options.resume !== true
}

/**
 * Report that a create gave up, so the server can undo what the matching
 * `worktree-created` started. What "undo" means differs by `resume` and is
 * db's to decide (see `apply-worktree-event.ts`); this half knows only
 * that provisioning failed.
 */
async function reportCreateFailed(
  projectSlug: string,
  worktreeId: string,
  options: WorktreeCreateOptions,
): Promise<void> {
  await applyWorktreeEvent({
    type: 'worktree-create-failed',
    projectSlug,
    worktreeId,
    resume: options.resume,
  }).catch(() => {
    // Best-effort: the create is already failing, and the reaper records a
    // row whose pod never arrived.
  })
}

/**
 * Server-side implementation of `/worktree/create`. Provisions the
 * worktree, proxy rules, kubernetes Job, and port forwarders — all
 * long-lived resources that the server owns for the worktree's
 * lifetime. The CLI only prompts for git identity and then attaches
 * the user's terminal to the resulting tmux session.
 */
export async function createWorktree(
  projectSlug: string,
  options: WorktreeCreateOptions,
): Promise<WorktreeCreateResult> {
  // Verify project exists
  try {
    await fs.access(projectDir(projectSlug))
  } catch {
    throw new ServerError('NOT_FOUND', `project ${projectSlug} not found`)
  }

  if (options.resume && !options.worktreeId) {
    throw new ServerError('VALIDATION', 'resume requires a worktreeId')
  }

  const tool: AgentTool = options.tool ?? 'claude'
  const runtime = worktreeDriver()
  // Whether this runtime intercepts the workspace's outbound traffic — the
  // one fact every credential decision below turns on. With mediation the
  // workspace only ever holds sentinels; without it, it holds the real
  // secrets, because nothing downstream would swap them.
  const mediatedEgress = runtime.kind !== 'containerless'
  // Whether the agents run unsupervised. The caller's choice when it made
  // one; otherwise the driver's default — on where the workspace is
  // sandboxed, off where the agent's reach is the whole machine.
  const autoApprove = options.autoApprove ?? runtime.kind !== 'containerless'
  // Whether yaac's own skills reach the workspace as host state rather than
  // as mounts — a runtime with no mount namespace cannot layer a per-worktree
  // staging over the tool homes it links in (see #domain/skills).
  const hostSkills = runtime.kind === 'containerless'

  await runtime.ensureBuildEngine()

  // Git identity is resolved by the CLI before the call; fall back to the
  // global git config for non-interactive callers (stream picker).
  let gitUser: { name: string; email: string } | null = options.gitUser ?? null
  if (!gitUser) gitUser = await getGitUserConfig()
  if (!gitUser) {
    throw new ServerError(
      'VALIDATION',
      'Git user.name and user.email must be configured globally for non-interactive session creation.',
    )
  }

  const repo = repoDir(projectSlug)

  // Load project config (local override at ~/.yaac/projects/<slug>/ takes precedence)
  const config: YaacConfig = await resolveProjectConfig(projectSlug) ?? {}

  // Resolve the git credential (HTTPS token or SSH key) for this project's
  // remote URL and parse the remote so we know the scheme and host.
  const remoteUrl = await originRemoteUrl(repo)
  if (!remoteUrl) {
    throw new ServerError('VALIDATION', 'could not determine remote URL for this project.')
  }
  const parsedRemote = parseGitRemote(remoteUrl)
  const credential = await resolveCredentialForUrl(remoteUrl)
  if (!credential) {
    throw new ServerError(
      'VALIDATION',
      `No git credential configured for ${remoteUrl}. Run "yaac auth update" to add one.`,
    )
  }

  // Hard error if the project's remote host isn't in the resolved allowlist —
  // worktrees would otherwise produce a confusing in-container 403 from the
  // proxy when the agent tries to fetch.
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

  // nestedContainers shapes the image chain (nestable layer), the pod
  // spec (nested branch), the proxy allowlist (registry hosts), and the
  // in-pod engine start + readiness gate. virtualCluster (config
  // only) additionally stands up the per-project push registry and a
  // per-worktree vcluster, and implies nestedContainers — the in-pod
  // podman is the worktree's only build engine. The config parser already
  // normalizes `virtualCluster: true` to set `nestedContainers: true`
  // (and rejects an explicit `nestedContainers: false` alongside it).
  const virtualCluster = config.virtualCluster === true
  const nestedContainers = config.nestedContainers === true || virtualCluster

  // Both keys ask for a container to put a container in, so neither means
  // anything without the first one. Rejected here rather than degraded:
  // a project whose config says it needs its own engine gets a worktree
  // that silently lacks one otherwise, and the failure surfaces much later
  // as a build command that cannot find docker.
  if (runtime.kind === 'containerless' && (virtualCluster || nestedContainers)) {
    const key = virtualCluster ? 'virtualCluster' : 'nestedContainers'
    throw new ServerError(
      'VALIDATION',
      `${key} needs a container runtime; this server runs worktrees on the host.`,
    )
  }

  // Recursion cap: an inner yaac (running inside a vcluster worktree)
  // must not stand up vcluster-in-vcluster — the depth buys nothing
  // (synced pods already run on the host node) and the inner cluster
  // lacks the infrastructure (no kind node of its own).
  if (virtualCluster && yaacEnv.nested) {
    throw new ServerError(
      'VALIDATION',
      'virtualCluster is not supported inside a nested yaac (no vcluster-in-vcluster).',
    )
  }

  // Init-window names are validated up front so a bad config fails before
  // any resource is provisioned.
  const initWindows = validateInitWindows(config)

  // Resolved (and rejected) before anything is provisioned, like the init
  // windows above: only some tools ship an ACP adapter, and a bad combination
  // must fail the create rather than become a tmux window that exits on
  // startup with nobody watching.
  const mode: AgentMode = options.mode ?? 'tui'
  if (mode === 'acp' && acpAdapterFor(tool) === undefined) {
    throw new ServerError('VALIDATION', `${tool} has no ACP adapter; use --mode tui`)
  }
  // And whether THIS runtime can run it: an image either ships the adapter
  // or does not, but a host has whatever the user installed, and acpd
  // exec'ing nothing ends the worktree seconds after a create that already
  // reported success.
  await runtime.assertCanLaunch({ tool, mode })

  const worktreeId = options.worktreeId ?? crypto.randomUUID()
  // The conversations this create will launch, decided here rather than at
  // agent-command time so they can be recorded alongside the worktree row.
  // A worktree's tool and founding ask are read off its first conversation,
  // so a worktree with none has neither — and could not be restarted. Making
  // create the authority (discovery only ever adds to what it wrote) is what
  // keeps that from depending on a hook firing, which for opencode never
  // happens at all: no hook fires for it.
  const launching: Array<{ agentSessionId: string; tool: AgentTool }> =
    options.resumeAgentSessions !== undefined && options.resumeAgentSessions.length > 0
      ? options.resumeAgentSessions
      : [{ agentSessionId: worktreeId, tool }]
  const wtDir = worktreeDir(projectSlug, worktreeId)

  // Pre-create the worktree dir so the Job's /workspace hostPath (type
  // Directory) mounts on first attempt: the Job is applied while the
  // checkout below may still be running.
  await fs.mkdir(wtDir, { recursive: true })
  // The ephemeral-module mounts land *inside* /workspace, so their targets
  // are directories on the host worktree. Create them here — before either
  // provisioning leg starts — rather than leaving them to the pod: the pod
  // creates them root-owned 0700 whenever it happens to win the race with
  // the checkout, and either way the checkout must cope with a destination
  // that is not empty (see addWorktree, which is what makes that legal).
  const ephemeralMounts = await prepareEphemeralMounts(
    cachedPackagesDir(projectSlug),
    worktreeId,
    wtDir,
    resolveEphemeralModulesPaths(config),
  )

  // Record the worktree BEFORE anything is provisioned, so no pod can ever
  // exist without a row — a rowless pod is invisible to every path that
  // reads recorded state (titles, groups, the deleted listing, restart)
  // and there is no safe way to tell one from an unclaimed spare later.
  // A failure to record therefore fails the create before it has built
  // anything, and a create that fails later reports that too (see
  // `reportCreateFailed`).
  //
  // A prewarmed spare is recorded too, flagged `spare`: it is a checkout, a
  // branch and a pod from the moment it is warmed, and the flag is what lets
  // a reap tell it from a stopped worktree once its pod is gone. Every
  // listing filters it out until the claim clears the flag.
  //
  // `baseBranch` is deliberately not here: it comes from the worktree leg
  // that runs concurrently with the pod boot, and waiting for it would undo
  // that overlap. It is reported at the end.
  await applyWorktreeEvent({
    type: 'worktree-created',
    projectSlug,
    worktreeId,
    autoApprove,
    resume: options.resume,
    ...(options.prewarm === true ? { spare: true } : {}),
  })

  // The life this create is starting, stamped after the row exists (it is an
  // UPDATE) and before any handle can be recorded — a life is exactly the
  // boundary that invalidates the previous one's handles, and stamping it
  // clears them in the same transaction. Removing the pane pointers from
  // three tool homes is what worktree create used to do here instead.
  await applyWorktreeEvent({
    type: 'worktree-life-started',
    projectSlug,
    worktreeId,
    logBytes: await sessionStartsLogSize(projectSlug, worktreeId),
  })

  if (!options.prewarm) {
    // The worktree's tool and founding ask are read off this, so it is
    // recorded with the row rather than left to discovery. An initial prompt
    // is the first conversation's opening message by definition — the user
    // typed it before the agent had said anything.
    //
    // A FRESH acp create is the one case that cannot do this: an ACP
    // conversation's id is minted by the agent (`session/new`), so there is
    // nothing to record until the handshake answers, seconds later. The
    // registry writes the row then, first prompt and all. A resumed acp
    // worktree is unaffected — its ids are exactly what was frozen at
    // teardown — which is why the guard is on the ids being real, not on the
    // mode alone.
    if (mode === 'tui' || (launching.length > 0 && options.resumeAgentSessions !== undefined)) {
      // Under `acp` the handle is knowable here, and recording it is what makes
      // a restart resume rather than start over: the driver reads it back to
      // address the conversation, and without it the fresh acpd handshake mints
      // a NEW worktree and silently abandons the history this row exists to
      // preserve. A tmux pane id (`tui`) genuinely is not knowable until the
      // pane exists, so that stays for the registry to fill in.
      await applyWorktreeEvent({
        type: 'sessions-launched',
        projectSlug,
        worktreeId,
        sessions: launching.map((a, i) => ({
          tool: a.tool,
          agentSessionId: a.agentSessionId,
          mode,
          ...(mode === 'acp' ? { paneId: agentWindowName(a.tool, i) } : {}),
          ...(i === 0 && options.initialPrompt !== undefined
            ? { firstPrompt: options.initialPrompt }
            : {}),
        })),
      })
    }
  }

  // ── Concurrent provisioning ─────────────────────────────────────────
  // The independent legs of provisioning run concurrently: image
  // ensure+push (podman + registry), fetch + worktree checkout (network +
  // disk), cluster-side ensures (proxy, vcluster, proxy registration), and
  // host-side fs prep. The worktree leg deliberately outlives the join
  // below — launchWithSetup joins it after pod-Ready, so the checkout
  // also overlaps the pod's image pull and gVisor boot.

  // A runtime that runs no images is asked for none: the whole leg drops
  // out rather than resolving a ref the launch would carry and ignore.
  // `spec.image` is optional for exactly this case.
  const imageTask: Promise<string | undefined> = runtime.kind === 'containerless'
    ? Promise.resolve(undefined)
    : runtime.prepareImage({
      projectSlug,
      nestedContainers,
      onProgress: (m) => emit(m, options),
    })
  // The join below is what reads it; this marker only keeps a failure in
  // another leg from turning it into an unhandled rejection.
  imageTask.catch(() => { /* awaited at the join */ })

  const worktreeTask = (async (): Promise<{ upstreamStartPoint?: string }> => {
    // Test-only: e2e fixtures pre-populate the bare repo, so skip the
    // host-side fetchOrigin (which would try to reach the real remote from
    // the server process — outside the proxy's reach).
    if (!testEnv.e2eSkipFetch) {
      emit('Fetching latest from remote...', options)
      try {
        await fetchOrigin(repo, credential)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (isGitAuthError(msg)) {
          throw new ServerError(
            'AUTH_REQUIRED',
            `git authentication failed for ${parsedRemote.host} — the stored credential was `
            + 'rejected (expired or revoked token?). Run "yaac auth update" to replace it, '
            + 'then retry.',
          )
        }
        throw new ServerError('INTERNAL', `could not fetch from remote: ${msg}`)
      }
    }

    // Create the worktree (or reuse an existing one when resuming). The
    // wtDir itself was pre-created above, holding the /workspace mount
    // points; a populated worktree is recognized by its `.git` link file.
    const worktreeExists = await fs.access(path.join(wtDir, '.git'))
      .then(() => true).catch(() => false)
    if (options.resume && worktreeExists) {
      emit(`Reusing existing worktree at ${wtDir}`, options)
      return {}
    }
    // Per-create branch wins over the project's configured default; both
    // fall back to the remote default branch. An explicitly requested
    // branch must exist as a remote-tracking ref (fetchOrigin above brought
    // down all heads, so a just-pushed branch is already visible).
    const requested = options.branch ?? config.referenceBranch
    if (requested && !(await remoteBranchExists(repo, requested))) {
      const source = options.branch
        ? 'the requested branch'
        : 'referenceBranch in yaac-config.json'
      throw new ServerError(
        'VALIDATION',
        `branch "${requested}" not found on origin — check ${source}.`,
      )
    }
    const refBranch = requested ?? await getDefaultBranch(repo)
    emit(`Creating worktree from ${refBranch}...`, options)
    // addWorktree checks out into the pre-created dir whether or not it is
    // empty; nothing pod-side reads /workspace before launchWithSetup
    // joins this task.
    await addWorktree(repo, wtDir, `agent/${worktreeId}`, `origin/${refBranch}`)
    return { upstreamStartPoint: `origin/${refBranch}` }
  })()
  // Joined inside launchWithSetup (or surfaced by the retry loop); this
  // marker only keeps a failure in another leg from turning a still-running
  // worktree leg into an unhandled rejection.
  worktreeTask.catch(() => { /* awaited later */ })

  // The substrate half: the egress registration, the image plumbing the
  // in-pod engine pulls through, and — for a virtualCluster project — the
  // worktree's own nested cluster. Started here so its cold start overlaps
  // the image build, the checkout and the fs prep; what it stands up
  // belongs to the WORKTREE, so the retry loop below reuses it rather than
  // preparing again per attempt.
  const substrateTask = runtime.prepareSubstrate({
    projectSlug,
    workspaceId: worktreeId,
    tool,
    config,
    remoteUrl,
    nestedContainers,
    virtualCluster,
    proxySecrets: resolveProxySecrets(config),
    onProgress: (m) => emit(m, options),
  })
  substrateTask.catch(() => { /* awaited at the join */ })

  const prepTask = (async () => {
    // Load every tool's stored credential, not just the active tool's: pods
    // are provisioned tool-agnostically (a prewarmed spare can be retooled to
    // any agent at claim time), so the env placeholders and per-project
    // placeholder refreshes cover each tool that has credentials, each
    // gated on its own credential's kind.
    const [claudeAuth, codexAuth, opencodeAuth, piAuth] = await Promise.all([
      loadToolAuthEntry('claude'),
      loadToolAuthEntry('codex'),
      loadToolAuthEntry('opencode'),
      loadToolAuthEntry('pi'),
    ])
    const toolAuthByTool = {
      claude: claudeAuth, codex: codexAuth, opencode: opencodeAuth, pi: piAuth,
    }

    const claude = claudeDir(projectSlug)
    const claudeJson = claudeJsonFile(projectSlug)
    const codex = codexDir(projectSlug)
    const opencodeData = opencodeDataDir(projectSlug, worktreeId)
    const opencodeConfig = opencodeConfigDir(projectSlug)
    const pi = piDir(projectSlug)
    const cachedPackages = cachedPackagesDir(projectSlug)

    await fs.mkdir(claude, { recursive: true })
    await fs.mkdir(codex, { recursive: true })
    // Per-yaac-session opencode data dir (sqlite DB + sessions). Per-session
    // isolation sidesteps opencode upstream #5241 concurrent-write issues.
    await fs.mkdir(opencodeData, { recursive: true })
    await fs.mkdir(opencodeConfig, { recursive: true })
    // Per-project pi home (mounted at PI_CONTAINER_HOME); pi creates the
    // agent/worktrees subdir under it on first run.
    await fs.mkdir(pi, { recursive: true })
    await fs.mkdir(cachedPackages, { recursive: true })
    // One worktree's ACP conversation records, written by acpd inside the pod
    // and read by the server from here — including after the pod is gone,
    // which is why they sit under the project rather than the worktree dir
    // (teardown prunes that one). Only `acp` worktrees have any, so a `tui` pod
    // carries neither the directory nor the mount.
    const acpLogs = mode === 'acp' ? acpLogDir(projectSlug, worktreeId) : undefined
    if (acpLogs !== undefined) await fs.mkdir(acpLogs, { recursive: true })
    // Pre-created so the pod's `File` hostPath mount resolves on the first
    // attempt, the same reason the worktree dir is. The hook appends to it;
    // nothing renames it, which is what keeps the mount valid for the pod's
    // whole life.
    const sessionStarts = await ensureSessionStartsLog(projectSlug, worktreeId)

    // SSH remotes: the worktree talks git over SSH with no private key
    // inside the container, which needs a host key to verify against. That
    // half is here — the credential must exist, and the project-scoped
    // known_hosts is written host-side from it. How that file, the
    // forwarded agent and the tunnel reach the pod is the runtime's (all
    // three are properties of its own egress path), so only the path
    // travels on the spec.
    let sshKnownHostsFile: string | undefined
    if (parsedRemote.scheme === 'ssh') {
      const knownHostsEntry = await loadKnownHostsEntryForHost(parsedRemote.host)
      if (!knownHostsEntry) {
        throw new ServerError(
          'VALIDATION',
          `No SSH known_hosts entry for ${parsedRemote.host}. Run "yaac auth update" to register one.`,
        )
      }
      // SHARED: written under the project dir by the server, read in-pod.
      sshKnownHostsFile = path.join(projectDir(projectSlug), 'known_hosts')
      await writeKnownHostsFile([knownHostsEntry], sshKnownHostsFile)
    }

    // Refresh the per-project credential files from the current host OAuth
    // bundles. Picks up expiresAt changes since the last worktree. Both
    // tools are refreshed regardless of the active tool so a prewarmed
    // spare stays retoolable at claim time.
    //
    // WHICH bundle is written turns on whether the runtime mediates egress.
    // With a proxy, a sentinel goes in and the real token never enters the
    // workspace — the proxy swaps it in flight. Without one there is
    // nothing to do the swapping, so a placeholder would simply be what the
    // agent tried to authenticate with; the real bundle goes in instead.
    // That is the containerless bargain: no sandbox, so nothing is withheld
    // from what runs inside it (docs/containerless-driver.md).
    if (toolAuthByTool.claude?.kind === 'oauth') {
      const hostClaudeCreds = await loadClaudeCredentialsFile()
      if (hostClaudeCreds?.kind === 'oauth') {
        await (mediatedEgress ? writeProjectClaudePlaceholder : writeProjectClaudeCredentials)(
          projectSlug, hostClaudeCreds.claudeAiOauth,
        )
      }
    }
    if (toolAuthByTool.codex?.kind === 'oauth') {
      const hostCodexCreds = await loadCodexCredentialsFile()
      if (hostCodexCreds?.kind === 'oauth') {
        await (mediatedEgress ? writeProjectCodexPlaceholder : writeProjectCodexAuth)(
          projectSlug, hostCodexCreds.codexOauth,
        )
      }
    }

    // Seed every tool's host-side config, not just the active tool's — the
    // dirs are all mounted into every pod anyway, and a retooled spare must
    // find its config in place. All writes are cheap and idempotent.

    // claude.json (hostPath-mounted as a file): seed claude-code's onboarding
    // state so the first-run wizard — theme picker then login — is skipped.
    // The injected placeholder credential authenticates the agent; without
    // these flags the user is forced to log in inside every worktree.
    await seedClaudeJson(claudeJson)
    await seedClaudeSettings(path.join(claude, 'settings.json'))
    // Register the agent-session discovery hook (the script is baked into the
    // image; this only points claude at it). Best-effort: without it the
    // session still runs, with only the `--session-id`-pinned conversation
    // known to yaac.
    await ensureClaudeHooks(path.join(claude, 'settings.json')).catch(() => {})

    // Codex discovers its conversations through the same managed SessionStart
    // hook as the others (/etc/codex, baked into the image and trusted by
    // policy), so nothing is seeded into the mounted codex dir.

    // opencode: grant the websearch permission in the shared opencode.json so
    // the Exa-backed tool is usable (paired with OPENCODE_ENABLE_EXA below).
    await ensureOpencodeConfigJson(opencodeConfig)

    // Pre-create cacheVolumes host dirs so they're server-owned rather than
    // root-owned via DirectoryOrCreate — the in-container yaac user carries
    // the server's uid, so server-owned means yaac-writable.
    const cacheVolumeEntries = Object.entries(config.cacheVolumes ?? {})
    for (const [key] of cacheVolumeEntries) {
      await fs.mkdir(cacheVolumeDir(projectSlug, key), { recursive: true })
    }

    // yaac's own bundled skills, delivered the way this substrate can. A pod
    // gets a fresh per-worktree copy staged under the worktree dir and mounted
    // read-only over every tool's personal skills root below — never written
    // into the persisted per-project config dirs, so nothing goes stale there.
    // A containerless workspace has no mount namespace to layer that over its
    // tool homes (which are links into those very dirs), so the skills are
    // linked into the project's shared skills roots once instead.
    const builtinSkillsStaging = path.join(worktreeStateDir(projectSlug, worktreeId), 'builtin-skills')
    const builtinSkillNames = hostSkills
      ? await syncSharedBuiltinSkills(builtinSkillsDir(), projectSlug)
      : await stageBuiltinSkills(builtinSkillsDir(), builtinSkillsStaging)

    // In-session helper commands (yaac-spawn, and the yaac-worktree-init
    // postStart hook): staged like the builtin skills and File-mounted
    // read-only onto /usr/local/bin in the pod.
    const worktreeBinStaging = path.join(worktreeStateDir(projectSlug, worktreeId), 'bin')
    const worktreeBinNames = await stageWorktreeBin(worktreeBinDir(), worktreeBinStaging)
    // The postStart hook is mandatory — without it the pod boots with no
    // git identity, tmux server, or streamd. The other worktree-bin scripts
    // are optional helpers; this one missing means a broken install.
    if (!worktreeBinNames.includes(WORKTREE_INIT_SCRIPT)) {
      throw new ServerError(
        'INTERNAL',
        `worktree-bin staging is missing ${WORKTREE_INIT_SCRIPT} — broken yaac install?`,
      )
    }
    if (!hostSkills && builtinSkillNames.length > 0) {
      // Pre-create each tool's personal skills root (server-owned) before the
      // pod mounts a skill at `<root>/<name>`. Otherwise the kubelet creates the
      // intervening `skills/` dir as root:root to host the nested mount, which
      // would block the non-root agent from adding its own personal skills there.
      // Only the per-skill leaf mountpoints stay kubelet-owned (empty, and
      // skipped by discovery, so no stale skill ever surfaces). Best-effort: a
      // skills-dir permission hiccup must never fail worktree creation — the skill
      // still mounts; at worst the agent can't add same-root personal skills.
      // The containerless sync makes the same roots itself, as real dirs it
      // then links into — nothing mounts, so there is no kubelet to race.
      await Promise.allSettled(sharedSkillRoots(projectSlug).map((d) => fs.mkdir(d, { recursive: true })))
    }

    return {
      toolAuthByTool, sshKnownHostsFile, cacheVolumeEntries,
      builtinSkillsStaging, builtinSkillNames, worktreeBinStaging, worktreeBinNames,
      claude, claudeJson, codex, opencodeData, opencodeConfig, pi,
      cachedPackages, acpLogs, sessionStarts,
    }
  })()

  const [imageRef, substrate, prep] = await Promise.all([imageTask, substrateTask, prepTask])
  const {
    toolAuthByTool, sshKnownHostsFile, cacheVolumeEntries,
    builtinSkillsStaging, builtinSkillNames, worktreeBinStaging, worktreeBinNames,
    claude, claudeJson, codex, opencodeData, opencodeConfig, pi,
    cachedPackages, acpLogs, sessionStarts,
  } = prep

  // Build container env. Unlike the podman create API (whose Env field
  // replaced the image ENV wholesale), kubernetes env vars overlay the
  // image's — so no image-inspect merge step is needed.
  const env: string[] = []

  // The worktree this pod runs. The only thing left reading it inside an
  // image is the zsh prompt in Dockerfile.default.
  env.push(`YAAC_WORKTREE_ID=${worktreeId}`)

  // Passthrough env vars
  if (config.envPassthrough) {
    for (const name of config.envPassthrough) {
      // eslint-disable-next-line no-process-env -- user-configured passthrough; name comes from project config, not a fixed yaac var
      const val = process.env[name]
      if (val !== undefined) {
        env.push(`${name}=${val}`)
      }
    }
  }

  // Hardcoded env vars from config — applied after passthrough so literal
  // values win on conflict.
  if (config.env) {
    for (const [name, val] of Object.entries(config.env)) {
      env.push(`${name}=${val}`)
    }
  }

  // Proxied secrets. With a proxy, only a sentinel goes in and the egress
  // path holds the value; with none, the sentinel would be what the tool
  // actually sent, so the value itself goes in. Same question the egress
  // path is handed the answer to, so it is resolved once either way.
  const proxiedSecrets = resolveProxySecrets(config)
  for (const [name, value] of Object.entries(proxiedSecrets)) {
    env.push(`${name}=${mediatedEgress ? 'placeholder' : value}`)
  }

  // Add placeholder env vars so no tool prompts for login inside the
  // container. The proxy injects the real credentials on API calls. All
  // tools' vars go in (each gated on its own credential's kind) because the
  // pod spec is immutable and a prewarmed spare may be retooled at claim
  // time. The vars are only sentinels: the proxy swaps a placeholder for
  // whichever host it is being sent to, without regard to the worktree's tool,
  // so carrying another tool's placeholder does grant access to its
  // credential — a deliberate widening (see k8s/proxy/proxy.ts). What keeps
  // the proxy off a user's own traffic is the sentinel match, not the tool.
  // With a proxy the sentinel is what travels and the real key never enters
  // the workspace; without one the key itself has to, or the agent
  // authenticates with the literal word "placeholder".
  const apiKeyFor = (real: string): string => mediatedEgress ? PLACEHOLDER_API_KEY : real
  if (toolAuthByTool.claude?.kind === 'api-key') {
    env.push(`ANTHROPIC_API_KEY=${apiKeyFor(toolAuthByTool.claude.apiKey)}`)
  }
  // Claude OAuth: Claude Code reads the placeholder bundle from the mounted
  // .claude/.credentials.json, so no env var is needed.
  if (toolAuthByTool.opencode?.kind === 'api-key') {
    // opencode is api-key only. It reads the chosen provider's env var (every
    // provider is a first-class models.dev provider, so no opencode.json block
    // is needed) and sends the key to that provider's host, which the proxy
    // swaps for the real key. The env var + host come from the generated
    // provider table.
    const info = opencodeProviderInfo(toolAuthByTool.opencode.opencodeProvider)
    env.push(`${info.envVar}=${apiKeyFor(toolAuthByTool.opencode.apiKey)}`)
  }
  if (toolAuthByTool.codex?.kind === 'api-key') {
    env.push(`OPENAI_API_KEY=${apiKeyFor(toolAuthByTool.codex.apiKey)}`)
  }
  if (toolAuthByTool.pi?.kind === 'api-key') {
    // pi is api-key only. It reads the chosen provider's env var and sends the
    // key to that provider's host, which the proxy swaps for the real key
    // (whichever of Authorization: Bearer / x-api-key carries the sentinel).
    // The env var + host come from the generated provider table.
    const info = piProviderInfo(toolAuthByTool.pi.piProvider)
    env.push(`${info.envVar}=${apiKeyFor(toolAuthByTool.pi.apiKey)}`)
  }
  // Codex OAuth: Codex reads the placeholder bundle from the mounted
  // .codex/auth.json. Setting OPENAI_API_KEY would risk steering Codex
  // into api-key mode instead of ChatGPT OAuth.

  // GitHub CLI (`gh`) auth: when the project's remote is an HTTPS GitHub repo,
  // hand `gh` a placeholder GH_TOKEN so it treats itself as logged in. The
  // proxy swaps the placeholder for the worktree's real HTTPS git token on
  // api.github.com requests (see buildDynamicRules in the proxy), reusing the
  // PAT yaac already manages — no separate `gh auth login`. An SSH remote has
  // no HTTPS token to inject, so gh stays unauthenticated there.
  //
  // Skipped when the user already wires a GitHub token themselves — an explicit
  // GH_TOKEN (envPassthrough/config.env) or an envSecretProxy entry for
  // GH_TOKEN/GITHUB_TOKEN — so their configuration wins.
  const userWiresGithubToken = env.some((e) => e.startsWith('GH_TOKEN='))
    || Boolean(config.envSecretProxy?.GH_TOKEN)
    || Boolean(config.envSecretProxy?.GITHUB_TOKEN)
  if (credential.kind === 'https'
    && ghApiHostForGitHost(parsedRemote.host) !== null
    && !userWiresGithubToken) {
    env.push(`GH_TOKEN=${mediatedEgress ? PLACEHOLDER_GH_TOKEN : credential.token}`)
  }

  // Enable opencode's Exa-backed websearch tool. opencode only registers
  // the tool when this env var is truthy; the matching `permission.websearch`
  // entry is written into the shared opencode.json below. The MCP endpoint
  // `mcp.exa.ai` is on the default proxy allowlist. Set unconditionally
  // (only opencode reads it) so a spare retooled to opencode gets it.
  env.push('OPENCODE_ENABLE_EXA=true')

  // Pin opencode to the baked-in version by stopping its startup self-upgrade.
  // opencode npm-upgrades itself to the latest release on launch; every
  // release after 1.0.142 renders a blank agent pane under gVisor — its native
  // @opentui/core renderer blocks on a terminal-capability handshake that our
  // headless worktree tmux never answers, so no frame is ever drawn. The image
  // pins opencode-ai@1.0.142 (dockerfiles/Dockerfile.tools); without this the
  // pod would silently upgrade back to a broken renderer (and hit the egress
  // proxy doing it). Set unconditionally (only opencode reads it) so a spare
  // retooled to opencode gets it.
  env.push('OPENCODE_DISABLE_AUTOUPDATE=1')

  // Point pi at its worktree-log dir inside the mounted `.pi` home so its JSONL
  // transcripts are readable on the host (first-message / status). pi resumes
  // by `--session-id` (buildAgentCmd), so the shared home holding every
  // worktree's logs is fine. Skip pi's startup version check so a fresh pod
  // doesn't stall on a network probe. Set unconditionally (only pi reads them)
  // so a spare retooled to pi gets them.
  env.push(`PI_CODING_AGENT_SESSION_DIR=${PI_SESSIONS_CONTAINER_DIR}`)
  env.push('PI_SKIP_VERSION_CHECK=1')

  // Port forwarding: reserve host ports in the server process so no
  // other process can claim them between discovery and the forwarder
  // starting up. The server owns the forwarders for the worktree's
  // lifetime; they are torn down by `deleteSession` and the stale-
  // worktree reaper.
  const forwardedPorts: ReservedPort[] = []
  if (config.portForward?.length) {
    for (const { containerPort, hostPortStart } of config.portForward) {
      emit(`Finding available host port starting from ${hostPortStart} for container port ${containerPort}...`, options)
      const reserved = await reserveAvailablePort(containerPort, hostPortStart)
      forwardedPorts.push(reserved)
      emit(`Forwarding host port ${reserved.hostPort} -> container port ${containerPort}`, options)
    }
  }

  // Inputs for the postStart setup script (yaac-worktree-init): git
  // identity, the initial agent window name, the tmux status line (embeds
  // the host ports reserved just above), and the nested-engine switches.
  env.push(`YAAC_TOOL=${tool}`)
  env.push(`YAAC_GIT_NAME=${gitUser.name}`)
  env.push(`YAAC_GIT_EMAIL=${gitUser.email}`)
  env.push(`YAAC_STATUS_RIGHT=${buildStatusRight(projectSlug, worktreeId, forwardedPorts)}`)
  if (nestedContainers) env.push('YAAC_NESTED_ENGINE=1')

  // Every mount declares its SOURCE, not just a host path — the seam the
  // stock-k8s backend needs (docs/plans/stock-k8s-multi-node.md §2). What
  // drives each choice is the storage tier the path already declares in
  // project-paths.ts, so this list invents no second classification:
  //   SHARED     — the server and the worktree pod must see the same bytes.
  //                hostPath here (one node, one filesystem); a subPath of
  //                the RWX claim once the tiers become different volumes.
  //   NODE-LOCAL — never has to leave the node it was written on. hostPath
  //                here too; node disk on a multi-node cluster.
  //   emptyDir   — the subset of NODE-LOCAL that nothing outside the pod
  //                ever opens and nothing needs after it dies. Only the
  //                tmux socket dir qualifies today.
  // User bindMounts are outside every tier: they name paths on the user's
  // own machine, so they are hostPath by definition.
  const mounts: WorkspaceMount[] = [
    // SHARED.
    { source: { kind: 'hostPath', path: wtDir }, mountPath: '/workspace' },
    { source: { kind: 'hostPath', path: `${repo}/.git` }, mountPath: '/repo/.git' },
    { source: { kind: 'hostPath', path: claude }, mountPath: '/home/yaac/.claude' },
    // Tool-agnostic on purpose: an ACP record belongs to the protocol, not to
    // whichever agent happens to speak it.
    ...(acpLogs !== undefined
      ? [{ source: { kind: 'hostPath' as const, path: acpLogs }, mountPath: CONTAINER_ACP_LOG_DIR }]
      : []),
    {
      source: { kind: 'hostPath', path: claudeJson, type: 'File' },
      mountPath: '/home/yaac/.claude.json',
    },
    // SHARED, and the one file the pod writes that the server reads back. A
    // `File` mount is safe here precisely because nothing ever renames it: a
    // rename would replace the inode the mount pins, and the pod would go on
    // writing to a file nobody reads.
    {
      source: { kind: 'hostPath', path: sessionStarts, type: 'File' },
      mountPath: CONTAINER_SESSION_STARTS_LOG,
    },
    { source: { kind: 'hostPath', path: codex }, mountPath: '/home/yaac/.codex' },
    // NODE-LOCAL: opencode's sqlite DB — WAL is unusable on a network
    // filesystem, and only this pod's node ever reads it.
    {
      source: { kind: 'hostPath', path: opencodeData },
      mountPath: '/home/yaac/.local/share/opencode',
    },
    // SHARED.
    { source: { kind: 'hostPath', path: opencodeConfig }, mountPath: '/home/yaac/.config/opencode' },
    { source: { kind: 'hostPath', path: pi }, mountPath: PI_CONTAINER_HOME },
    // NODE-LOCAL: the pnpm store hands out hardlinks, which can't cross a
    // filesystem, and its link/stat traffic hates a network one.
    {
      source: { kind: 'hostPath', path: cachedPackages },
      mountPath: '/home/yaac/.cached-packages',
    },
    // Pod-local: the tmux server socket. A UNIX socket only rendezvouses
    // within the kernel that bound it, and every consumer (attach, the
    // `tmux -C` status stream, the liveness probe) reaches tmux through
    // `kubectl exec` inside this pod — so there is nothing to share and
    // nothing to keep once the pod is gone.
    { source: { kind: 'emptyDir' }, mountPath: CONTAINER_TMUX_DIR },
    // SHARED: the point of a cache volume is that the NEXT worktree gets the
    // warm cache, wherever it is scheduled.
    ...cacheVolumeEntries.map(([key, containerPath]): WorkspaceMount => ({
      source: { kind: 'hostPath', path: cacheVolumeDir(projectSlug, key) },
      mountPath: containerPath,
    })),
    // User bindMounts may point at files or directories — omit `type` so
    // the kubelet mounts whatever exists.
    ...(config.bindMounts ?? []).map(({ hostPath, containerPath, mode }): WorkspaceMount => ({
      source: { kind: 'hostPath', path: hostPath, type: '' },
      mountPath: containerPath,
      readOnly: mode === 'ro',
    })),
    // NODE-LOCAL: the ephemeral module dirs live under the pnpm store.
    ...ephemeralMounts.map((m): WorkspaceMount => ({
      source: { kind: 'hostPath', path: m.hostBacking },
      mountPath: m.containerPath,
    })),
    // SHARED: server-staged trees (skills, worktree bin), written
    // host-side and read in-pod. The skills are mounted only where a mount
    // is what delivers them; `hostSkills` already put them on disk.
    ...(hostSkills ? [] : builtinSkillMounts(builtinSkillsStaging, builtinSkillNames)),
    ...worktreeBinMounts(worktreeBinStaging, worktreeBinNames),
  ]

  const spec: WorkspaceSpec = {
    projectSlug,
    workspaceId: worktreeId,
    tool,
    mode,
    prewarm: options.prewarm === true,
    ...(imageRef !== undefined ? { image: imageRef } : {}),
    env,
    mounts,
    resources: WORKTREE_RESOURCES,
    // In-worktree setup (git identity, tmux server + options, the agent
    // transport, the nested engine) runs from here, so the runtime can hold
    // "ready" until it is done and no per-command round trips are paid.
    // Prewarmed spares take this same path.
    postStartExec: [`/usr/local/bin/${WORKTREE_INIT_SCRIPT}`],
    nestedContainers,
    ...(sshKnownHostsFile !== undefined ? { ssh: { knownHostsFile: sshKnownHostsFile } } : {}),
    substrate,
    onProgress: (m) => emit(m, options),
  }

  // Retry the whole launch + setup so that if the runtime dies immediately
  // after it starts we begin fresh, instead of futilely retrying individual
  // commands against a dead workspace.
  const maxStartAttempts = 3
  // Set by the first attempt that got as far as a started unit — what a
  // teardown has to address, and the runtime is the only thing that can
  // name it.
  let target: TeardownTarget | undefined
  let handle: RuntimeHandle | undefined

  const setupParams: WorktreeSetupParams = {
    spec, projectSlug, worktreeId, tool, mode, launching, initWindows, autoApprove,
    piProvider: toolAuthByTool.pi?.piProvider,
    onLaunched: (h) => {
      target = { projectSlug, workspaceId: worktreeId, unitName: h.jobName }
    },
    options, worktree: worktreeTask,
  }

  for (let attempt = 1; attempt <= maxStartAttempts; attempt++) {
    try {
      handle = await launchWithSetup(setupParams)
      break
    } catch (err) {
      // A worktree-provisioning failure (bad branch, fetch error) is not
      // the workspace's fault — relaunching would just re-await the same
      // rejected promise, so fail fast with the original error.
      const lastAttempt = err instanceof SetupInputError || attempt >= maxStartAttempts

      // Always take the half-started unit down. Otherwise a workspace left
      // running (tmux up, but a later command failed) is picked up by the
      // listing as a bogus waiting worktree, and a relaunch would collide
      // with the attempt that just failed.
      //
      // `unitOnly` for everything that is coming back. A further attempt
      // launches from the substrate this create already prepared, so
      // tearing that down between attempts would break the next one. A
      // create that gave up while KEEPING its checkout (a resume, a spare)
      // passes it too, for the adjacent reason: its row survives, so the
      // workspace is still named and the runtime's own sweeps collect the
      // rest on their schedule. A fresh create that gave up owns
      // everything it made and its row is about to go, so it takes the
      // whole teardown — otherwise the registration and the nested cluster
      // outlive the only thing that named them.
      const unitOnly = !lastAttempt || !failedCreateCollectsCheckout(options)

      // `launch` reports what it started through `onLaunched`, so a
      // rejection that lands AFTER the apply did — the API server took the
      // Job, the response was lost, and the retries then failed against a
      // network that stayed down — leaves nothing here naming the unit.
      // Ask the runtime rather than assume there is none: it is the
      // authority on what exists, and the checkout removal below gates on
      // nothing running over /workspace. Assuming nothing is would rm it
      // out from under a pod that is coming up.
      //
      // The verdict is what that gate reads. `false` covers a unit still in
      // its grace period AND a runtime that could not be reached at all —
      // the same condition that hides a unit hides its absence, so an
      // unreachable runtime is never read as "nothing is there".
      let podGone: boolean
      try {
        target ??= await worktreeDriver().findForTeardown(worktreeId)
        podGone = target === undefined
          ? true
          : await worktreeDriver().destroy(target, { salvageImages: false, unitOnly })
      } catch {
        podGone = false
      }

      if (!lastAttempt) {
        emit(`Session startup failed (attempt ${attempt}/${maxStartAttempts}), retrying...`, options)
        continue
      }
      // Release any pre-bound host ports so a retry (or the reaper) can
      // rebind them.
      for (const p of forwardedPorts) p.server.close()
      if (!options.prewarm) {
        // The staged checkout goes with the failed create. Nothing else
        // would collect it: the rollback below erases the row, and every
        // sweep that could name a leftover works from rows. What is removed
        // is this create's own product — a checkout freshly made from
        // `origin/<refBranch>`, holding at worst init-command build output
        // and an unprompted agent's boot state, since the last step that can
        // fail a create is the agent launch and prompt delivery after it is
        // explicitly non-fatal.
        //
        // Only for a FRESH create. A resume keeps its worktree: that
        // checkout predates this create and holds the work the user means
        // to come back to, which is also why its rollback records a stop
        // instead of deleting the row.
        //
        // Chained off the checkout leg rather than run here, because the two
        // race in one direction that matters. The leg is usually the very
        // thing that failed — then it has settled and this runs at once —
        // but a POD-side failure (image pull, never Ready, all attempts
        // burned) arrives while it can still be mid-fetch, and `addWorktree`
        // re-creates its destination before checking out. Deleting first
        // would leave a complete checkout staged *after* the rm: precisely
        // the orphan this exists to prevent. Waiting for the leg inline would
        // instead queue the caller's error behind a stuck fetch, so the
        // create fails fast and the removal follows the leg.
        //
        // Each step gates the next on having happened, as on the claim path.
        // A delete that timed out leaves a pod in its grace period still
        // writing to /workspace, and a failed rm leaves bytes; either way the
        // row stays, because it is the last name those bytes have. What stays
        // is not lost — the stale reaper turns a row whose pod never arrived
        // into an ordinary stopped worktree the user can see and delete.
        if (failedCreateCollectsCheckout(options)) {
          void worktreeTask
            .catch(() => { /* the failure is already the caller's */ })
            .then(() => podGone && deleteWorktreeState(projectSlug, worktreeId))
            .then((removed) => (removed
              ? reportCreateFailed(projectSlug, worktreeId, options)
              : undefined))
            .catch(() => { /* best-effort; nothing else can retry it */ })
        } else {
          await reportCreateFailed(projectSlug, worktreeId, options)
        }
      }
      throw err instanceof SetupInputError ? err.inner : err
    }
  }

  if (handle === undefined) {
    // Unreachable: the loop leaves only by `break` with a handle, or by
    // throwing on its last attempt.
    throw new ServerError('INTERNAL', 'worktree launch reported no handle')
  }

  // The workspace is up — hand the reserved sockets off to long-lived
  // forwarders owned by the runtime. These stay alive across user
  // attaches/detaches and come down only with a delete or the reaper.
  worktreeDriver().startForwarders(worktreeId, forwardedPorts)

  // The branch the worktree forked from, now that the (concurrent) checkout
  // has resolved it. A separate report from the one above so recording the
  // worktree never had to wait on provisioning; best-effort, since a missing
  // base costs a sidebar chip and nothing else. A resume keeps what it
  // already recorded — its worktree was left as-is.
  if (!options.prewarm) {
    const { upstreamStartPoint } = await worktreeTask
    if (upstreamStartPoint !== undefined) {
      await applyWorktreeEvent({
        type: 'base-branch-resolved',
        projectSlug,
        worktreeId,
        baseBranch: upstreamStartPoint.replace(/^origin\//, ''),
      })
    }
  }

  return {
    worktreeId,
    // The runtime's own name for what it started — never derived here.
    jobName: handle.jobName,
    forwardedPorts: forwardedPorts.map(({ containerPort, hostPort }) => ({ containerPort, hostPort })),
    tool,
    mode,
  }
}
