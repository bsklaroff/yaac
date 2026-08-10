import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import simpleGit from 'simple-git'
import { ensureImage, primeWorktreeImages, pushImageShared } from '#runtime/k8s/images'
import {
  buildWorktreeRegistration,
  hostMatchesPattern,
  proxyClient,
  resolveAllowedHosts,
  resolveProxyImageTag,
  syncProxySecrets,
} from '#runtime/k8s/egress'
import { ensureContainerRuntime } from '#platform/container'
import { reserveAvailablePort, startPortForwarders } from '#platform/port'
import {
  LABEL_DATA_DIR_HASH,
  LABEL_MODE,
  LABEL_PREWARMED,
  LABEL_PROJECT,
  LABEL_TOOL,
  SSH_AGENT_PORT,
  SSH_AGENT_SOCKET_PATH,
  SSH_TUNNEL_SENTINEL,
  TUNNEL_INGRESS_PORT,
  type PodMount,
  awaitDeferredClusterBoot,
  buildPodJobManifest,
  ensurePriorityClasses,
  dataDirHash,
  k8sNamespace,
  kubectlApply,
  kubectlWithRetry,
  relayTcpFactory,
  podExec,
  worktreeJobName,
  podStreamToken,
  waitForJobPodReady,
  waitForStreamd,
  worktreeIdLabels,
} from '#platform/k8s'
import type { ReservedPort } from '#platform/port'
import { createKeyedMutex } from '#platform/keyed-mutex'
// Aliased: this module uses a local `env: string[]` for the pod's env vars.
import { env as yaacEnv, testEnv } from '@yaac/shared/env'
import {
  ensureActivator,
  ensureProjectRegistry,
  ensureWorktreeVcluster,
  ensureVclusterImages,
  projectRegistryConfDropIn,
  projectRegistryHost,
  proxyServiceClusterIp,
  sleepVcluster,
  vclusterName,
  waitForVclusterKubeconfig,
} from '#runtime/k8s/cluster'
import {
  repoDir,
  acpLogDir,
  claudeDir,
  claudeJsonFile,
  codexDir,
  nestedYaacDataDir,
  opencodeConfigDir,
  opencodeDataDir,
  piDir,
  cachedPackagesDir,
  cacheVolumeDir,
  worktreeStateDir,
  worktreeVclusterDir,
  worktreeDir,
  projectDir,
} from '@yaac/shared/project-paths'
import {
  CONTAINER_ACP_LOG_DIR,
  CONTAINER_SESSION_STARTS_LOG,
  CONTAINER_TMUX_DIR,
} from '@yaac/shared/paths'
import { loadKnownHostsEntryForHost, parseGitRemote, resolveCredentialForUrl, resolveEphemeralModulesPaths, resolveProjectConfig } from '#store/projects'
import { ghApiHostForGitHost } from '@yaac/shared/credentials'
import { writeKnownHostsFile } from '#platform/git'
import { formatSshCommand, getGitUserConfig } from '@yaac/shared/git'
import {
  loadToolAuthEntry,
  loadClaudeCredentialsFile,
  loadCodexCredentialsFile,
  writeProjectClaudePlaceholder,
  writeProjectCodexPlaceholder,
  PLACEHOLDER_API_KEY,
  PLACEHOLDER_GH_TOKEN,
} from '@yaac/shared/tool-auth'
import { addWorktree, getDefaultBranch, fetchOrigin, isGitAuthError, remoteBranchExists } from '#platform/git'
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
  removeLegacyCodexHook,
  validateInitWindows,
  type InitWindow,
} from '#runtime/agents'
import { applyWorktreeEvent } from '#records'
import { seedClaudeJson, seedClaudeSettings, prepareEphemeralMounts } from '#store/worktrees'
import {
  ensureSessionStartsLog,
  mergeSessions,
  newWorktreeMeta,
  recordWorktreeLife,
  updateWorktreeMeta,
} from '#store/worktrees'
import { builtinSkillsDir, stageBuiltinSkills, builtinSkillMounts } from '#domain/skills'
import {
  WORKTREE_INIT_SCRIPT,
  worktreeBinDir,
  worktreeBinMounts,
  stageWorktreeBin,
} from './spawn-script'
import { ServerError } from '@yaac/shared/errors'
import {
  buildStatusRight,
  registerWorktreeForwarders,
} from '#runtime/k8s/forwarders'
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

interface WorktreeSetupParams {
  imageRef: string
  jobName: string
  projectSlug: string
  worktreeId: string
  env: string[]
  mounts: PodMount[]
  /** Live proxy Service ClusterIP — the pod's resolver + egress redirect target. */
  proxyHost: string
  nested?: boolean
  /** Inner (nested) yaac — don't stamp a RuntimeClass (see PodJobParams). */
  innerYaac?: boolean
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

async function startJobWithSetup(params: WorktreeSetupParams): Promise<void> {
  const {
    imageRef, jobName, projectSlug, worktreeId, env, mounts,
    proxyHost, nested, innerYaac, tool, mode, launching, initWindows, piProvider,
    options, worktree,
  } = params

  const manifest = buildPodJobManifest({
    jobName,
    namespace: k8sNamespace(),
    labels: {
      [LABEL_PROJECT]: projectSlug,
      ...worktreeIdLabels(worktreeId),
      [LABEL_DATA_DIR_HASH]: dataDirHash(),
      [LABEL_TOOL]: tool,
      // Stamped only for acp: the status watcher picks its driver from this,
      // and every pod without it (every TUI pod, and every pod predating
      // modes) reads as tui.
      ...(mode === 'acp' ? { [LABEL_MODE]: mode } : {}),
      // Prewarmed spares carry this until claimed; claiming removes it
      // (kubectl label pod yaac.prewarmed-), flipping the pod to a normal
      // worktree that lists in the user-facing views.
      ...(options.prewarm ? { [LABEL_PREWARMED]: 'true' } : {}),
    },
    image: imageRef,
    env,
    mounts,
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
    // 16-core box — because it caps both the burst and (via
    // -cpu-num-from-quota) the sandbox's systrap stub count. Worktrees doing
    // heavy parallel work (e2e: image builds, container starts) keep most of
    // their headroom; what they lose is the ability to take the whole node.
    cpuLimitMillis: 8000,
    // Worktrees keep their repo, worktrees and caches on hostPath (later
    // PVC) mounts, which are not ephemeral storage — what lands here is the
    // writable layer, logs, and the pod-local emptyDirs (the tmux socket
    // dir, the ssh-agent socket dir, and nested-only the graphroot). 2Gi
    // covers the steady state; the 16Gi ceiling is a blast-radius bound on
    // a worktree filling the node's disk, not a budget anyone should hit.
    ephemeralStorageRequestBytes: 2 * 1024 ** 3,
    ephemeralStorageLimitBytes: 16 * 1024 ** 3,
    proxyHost,
    nested,
    innerYaac,
    // In-pod setup (git identity, tmux server + options, streamd, the
    // nested engine) runs as the container's postStart hook, so the
    // kubelet holds Ready until it's done and no per-command exec round
    // trips are paid. Prewarmed spares take this same path.
    postStartExec: [`/usr/local/bin/${WORKTREE_INIT_SCRIPT}`],
  })
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

  // The pod names a PriorityClass, and the apiserver rejects a pod whose
  // class is missing — the Job applies and no pod ever appears. The boot
  // bootstrap ensures the classes, but best-effort (one logged catch), so an
  // upgraded install whose one boot found the cluster unreachable would fail
  // every create until a restart. Idempotent and cheap next to a pod create.
  await ensurePriorityClasses()
  await kubectlApply(manifest)
  // Each race can abandon a still-pending wait when the worktree leg
  // rejects first — pre-mark the waits handled so a later rejection from
  // an abandoned one (e.g. a timeout against the Job the retry loop is
  // already deleting) can't surface as an unhandled rejection.
  const podReady = waitForJobPodReady(jobName)
  podReady.catch(() => { /* observed via race */ })
  await Promise.race([podReady, worktreeFailure])

  // First relay contact doubles as the streamd readiness gate; every setup
  // command below rides the relay (single-digit ms per command) instead of
  // a ~300ms kubectl exec through the apiserver.
  const streamdReady = waitForStreamd(jobName)
  streamdReady.catch(() => { /* observed via race */ })
  await Promise.race([streamdReady, worktreeFailure])

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

  // Re-point the worktree's git plumbing at in-container paths and lock it
  // against `git worktree prune` — one exec (see buildWorktreeLinkExec).
  await podExec(jobName, buildWorktreeLinkExec(worktreeId))

  // Fresh worktree: set the worktree branch's upstream from inside the pod
  // (virtiofs cache coherence — see buildUpstreamExec), serialized against
  // every other in-flight upstream write on this project's shared config.
  if (upstreamStartPoint) {
    const upstream = upstreamStartPoint
    await withUpstreamConfigLock(projectSlug, async () => {
      await podExec(jobName, buildUpstreamExec(upstream))
    })
  }

  // Nested worktrees: the postStart hook started the rootful in-pod engine
  // in the background (yaac-worktree-init, which also writes the project
  // registries.conf drop-in from YAAC_REGISTRY_CONF_B64).
  // Gate on `docker version` here so a broken engine fails the create with
  // a clear error instead of a confusing "cannot connect to docker" the
  // first time the agent runs.
  if (nested) {
    emit('Waiting for the in-pod container engine...', options)
    const deadline = Date.now() + 60_000
    for (;;) {
      try {
        await podExec(jobName, 'docker version', { maxAttempts: 1, timeout: 10_000 })
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

    // Warm the engine from the project registry — the pull half of the
    // image salvage, so an agent's first `docker build` hits the layers
    // this project's earlier worktrees built. Deliberately NOT awaited: the
    // registry can hold gigabytes, and a pull decompressing inside the
    // sandbox takes minutes — the agent must not wait on it. An agent
    // build racing the prime is benign (the engine's store locking
    // serializes them; worst case a layer is rebuilt instead of pulled).
    // Best-effort and bounded either way, so a registry-less or slow
    // project ends up with a cold cache, never a failed create.
    void primeWorktreeImages({ jobName, projectSlug, worktreeId })
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
  await podExec(jobName, buildWindowsExec(initWindows, tool, agentCmds))

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
}

/**
 * Report that a create gave up, so the server can undo what the matching
 * `worktree-created` started. What "undo" means differs by `resume` and is
 * records' to decide (see `apply-worktree-event.ts`); this half knows only
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

  await ensureContainerRuntime()

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
  const remoteUrl = (await simpleGit(repo).remote(['get-url', 'origin']))?.trim()
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
  // The per-project registry backs both the vcluster image flow and the
  // nested engine's image cache — but an inner yaac cannot host one (see
  // the ensure below).
  const projectRegistry = nestedContainers && !yaacEnv.nested

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
  const jobName = worktreeJobName(projectSlug, worktreeId)

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

  // The worktree's own record, written for a prewarmed spare too — unlike a row,
  // which a spare only gets when it is claimed. A spare is a checkout, a branch
  // and a pod from the moment it is warmed, and this document is what the delete
  // path reads to take all of it away again if it is reaped unclaimed.
  await updateWorktreeMeta(projectSlug, worktreeId, (current) =>
    current !== undefined && options.resume === true
      ? current
      : newWorktreeMeta({
        projectSlug,
        worktreeId,
        branch: `agent/${worktreeId}`,
        createdAtMs: Date.now(),
        spare: options.prewarm === true,
      }))
  // Stamped before any handle is recorded, because a life is exactly the
  // boundary that invalidates the previous one's handles: tmux pane ids
  // restart at %0, so last life's handle would otherwise name this life's
  // pane. Removing the pane pointers from three tool homes is what worktree
  // create used to do here instead.
  const lifeId = await recordWorktreeLife(projectSlug, worktreeId, jobName, Date.now())

  // Report the worktree BEFORE anything is provisioned, so no pod can ever
  // exist without a row — a rowless pod is invisible to every path that
  // reads recorded state (titles, background, the deleted listing, restart)
  // and there is no safe way to tell one from an unclaimed spare later.
  // A failure to record therefore fails the create before it has built
  // anything, and a create that fails later reports that too (see
  // `reportCreateFailed`). Prewarmed spares are not worktrees until claimed,
  // so the claim reports their row instead (see tryClaimPrewarmed).
  //
  // `baseBranch` is deliberately not here: it comes from the worktree leg
  // that runs concurrently with the pod boot, and waiting for it would undo
  // that overlap. It is reported at the end.

  if (!options.prewarm) {
    await applyWorktreeEvent({
      type: 'worktree-created',
      projectSlug,
      worktreeId,
      resume: options.resume,
    })
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
      await updateWorktreeMeta(projectSlug, worktreeId, (current) =>
        current === undefined ? undefined : mergeSessions(current, launching.map((a, i) => ({
          tool: a.tool,
          agentSessionId: a.agentSessionId,
          mode,
          // Only `acp` knows its handle this early: it is the window name the
          // driver addresses the worktree by. A tmux pane does not exist yet.
          ...(mode === 'acp'
            ? { handle: agentWindowName(a.tool, i), handleLifeId: lifeId }
            : {}),
          ...(i === 0 && options.initialPrompt !== undefined
            ? { firstPrompt: options.initialPrompt }
            : {}),
        })), Date.now()))
    }
  }

  // ── Concurrent provisioning ─────────────────────────────────────────
  // The independent legs of provisioning run concurrently: image
  // ensure+push (podman + registry), fetch + worktree checkout (network +
  // disk), cluster-side ensures (proxy, vcluster, proxy registration), and
  // host-side fs prep. The worktree leg deliberately outlives the join
  // below — startJobWithSetup joins it after pod-Ready, so the checkout
  // also overlaps the pod's image pull and gVisor boot.

  const imageTask = (async () => {
    emit('Ensuring container images are built...', options)
    const imageName = await ensureImage(
      projectSlug,
      testEnv.imagePrefix,
      testEnv.requirePrebuiltImages,
      nestedContainers,
      {
        reason: 'session',
        onLayerStart: (i, total, layer) =>
          emit(`Building image layer ${i}/${total} (${layer})...`, options),
      },
    )
    emit('Pushing session image to the local registry...', options)
    return pushImageShared(imageName, { projectSlug, reason: 'session' })
  })()

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
    // empty; nothing pod-side reads /workspace before startJobWithSetup
    // joins this task.
    await addWorktree(repo, wtDir, `agent/${worktreeId}`, `origin/${refBranch}`)
    return { upstreamStartPoint: `origin/${refBranch}` }
  })()
  // Joined inside startJobWithSetup (or surfaced by the retry loop); this
  // marker only keeps a failure in another leg from turning a still-running
  // worktree leg into an unhandled rejection.
  worktreeTask.catch(() => { /* awaited later */ })

  const clusterTask = (async () => {
    // A nested server defers its boot-time cluster attach so it doesn't
    // wake its own born-at-zero vcluster; the first worktree create is the
    // "cluster is really needed now" signal. Awaited so the namespace
    // ensure inside it lands before anything below applies into it.
    // Immediate no-op on the outer server (nothing is ever armed).
    await awaitDeferredClusterBoot()

    // Proxy is always required — it reads the host-mounted credentials dir
    // directly and injects GitHub / Claude / Codex tokens into outbound HTTPS
    // requests. Credential updates via `yaac auth update` propagate to every
    // running worktree without needing to restart pods.
    emit('Ensuring proxy deployment...', options)
    await proxyClient.ensureRunning()

    // Every nested worktree gets the per-project push registry: it is the
    // image source for vcluster synced pods and yaac-in-yaac, AND the bus
    // the in-pod engine's cross-worktree image cache rides (salvage pushes,
    // the next worktree pulls — see image-promoter.ts). The pod reaches it
    // on its in-cluster ClusterIP, resolved through the proxy's
    // split-horizon DNS (`*.svc` → cluster CoreDNS), so no pinned VIP or
    // hostAliases is needed; the per-project NetworkPolicies this ensure
    // applies admit the flow, scoped to the worktree's own registry.
    // Never inside an INNER yaac: the ensure's node-write pods hostPath-mount
    // the node's containerd `certs.d` to publish the registry's hosts.toml,
    // and its vcluster's pod guard denies any hostPath outside the worktree's
    // own data dir — so the ensure could not finish. Those worktrees run
    // without a cross-worktree image cache (image-promoter self-gates too).
    if (projectRegistry) {
      emit('Ensuring project registry...', options)
      await ensureProjectRegistry(projectSlug)
    }

    // virtualCluster worktrees additionally get their own virtual cluster,
    // created here so its cold start overlaps the image, worktree, and
    // fs-prep legs; the kubeconfig is awaited at the end of this leg, just
    // before the mounts are assembled.
    let vclusterFreshlyCreated = false
    if (virtualCluster) {
      // The wake activator that serves this (and every) vcluster's
      // scale-to-zero — before the vcluster so its pod IP is available to
      // the sleep step below. Runs the proxy image the ensureRunning()
      // above just built and pushed.
      emit('Ensuring vcluster activator...', options)
      await ensureActivator(await resolveProxyImageTag(testEnv.proxyImage))

      emit('Creating virtual cluster...', options)
      await ensureVclusterImages()
      const { freshlyCreated } = await ensureWorktreeVcluster({
        worktreeId,
        allowedHostPathPrefix: nestedYaacDataDir(projectSlug, worktreeId),
        onProgress: (m) => emit(m, options),
      })
      vclusterFreshlyCreated = freshlyCreated
    }

    // Egress: the worktree pod's outbound 443/80 is redirected to the proxy at
    // the node level by netd's per-pod DNAT rules (k8s/netd)
    // — no per-pod sidecar. The pod also points its resolver at the proxy
    // (DNS stub) and dials the SSH tunnel sentinel; both are admitted by the
    // same worktree NetworkPolicy. The proxy identifies the worktree by the source pod IP
    // it watches, so nothing per-worktree needs injecting here.
    //
    // The proxy Service ClusterIP is allocator-assigned (no longer pinned) — for
    // both the outer and the vcluster-allocated inner proxy — so read it live.
    // Stable for the cluster's lifetime: the Service is never deleted/recreated.
    const proxyHost = await proxyServiceClusterIp()

    // streamd auth: the per-worktree token its handshake requires, derived
    // from the install's proxy secret (no new storage — survives server
    // restarts). Leaking it grants nothing: the ingress lock means only the
    // proxy reaches streamd, and the token only opens the pod's OWN daemon.
    const streamToken = await podStreamToken(worktreeId)

    // Register this worktree's state (envSecretProxy rules, allowlist, repo
    // URL) with the proxy. GitHub / Claude / Codex auth is handled
    // dynamically by the proxy from the mounted credentials dir — no per-
    // worktree rule is needed for those. envSecretProxy rules reference
    // their values by name; the values land in the proxy-secrets
    // credentials file first so the registration's secretRefs resolve from
    // the proxy's first request onward. The same builder backs the
    // reconciler's resync backstop.
    await syncProxySecrets(config)
    await proxyClient.registerWorktree(
      worktreeId,
      buildWorktreeRegistration({ config, remoteUrl, tool, projectSlug }),
    )

    // vcluster kubeconfig: wait for the syncer to publish it (the cold
    // start has been running since the ensure above), write it under the
    // worktree dir, and dir-mount it at ~/.kube. Speaks to the pinned
    // VIP:8443 (IP SAN) — no DNS involved.
    const vclusterMounts: PodMount[] = []
    const vclusterEnv: string[] = []
    if (virtualCluster) {
      emit('Waiting for the virtual cluster API...', options)
      const kubeconfig = await waitForVclusterKubeconfig(vclusterName(worktreeId))
      const vcDir = worktreeVclusterDir(projectSlug, worktreeId)
      await fs.mkdir(vcDir, { recursive: true })
      await fs.writeFile(path.join(vcDir, 'config'), kubeconfig, { mode: 0o600 })
      // SHARED: the server writes (and heals) the kubeconfig, the pod reads it.
      vclusterMounts.push({ source: { kind: 'hostPath', path: vcDir }, mountPath: '/home/yaac/.kube' })
      vclusterEnv.push('KUBECONFIG=/home/yaac/.kube/config')

      // Born-at-zero: with the kubeconfig captured, the freshly-booted
      // (never used) control plane is scaled to 0 — the activator wakes it
      // on the worktree's first API touch. Only a vcluster THIS create
      // booted may be slept: re-sleeping an existing one would discard its
      // state.db. Best-effort — a failed sleep just leaves the vcluster
      // running (the pre-scale-to-zero behavior).
      if (vclusterFreshlyCreated) {
        emit('Scaling idle virtual cluster to zero...', options)
        try {
          await sleepVcluster(vclusterName(worktreeId), worktreeId)
        } catch (err) {
          console.warn(`vcluster sleep (${worktreeId}): ${(err as Error).message}`)
        }
      }

      // yaac-in-yaac preset: the nested data dir is mounted at the
      // IDENTICAL absolute path in the pod, because inner synced-pod
      // hostPaths resolve on the NODE (which sees the host path via the
      // kind $HOME extraMount). It is also the VAP guard's only allowed
      // hostPath prefix for this worktree's synced pods. The registry env
      // points the inner server's pushes at the project's registry
      // (resolvable in-pod via the proxy's split-horizon DNS, on the node via
      // hosts.toml) — no repo-path prefix, that registry is already scoped.
      const nestedDataDir = nestedYaacDataDir(projectSlug, worktreeId)
      await fs.mkdir(nestedDataDir, { recursive: true })
      // SHARED, and a hostPath the NODE must resolve too: the inner yaac's
      // synced pods carry hostPaths under this dir (see nestedYaacDataDir).
      vclusterMounts.push({ source: { kind: 'hostPath', path: nestedDataDir }, mountPath: nestedDataDir })
      vclusterEnv.push(`YAAC_DATA_DIR=${nestedDataDir}`)
      vclusterEnv.push('YAAC_NESTED=1')
      vclusterEnv.push(`YAAC_K8S_REGISTRY=${projectRegistryHost(projectSlug)}`)
    }

    return { proxyHost, streamToken, vclusterMounts, vclusterEnv }
  })()

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

    // SSH provisioning: when the project's remote is SSH, forward the proxy's
    // ssh-agent into the pod (no private key inside the container) and
    // configure git's SSH transport to (a) use the agent for identity, (b)
    // verify with our project-scoped known_hosts, (c) tunnel through the MITM
    // proxy via HTTP CONNECT so the allowlist still applies.
    //
    // The agent rendezvous is a TCP hop to the proxy's SSH_AGENT_PORT, not a
    // shared host directory: yaac-worktree-init re-exposes it as the UNIX
    // socket SSH_AUTH_SOCK names, so a pod scheduled on another node than the
    // proxy still gets an agent (a hostPath socket only meets on one node).
    // The upstream env is appended below, where the cluster leg's proxy
    // ClusterIP is in scope.
    const sshMounts: PodMount[] = []
    const sshEnv: string[] = []
    if (parsedRemote.scheme === 'ssh') {
      const knownHostsEntry = await loadKnownHostsEntryForHost(parsedRemote.host)
      if (!knownHostsEntry) {
        throw new ServerError(
          'VALIDATION',
          `No SSH known_hosts entry for ${parsedRemote.host}. Run "yaac auth update" to register one.`,
        )
      }
      const knownHostsFile = path.join(projectDir(projectSlug), 'known_hosts')
      await writeKnownHostsFile([knownHostsEntry], knownHostsFile)
      const containerKnownHosts = '/home/yaac/.ssh/yaac/known_hosts'
      // SHARED: written under the project dir by the server, read in-pod.
      sshMounts.push({
        source: { kind: 'hostPath', path: knownHostsFile, type: 'File' },
        mountPath: containerKnownHosts,
        readOnly: true,
      })
      // ncat speaks CONNECT to a sentinel address that netd redirects
      // through the node Envoy to the proxy's tunnel listener — the same path
      // as HTTP(S). CONNECT carries the real host:port (so the allowlist sees
      // the hostname; a raw port-22 redirect would lose it), and Envoy stamps
      // the source pod IP, so identity is uniform (no x:<worktreeId> in env).
      const proxyCommand = `ncat --proxy ${SSH_TUNNEL_SENTINEL}:${TUNNEL_INGRESS_PORT}`
        + ' --proxy-type http %h %p'
      const gitSshCmd = formatSshCommand([
        'ssh', '-F', '/dev/null',
        '-o', `UserKnownHostsFile=${containerKnownHosts}`,
        '-o', 'StrictHostKeyChecking=yes',
        '-o', 'IdentitiesOnly=no',
        '-o', `ProxyCommand=${proxyCommand}`,
      ])
      sshEnv.push(`SSH_AUTH_SOCK=${SSH_AGENT_SOCKET_PATH}`)
      sshEnv.push(`GIT_SSH_COMMAND=${gitSshCmd}`)
    }

    // Refresh the per-project placeholder credential files from the current
    // host OAuth bundles. Picks up expiresAt changes since the last worktree.
    // Both tools are refreshed regardless of the active tool so a prewarmed
    // spare stays retoolable at claim time.
    if (toolAuthByTool.claude?.kind === 'oauth') {
      const hostClaudeCreds = await loadClaudeCredentialsFile()
      if (hostClaudeCreds?.kind === 'oauth') {
        await writeProjectClaudePlaceholder(projectSlug, hostClaudeCreds.claudeAiOauth)
      }
    }
    if (toolAuthByTool.codex?.kind === 'oauth') {
      const hostCodexCreds = await loadCodexCredentialsFile()
      if (hostCodexCreds?.kind === 'oauth') {
        await writeProjectCodexPlaceholder(projectSlug, hostCodexCreds.codexOauth)
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
    // policy), so nothing is seeded into the mounted codex dir. For projects
    // predating that hook, strip the stale user-layer one so it stops
    // triggering Codex's /hooks trust-approval prompt.
    await removeLegacyCodexHook(codex)

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

    // yaac's own bundled skills: stage a fresh copy under the worktree dir and
    // mount them read-only into every tool's personal skills root below. Copied
    // per worktree so they track the installed yaac version, and never written
    // into the persisted per-project config dirs (no staleness). Removed with the
    // worktree dir on cleanup.
    const builtinSkillsStaging = path.join(worktreeStateDir(projectSlug, worktreeId), 'builtin-skills')
    const builtinSkillNames = await stageBuiltinSkills(builtinSkillsDir(), builtinSkillsStaging)

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
    if (builtinSkillNames.length > 0) {
      // Pre-create each tool's personal skills root (server-owned) before the
      // pod mounts a skill at `<root>/<name>`. Otherwise the kubelet creates the
      // intervening `skills/` dir as root:root to host the nested mount, which
      // would block the non-root agent from adding its own personal skills there.
      // Only the per-skill leaf mountpoints stay kubelet-owned (empty, and
      // skipped by discovery, so no stale skill ever surfaces). Best-effort: a
      // skills-dir permission hiccup must never fail worktree creation — the skill
      // still mounts; at worst the agent can't add same-root personal skills.
      await Promise.allSettled([
        fs.mkdir(path.join(claude, 'skills'), { recursive: true }),
        fs.mkdir(path.join(codex, 'skills'), { recursive: true }),
        fs.mkdir(path.join(opencodeConfig, 'skills'), { recursive: true }),
        fs.mkdir(path.join(pi, 'agent', 'skills'), { recursive: true }),
      ])
    }

    return {
      toolAuthByTool, sshMounts, sshEnv, cacheVolumeEntries,
      builtinSkillsStaging, builtinSkillNames, worktreeBinStaging, worktreeBinNames,
      claude, claudeJson, codex, opencodeData, opencodeConfig, pi,
      cachedPackages, acpLogs, sessionStarts,
    }
  })()

  const [imageRef, cluster, prep] = await Promise.all([imageTask, clusterTask, prepTask])
  const {
    toolAuthByTool, sshMounts, sshEnv, cacheVolumeEntries,
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

  // CA-trust env only — no HTTP(S)_PROXY routing vars. Interception is
  // transparent at the network layer (see redirectInit above), so the
  // container needs nothing but trust in the MITM CA.
  env.push(...proxyClient.getCaTrustEnv())

  // streamd auth token (derived in the cluster leg).
  env.push(`YAAC_STREAM_TOKEN=${cluster.streamToken}`)

  // SSH transport env (agent socket + GIT_SSH_COMMAND), prepared alongside
  // the ssh mounts in the fs-prep leg. Non-empty only for an SSH remote,
  // which is also exactly when the in-pod agent forwarder is wanted — its
  // upstream is the proxy ClusterIP resolved in the cluster leg.
  env.push(...sshEnv)
  if (sshEnv.length > 0) {
    env.push(`YAAC_SSH_AGENT_UPSTREAM=${cluster.proxyHost}:${SSH_AGENT_PORT}`)
  }

  // Add placeholder values for proxied secrets so tools detect them
  if (config.envSecretProxy) {
    for (const name of Object.keys(config.envSecretProxy)) {
      // eslint-disable-next-line no-process-env -- user-configured secret proxy; name comes from project config, not a fixed yaac var
      if (process.env[name]) {
        env.push(`${name}=placeholder`)
      }
    }
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
  if (toolAuthByTool.claude?.kind === 'api-key') {
    env.push(`ANTHROPIC_API_KEY=${PLACEHOLDER_API_KEY}`)
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
    env.push(`${info.envVar}=${PLACEHOLDER_API_KEY}`)
  }
  if (toolAuthByTool.codex?.kind === 'api-key') {
    env.push(`OPENAI_API_KEY=${PLACEHOLDER_API_KEY}`)
  }
  if (toolAuthByTool.pi?.kind === 'api-key') {
    // pi is api-key only. It reads the chosen provider's env var and sends the
    // key to that provider's host, which the proxy swaps for the real key
    // (whichever of Authorization: Bearer / x-api-key carries the sentinel).
    // The env var + host come from the generated provider table.
    const info = piProviderInfo(toolAuthByTool.pi.piProvider)
    env.push(`${info.envVar}=${PLACEHOLDER_API_KEY}`)
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
    env.push(`GH_TOKEN=${PLACEHOLDER_GH_TOKEN}`)
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
  if (nestedContainers) {
    env.push('YAAC_NESTED_ENGINE=1')
    if (projectRegistry) {
      // The per-project registries.conf drop-in, written by the script
      // (sudo) before the engine starts. Base64 keeps the TOML free of
      // env-value quoting concerns. Every nested worktree needs it: the
      // registry is plain HTTP, and the image cache pushes/pulls through
      // it even when there is no vcluster.
      const conf = Buffer.from(projectRegistryConfDropIn(projectSlug), 'utf8').toString('base64')
      env.push(`YAAC_REGISTRY_CONF_B64=${conf}`)
    }
  }

  // vcluster wiring (KUBECONFIG, nested data dir, registry host) resolved
  // in the cluster leg.
  env.push(...cluster.vclusterEnv)

  // Inside a nested (inner) yaac no runtimeClassName is stamped — the
  // vcluster has no RuntimeClass objects, and the syncer sets the synced
  // pod's host runtime. Host pods get gvisor (pod-spec maps nested to the
  // gvisor-nested handler).
  const innerYaac = yaacEnv.nested

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
  const mounts: PodMount[] = [
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
    // `File` mount is safe here precisely because both ends only ever append
    // — the metadata document beside it is rewritten whole, which is why that
    // one is never mounted anywhere.
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
    ...cacheVolumeEntries.map(([key, containerPath]): PodMount => ({
      source: { kind: 'hostPath', path: cacheVolumeDir(projectSlug, key) },
      mountPath: containerPath,
    })),
    // User bindMounts may point at files or directories — omit `type` so
    // the kubelet mounts whatever exists.
    ...(config.bindMounts ?? []).map(({ hostPath, containerPath, mode }): PodMount => ({
      source: { kind: 'hostPath', path: hostPath, type: '' },
      mountPath: containerPath,
      readOnly: mode === 'ro',
    })),
    // NODE-LOCAL: the ephemeral module dirs live under the pnpm store.
    ...ephemeralMounts.map((m): PodMount => ({
      source: { kind: 'hostPath', path: m.hostBacking },
      mountPath: m.containerPath,
    })),
    // SHARED: server-staged trees (skills, worktree bin) and the per-worktree
    // vcluster / ssh files, all written host-side and read in-pod.
    ...builtinSkillMounts(builtinSkillsStaging, builtinSkillNames),
    ...worktreeBinMounts(worktreeBinStaging, worktreeBinNames),
    ...cluster.vclusterMounts,
    ...sshMounts,
  ]

  // Retry the entire Job create + setup so that if the pod dies
  // immediately after creation we start fresh instead of futilely retrying
  // individual exec calls against a dead pod.
  const maxStartAttempts = 3
  const setupParams: WorktreeSetupParams = {
    imageRef, jobName, projectSlug, worktreeId, env, mounts, launching,
    proxyHost: cluster.proxyHost, nested: nestedContainers, innerYaac, tool, mode, initWindows,
    piProvider: toolAuthByTool.pi?.piProvider,
    options, worktree: worktreeTask,
  }

  emit(`Creating session job ${jobName}...`, options)

  for (let attempt = 1; attempt <= maxStartAttempts; attempt++) {
    try {
      await startJobWithSetup(setupParams)
      break
    } catch (err) {
      // Always remove the half-created Job. Otherwise a pod left running
      // (e.g. tmux up but a later exec failed) gets picked up by
      // listActiveWorktrees as a bogus waiting worktree. Foreground cascade
      // so the dead pod is fully gone before a retry re-applies the Job —
      // waitForJobPodReady matches pods by the job-name label and must not
      // see the previous attempt's terminating pod.
      try {
        await kubectlWithRetry([
          'delete', 'job', jobName, '-n', k8sNamespace(),
          '--ignore-not-found', '--cascade=foreground',
          '--wait=true', '--timeout=30s',
        ])
      } catch { /* already gone */ }
      // A worktree-provisioning failure (bad branch, fetch error) is not
      // the pod's fault — recreating the Job would just re-await the same
      // rejected promise, so fail fast with the original error.
      if (!(err instanceof SetupInputError) && attempt < maxStartAttempts) {
        emit(`Session startup failed (attempt ${attempt}/${maxStartAttempts}), retrying...`, options)
        continue
      }
      // Release any pre-bound host ports so a retry (or the reaper) can
      // rebind them.
      for (const p of forwardedPorts) p.server.close()
      if (!options.prewarm) await reportCreateFailed(projectSlug, worktreeId, options)
      throw err instanceof SetupInputError ? err.inner : err
    }
  }

  // Pod is up — hand the reserved sockets off to long-lived forwarders
  // owned by the server. These stay alive across user attaches/detaches
  // and are torn down only by delete or the reaper.
  if (forwardedPorts.length > 0) {
    const stop = startPortForwarders(relayTcpFactory(worktreeId), forwardedPorts)
    registerWorktreeForwarders(worktreeId, stop, forwardedPorts)
  }

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
  // Mirrored into the metadata document for the same reason it is reported: it
  // is only knowable once the concurrent checkout resolves it.
  {
    const { upstreamStartPoint } = await worktreeTask
    if (upstreamStartPoint !== undefined) {
      const baseBranch = upstreamStartPoint.replace(/^origin\//, '')
      await updateWorktreeMeta(projectSlug, worktreeId, (current) =>
        current === undefined ? undefined : { ...current, baseBranch })
    }
  }

  return {
    worktreeId,
    jobName,
    forwardedPorts: forwardedPorts.map(({ containerPort, hostPort }) => ({ containerPort, hostPort })),
    tool,
    mode,
  }
}
