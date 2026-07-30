import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import simpleGit from 'simple-git'
import { ensureContainerRuntime } from '#platform/container/runtime'
import { ensureImage, pushImageShared } from '#features/images/build-coordinator'
import { sharedImageStoreHostPath } from '#features/images/image-promoter'
import {
  proxyClient,
  SSH_AGENT_MOUNT,
  SSH_AGENT_SOCKET_PATH,
} from '#features/sessions/egress/proxy-client'
import { buildSessionRegistration, syncProxySecrets } from '#features/sessions/egress/proxy-registration'
import { resolveAllowedHosts } from '#features/sessions/egress/default-allowed-hosts'
import { reserveAvailablePort, startPortForwarders } from '#platform/container/port'
import {
  relayTcpFactory,
  sessionExec,
  sessionStreamToken,
  waitForStreamd,
} from '#platform/k8s/stream-relay'
import type { ReservedPort } from '#platform/container/port'
import { waitForJobPodReady } from '#platform/k8s/pod-wait'
import { createKeyedMutex } from '#platform/keyed-mutex'
import { dataDirHash, k8sNamespace, kubectlApply, kubectlWithRetry } from '#platform/k8s/kubectl'
// Aliased: this module uses a local `env: string[]` for the pod's env vars.
import { env as yaacEnv, testEnv } from '@yaac/shared/env'
import {
  LABEL_DATA_DIR_HASH,
  LABEL_PREWARMED,
  LABEL_PROJECT,
  LABEL_SESSION_ID,
  LABEL_TOOL,
  sessionJobName,
} from '#platform/k8s/pods'
import {
  buildSessionJobManifest,
  type HostPathMount,
  type NestedContainersParams,
} from '#platform/k8s/pod-spec'
import { proxyServiceClusterIp, sshAgentHostDir } from '#features/cluster/proxy-apply'
import { SSH_TUNNEL_SENTINEL, TUNNEL_INGRESS_PORT } from '#features/cluster/proxy-constants'
import {
  ensureProjectRegistry,
  projectRegistryConfDropIn,
  projectRegistryHost,
} from '#features/cluster/project-registry'
import {
  ensureSessionVcluster,
  ensureVclusterImages,
  sleepVcluster,
  vclusterName,
  waitForVclusterKubeconfig,
} from '#features/cluster/vcluster'
import { ensureActivator } from '#features/cluster/activator'
import { awaitDeferredClusterBoot } from '#platform/k8s/deferred-boot'
import {
  repoDir,
  claudeDir,
  claudeJsonFile,
  codexDir,
  codexTranscriptDir,
  nestedYaacDataDir,
  opencodeConfigDir,
  opencodeDataDir,
  piDir,
  cachedPackagesDir,
  cacheVolumeDir,
  sessionDir,
  sessionVclusterDir,
  worktreeDir,
  projectDir,
  sessionTmuxDir,
} from '@yaac/shared/project-paths'
import {
  CONTAINER_TMUX_DIR,
} from '@yaac/shared/paths'
import {
  resolveProjectConfig,
  resolveEphemeralModulesPaths,
} from '#features/projects/config'
import {
  resolveCredentialForUrl,
  parseGitRemote,
  loadKnownHostsEntryForHost,
} from '#features/projects/credentials'
import { ghApiHostForGitHost } from '@yaac/shared/credentials'
import { writeKnownHostsFile } from '#platform/git'
import { formatSshCommand, getGitUserConfig } from '@yaac/shared/git'
import { hostMatchesPattern } from '#features/sessions/egress/default-allowed-hosts'
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
import { removeLegacyCodexHook } from '#features/sessions/agents/codex'
import { ensureOpencodeConfigJson } from '#features/sessions/agents/opencode'
import {
  buildAgentCmd,
  typeInitialPrompt,
  type InitWindow,
} from '#features/sessions/agent-command'
import {
  buildUpstreamExec,
  buildWindowsExec,
  buildWorktreeLinkExec,
  validateInitWindows,
} from '#features/sessions/setup-commands'
import { seedClaudeJson, seedClaudeSettings, prepareEphemeralMounts } from '#features/sessions/seed'
import { builtinSkillsDir, stageBuiltinSkills, builtinSkillMounts } from '#features/skills/builtin'
import {
  SESSION_INIT_SCRIPT,
  sessionBinDir,
  sessionBinMounts,
  stageSessionBin,
} from '#features/sessions/spawn-script'
import { ServerError } from '@yaac/shared/errors'
import {
  buildStatusRight,
  registerSessionForwarders,
} from '#features/sessions/forwarders/port-forwarders'
import type { AgentTool, PortMapping, YaacConfig } from '@yaac/shared/types'
import {
  OPENCODE_DEFAULT_PROVIDER,
  PI_DEFAULT_PROVIDER,
  opencodeProviderInfo,
  piProviderInfo,
  type PiProvider,
} from '@yaac/shared/tool-providers'

/** In-pod pi home. The host-side `piDir` is mounted here (the whole `.pi`,
 *  mirroring `~/.claude`), so every session's pi logs are visible to all. */
const PI_CONTAINER_HOME = '/home/yaac/.pi'
/** In-pod dir pi writes its JSONL session logs to (PI_CODING_AGENT_SESSION_DIR
 *  points here; it lives under the mounted `PI_CONTAINER_HOME`). */
const PI_SESSIONS_CONTAINER_DIR = `${PI_CONTAINER_HOME}/agent/sessions`

function emit(message: string, options: SessionCreateOptions): void {
  console.log(message)
  options.onProgress?.(message)
}

export interface SessionCreateOptions {
  /** Pre-generated session ID (used by resume to know the Job name upfront). */
  sessionId?: string
  /** Agent tool to run inside the container (default: 'claude'). */
  tool?: AgentTool
  /**
   * Reference branch for the fresh worktree (a branch on `origin`, no
   * `origin/` prefix). Overrides the project's `referenceBranch` config
   * default; unset → that default, else the remote's default branch.
   */
  branch?: string
  /**
   * Resume an existing session: reuse the worktree at
   * `worktreeDir(projectSlug, sessionId)` if present and launch the agent
   * with `--resume` so it loads the prior transcript. Requires `sessionId`.
   */
  resume?: boolean
  /**
   * Provision a prewarmed spare: stamp the `yaac.prewarmed` pod label so the
   * session is hidden from user-facing views until claimed on a later
   * `session create`. Set by the prewarm reconciler; never by a user create.
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
   * Used by scheduled session starts and `session create --prompt`.
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
   * `yaac session create` can show what the server is doing.
   */
  onProgress?: (message: string) => void
}

export interface SessionCreateResult {
  sessionId: string
  jobName: string
  forwardedPorts: PortMapping[]
  tool: AgentTool
}

interface SessionSetupParams {
  imageRef: string
  jobName: string
  projectSlug: string
  sessionId: string
  env: string[]
  hostPathMounts: HostPathMount[]
  /** Live proxy Service ClusterIP — the pod's resolver + egress redirect target. */
  proxyHost: string
  nested?: NestedContainersParams
  /** Inner (nested) yaac — don't stamp a RuntimeClass (see SessionJobParams). */
  innerYaac?: boolean
  tool: AgentTool
  /** Pre-validated init windows (validateInitWindows ran in createSession). */
  initWindows: InitWindow[]
  /** pi only — provider whose default model drives `pi --model`. */
  piProvider?: PiProvider
  options: SessionCreateOptions
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
 * fresh session sets its branch upstream from inside its own pod (see
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

async function startJobWithSetup(params: SessionSetupParams): Promise<void> {
  const {
    imageRef, jobName, projectSlug, sessionId, env, hostPathMounts,
    proxyHost, nested, innerYaac, tool, initWindows, piProvider,
    options, worktree,
  } = params

  const manifest = buildSessionJobManifest({
    jobName,
    namespace: k8sNamespace(),
    labels: {
      [LABEL_PROJECT]: projectSlug,
      [LABEL_SESSION_ID]: sessionId,
      [LABEL_DATA_DIR_HASH]: dataDirHash(),
      [LABEL_TOOL]: tool,
      // Prewarmed spares carry this until claimed; claiming removes it
      // (kubectl label pod yaac.prewarmed-), flipping the pod to a normal
      // session that lists in the user-facing views.
      ...(options.prewarm ? { [LABEL_PREWARMED]: 'true' } : {}),
    },
    image: imageRef,
    env,
    hostPathMounts,
    memoryRequestBytes: 1 * 1024 ** 3,
    memoryLimitBytes: 8 * 1024 ** 3,
    proxyHost,
    nested,
    innerYaac,
    // In-pod setup (git identity, tmux server + options, streamd, the
    // nested engine) runs as the container's postStart hook, so the
    // kubelet holds Ready until it's done and no per-command exec round
    // trips are paid. Prewarmed spares take this same path.
    postStartExec: [`/usr/local/bin/${SESSION_INIT_SCRIPT}`],
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
  // see sessionUid in image-builder). Under gVisor there is no userns and no
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
  await sessionExec(jobName, buildWorktreeLinkExec(sessionId))

  // Fresh worktree: set the session branch's upstream from inside the pod
  // (virtiofs cache coherence — see buildUpstreamExec), serialized against
  // every other in-flight upstream write on this project's shared config.
  if (upstreamStartPoint) {
    const upstream = upstreamStartPoint
    await withUpstreamConfigLock(projectSlug, async () => {
      await sessionExec(jobName, buildUpstreamExec(upstream))
    })
  }

  // Nested sessions: the postStart hook started the rootful in-pod engine
  // in the background (yaac-session-init, which also writes the
  // virtualCluster registries.conf drop-in from YAAC_REGISTRY_CONF_B64).
  // Gate on `docker version` here so a broken engine fails the create with
  // a clear error instead of a confusing "cannot connect to docker" the
  // first time the agent runs.
  if (nested) {
    emit('Waiting for the in-pod container engine...', options)
    const deadline = Date.now() + 60_000
    for (;;) {
      try {
        await sessionExec(jobName, 'docker version', { maxAttempts: 1, timeout: 10_000 })
        break
      } catch (err) {
        if (Date.now() > deadline) {
          throw new Error(
            'in-pod podman did not become ready within 60s — check '
            + `/tmp/podman-service.log and /tmp/yaac-engine-setup.log in session ${sessionId} `
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
  const agentCmd = buildAgentCmd(tool, sessionId, options.resume === true, piProvider, options.model)
  const toolLabel =
    tool === 'codex' ? 'Codex' :
    tool === 'opencode' ? 'OpenCode' :
    tool === 'pi' ? 'Pi' :
    'Claude Code'
  emit(`Starting ${toolLabel}...`, options)
  await sessionExec(jobName, buildWindowsExec(initWindows, tool, agentCmd))

  if (options.initialPrompt !== undefined) {
    emit('Sending initial prompt...', options)
    await typeInitialPrompt(jobName, tool, options.initialPrompt)
  }
}

/**
 * Server-side implementation of `/session/create`. Provisions the
 * worktree, proxy rules, kubernetes Job, and port forwarders — all
 * long-lived resources that the server owns for the session's
 * lifetime. The CLI only prompts for git identity and then attaches
 * the user's terminal to the resulting tmux session.
 */
export async function createSession(
  projectSlug: string,
  options: SessionCreateOptions,
): Promise<SessionCreateResult> {
  // Verify project exists
  try {
    await fs.access(projectDir(projectSlug))
  } catch {
    throw new ServerError('NOT_FOUND', `project ${projectSlug} not found`)
  }

  if (options.resume && !options.sessionId) {
    throw new ServerError('VALIDATION', 'resume requires a sessionId')
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
  // sessions would otherwise produce a confusing in-container 403 from the
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
  // per-session vcluster, and implies nestedContainers — the in-pod
  // podman is the session's only build engine. The config parser already
  // normalizes `virtualCluster: true` to set `nestedContainers: true`
  // (and rejects an explicit `nestedContainers: false` alongside it).
  const virtualCluster = config.virtualCluster === true
  const nestedContainers = config.nestedContainers === true || virtualCluster

  // Recursion cap: an inner yaac (running inside a vcluster session)
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

  const sessionId = options.sessionId ?? crypto.randomUUID()
  const wtDir = worktreeDir(projectSlug, sessionId)
  const jobName = sessionJobName(projectSlug, sessionId)

  // Pre-create the worktree dir so the Job's /workspace hostPath (type
  // Directory) mounts on first attempt: the Job is applied while the
  // checkout below may still be running.
  await fs.mkdir(wtDir, { recursive: true })

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
    // wtDir itself was pre-created above; a populated worktree is
    // recognized by its `.git` link file.
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
    // `git worktree add` accepts the pre-created empty dir; nothing
    // pod-side reads /workspace before startJobWithSetup joins this task.
    await addWorktree(repo, wtDir, `agent/${sessionId}`, `origin/${refBranch}`)
    return { upstreamStartPoint: `origin/${refBranch}` }
  })()
  // Joined inside startJobWithSetup (or surfaced by the retry loop); this
  // marker only keeps a failure in another leg from turning a still-running
  // worktree leg into an unhandled rejection.
  worktreeTask.catch(() => { /* awaited later */ })

  const clusterTask = (async () => {
    // A nested server defers its boot-time cluster attach so it doesn't
    // wake its own born-at-zero vcluster; the first session create is the
    // "cluster is really needed now" signal. Awaited so the namespace
    // ensure inside it lands before anything below applies into it.
    // Immediate no-op on the outer server (nothing is ever armed).
    await awaitDeferredClusterBoot()

    // Proxy is always required — it reads the host-mounted credentials dir
    // directly and injects GitHub / Claude / Codex tokens into outbound HTTPS
    // requests. Credential updates via `yaac auth update` propagate to every
    // running session without needing to restart pods.
    emit('Ensuring proxy deployment...', options)
    await proxyClient.ensureRunning()

    // virtualCluster sessions get a per-project push registry — the image
    // source for vcluster synced pods and yaac-in-yaac — plus their own
    // virtual cluster. The pod reaches both on their in-cluster ClusterIPs,
    // which it resolves through the proxy's split-horizon DNS (`*.svc` →
    // cluster CoreDNS), so no pinned VIP or hostAliases is needed; the
    // per-project/per-session NetworkPolicies these ensures apply admit the
    // flows, scoped to the session's own registry and vcluster.
    // The vcluster is created here so its cold start overlaps the image,
    // worktree, and fs-prep legs; the kubeconfig is awaited at the end of
    // this leg, just before the mounts are assembled.
    let vclusterFreshlyCreated = false
    if (virtualCluster) {
      emit('Ensuring project registry...', options)
      await ensureProjectRegistry(projectSlug)

      // The wake activator that serves this (and every) vcluster's
      // scale-to-zero — before the vcluster so its pod IP is available to
      // the sleep step below. Runs the proxy image the ensureRunning()
      // above just built and pushed.
      emit('Ensuring vcluster activator...', options)
      await ensureActivator()

      emit('Creating virtual cluster...', options)
      await ensureVclusterImages()
      const { freshlyCreated } = await ensureSessionVcluster({
        sessionId,
        allowedHostPathPrefix: nestedYaacDataDir(projectSlug, sessionId),
        onProgress: (m) => emit(m, options),
      })
      vclusterFreshlyCreated = freshlyCreated
    }

    // Egress: the session pod's outbound 443/80 is redirected to the proxy at
    // the node level by netd's per-pod DNAT rules (k8s/netd)
    // — no per-pod sidecar. The pod also points its resolver at the proxy
    // (DNS stub) and dials the SSH tunnel sentinel; both are admitted by the
    // same session NetworkPolicy. The proxy identifies the session by the source pod IP
    // it watches, so nothing per-session needs injecting here.
    //
    // The proxy Service ClusterIP is allocator-assigned (no longer pinned) — for
    // both the outer and the vcluster-allocated inner proxy — so read it live.
    // Stable for the cluster's lifetime: the Service is never deleted/recreated.
    const proxyHost = await proxyServiceClusterIp()

    // streamd auth: the per-session token its handshake requires, derived
    // from the install's proxy secret (no new storage — survives server
    // restarts). Leaking it grants nothing: the ingress lock means only the
    // proxy reaches streamd, and the token only opens the pod's OWN daemon.
    const streamToken = await sessionStreamToken(sessionId)

    // Register this session's state (envSecretProxy rules, allowlist, repo
    // URL) with the proxy. GitHub / Claude / Codex auth is handled
    // dynamically by the proxy from the mounted credentials dir — no per-
    // session rule is needed for those. envSecretProxy rules reference
    // their values by name; the values land in the proxy-secrets
    // credentials file first so the registration's secretRefs resolve from
    // the proxy's first request onward. The same builder backs the
    // reconciler's resync backstop.
    await syncProxySecrets(config)
    await proxyClient.registerSession(
      sessionId,
      buildSessionRegistration({ config, remoteUrl, tool, projectSlug }),
    )

    // vcluster kubeconfig: wait for the syncer to publish it (the cold
    // start has been running since the ensure above), write it under the
    // session dir, and dir-mount it at ~/.kube. Speaks to the pinned
    // VIP:8443 (IP SAN) — no DNS involved.
    const vclusterMounts: HostPathMount[] = []
    const vclusterEnv: string[] = []
    if (virtualCluster) {
      emit('Waiting for the virtual cluster API...', options)
      const kubeconfig = await waitForVclusterKubeconfig(vclusterName(sessionId))
      const vcDir = sessionVclusterDir(projectSlug, sessionId)
      await fs.mkdir(vcDir, { recursive: true })
      await fs.writeFile(path.join(vcDir, 'config'), kubeconfig, { mode: 0o600 })
      vclusterMounts.push({ hostPath: vcDir, mountPath: '/home/yaac/.kube' })
      vclusterEnv.push('KUBECONFIG=/home/yaac/.kube/config')

      // Born-at-zero: with the kubeconfig captured, the freshly-booted
      // (never used) control plane is scaled to 0 — the activator wakes it
      // on the session's first API touch. Only a vcluster THIS create
      // booted may be slept: re-sleeping an existing one would discard its
      // state.db. Best-effort — a failed sleep just leaves the vcluster
      // running (the pre-scale-to-zero behavior).
      if (vclusterFreshlyCreated) {
        emit('Scaling idle virtual cluster to zero...', options)
        try {
          await sleepVcluster(vclusterName(sessionId), sessionId)
        } catch (err) {
          console.warn(`vcluster sleep (${sessionId}): ${(err as Error).message}`)
        }
      }

      // yaac-in-yaac preset: the nested data dir is mounted at the
      // IDENTICAL absolute path in the pod, because inner synced-pod
      // hostPaths resolve on the NODE (which sees the host path via the
      // kind $HOME extraMount). It is also the VAP guard's only allowed
      // hostPath prefix for this session's synced pods. The registry env
      // points the inner server's pushes at the project's registry
      // (resolvable in-pod via the proxy's split-horizon DNS, on the node via
      // hosts.toml) — no repo-path prefix, that registry is already scoped.
      const nestedDataDir = nestedYaacDataDir(projectSlug, sessionId)
      await fs.mkdir(nestedDataDir, { recursive: true })
      vclusterMounts.push({ hostPath: nestedDataDir, mountPath: nestedDataDir })
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
    const opencodeData = opencodeDataDir(projectSlug, sessionId)
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
    // agent/sessions subdir under it on first run.
    await fs.mkdir(pi, { recursive: true })
    await fs.mkdir(cachedPackages, { recursive: true })

    // SSH provisioning: when the project's remote is SSH, expose the proxy's
    // ssh-agent into the pod (no private key inside the container) and
    // configure git's SSH transport to (a) use the agent for identity, (b)
    // verify with our project-scoped known_hosts, (c) tunnel through the MITM
    // proxy via HTTP CONNECT so the allowlist still applies.
    const sshMounts: HostPathMount[] = []
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
      sshMounts.push(
        { hostPath: sshAgentHostDir(), mountPath: SSH_AGENT_MOUNT, type: 'DirectoryOrCreate' },
        { hostPath: knownHostsFile, mountPath: containerKnownHosts, readOnly: true, type: 'File' },
      )
      // ncat speaks CONNECT to a sentinel address that netd redirects
      // through the node Envoy to the proxy's tunnel listener — the same path
      // as HTTP(S). CONNECT carries the real host:port (so the allowlist sees
      // the hostname; a raw port-22 redirect would lose it), and Envoy stamps
      // the source pod IP, so identity is uniform (no x:<sessionId> in env).
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
    // host OAuth bundles. Picks up expiresAt changes since the last session.
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
    // these flags the user is forced to log in inside every session.
    await seedClaudeJson(claudeJson)
    await seedClaudeSettings(path.join(claude, 'settings.json'))

    // Codex: pre-create the transcript symlink dir (host-side readers like the
    // deleted-session list and restart expect it to exist). The SessionStart
    // hook that populates it — symlinking each session's rollout JSONL into
    // .yaac-transcripts/<YAAC_SESSION_ID>.jsonl — now ships as a Codex managed
    // hook baked into the image at /etc/codex (dockerfiles/Dockerfile.tools),
    // which Codex trusts by policy, so nothing is seeded into the mounted codex
    // dir. For projects predating the managed hook, strip the stale user-layer
    // hook so it stops triggering Codex's /hooks trust-approval prompt.
    await fs.mkdir(codexTranscriptDir(projectSlug), { recursive: true })
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

    // Per-session host dir holding the tmux server socket and pane log.
    const tmuxHostDir = sessionTmuxDir(projectSlug, sessionId)
    await fs.mkdir(tmuxHostDir, { recursive: true })

    const ephemeralMounts = await prepareEphemeralMounts(
      cachedPackages,
      sessionId,
      resolveEphemeralModulesPaths(config),
    )

    // yaac's own bundled skills: stage a fresh copy under the session dir and
    // mount them read-only into every tool's personal skills root below. Copied
    // per session so they track the installed yaac version, and never written
    // into the persisted per-project config dirs (no staleness). Removed with the
    // session dir on cleanup.
    const builtinSkillsStaging = path.join(sessionDir(projectSlug, sessionId), 'builtin-skills')
    const builtinSkillNames = await stageBuiltinSkills(builtinSkillsDir(), builtinSkillsStaging)

    // In-session helper commands (yaac-spawn, and the yaac-session-init
    // postStart hook): staged like the builtin skills and File-mounted
    // read-only onto /usr/local/bin in the pod.
    const sessionBinStaging = path.join(sessionDir(projectSlug, sessionId), 'bin')
    const sessionBinNames = await stageSessionBin(sessionBinDir(), sessionBinStaging)
    // The postStart hook is mandatory — without it the pod boots with no
    // git identity, tmux server, or streamd. The other session-bin scripts
    // are optional helpers; this one missing means a broken install.
    if (!sessionBinNames.includes(SESSION_INIT_SCRIPT)) {
      throw new ServerError(
        'INTERNAL',
        `session-bin staging is missing ${SESSION_INIT_SCRIPT} — broken yaac install?`,
      )
    }
    if (builtinSkillNames.length > 0) {
      // Pre-create each tool's personal skills root (server-owned) before the
      // pod mounts a skill at `<root>/<name>`. Otherwise the kubelet creates the
      // intervening `skills/` dir as root:root to host the nested mount, which
      // would block the non-root agent from adding its own personal skills there.
      // Only the per-skill leaf mountpoints stay kubelet-owned (empty, and
      // skipped by discovery, so no stale skill ever surfaces). Best-effort: a
      // skills-dir permission hiccup must never fail session creation — the skill
      // still mounts; at worst the agent can't add same-root personal skills.
      await Promise.allSettled([
        fs.mkdir(path.join(claude, 'skills'), { recursive: true }),
        fs.mkdir(path.join(codex, 'skills'), { recursive: true }),
        fs.mkdir(path.join(opencodeConfig, 'skills'), { recursive: true }),
        fs.mkdir(path.join(pi, 'agent', 'skills'), { recursive: true }),
      ])
    }

    return {
      toolAuthByTool, sshMounts, sshEnv, cacheVolumeEntries, ephemeralMounts,
      builtinSkillsStaging, builtinSkillNames, sessionBinStaging, sessionBinNames,
      claude, claudeJson, codex, opencodeData, opencodeConfig, pi,
      cachedPackages, tmuxHostDir,
    }
  })()

  const [imageRef, cluster, prep] = await Promise.all([imageTask, clusterTask, prepTask])
  const {
    toolAuthByTool, sshMounts, sshEnv, cacheVolumeEntries, ephemeralMounts,
    builtinSkillsStaging, builtinSkillNames, sessionBinStaging, sessionBinNames,
    claude, claudeJson, codex, opencodeData, opencodeConfig, pi,
    cachedPackages, tmuxHostDir,
  } = prep

  // Build container env. Unlike the podman create API (whose Env field
  // replaced the image ENV wholesale), kubernetes env vars overlay the
  // image's — so no image-inspect merge step is needed.
  const env: string[] = []

  // YAAC session ID — used by the Codex SessionStart hook to record the transcript path
  env.push(`YAAC_SESSION_ID=${sessionId}`)

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
  // the ssh mounts in the fs-prep leg.
  env.push(...sshEnv)

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
  // time. The vars are only sentinels: the proxy swaps placeholders solely
  // for the session's *registered* tool (updated on retool), so carrying
  // another tool's placeholder grants no access to its credential.
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
    const info = opencodeProviderInfo(toolAuthByTool.opencode.opencodeProvider ?? OPENCODE_DEFAULT_PROVIDER)
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
    const info = piProviderInfo(toolAuthByTool.pi.piProvider ?? PI_DEFAULT_PROVIDER)
    env.push(`${info.envVar}=${PLACEHOLDER_API_KEY}`)
  }
  // Codex OAuth: Codex reads the placeholder bundle from the mounted
  // .codex/auth.json. Setting OPENAI_API_KEY would risk steering Codex
  // into api-key mode instead of ChatGPT OAuth.

  // GitHub CLI (`gh`) auth: when the project's remote is an HTTPS GitHub repo,
  // hand `gh` a placeholder GH_TOKEN so it treats itself as logged in. The
  // proxy swaps the placeholder for the session's real HTTPS git token on
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
  // headless session tmux never answers, so no frame is ever drawn. The image
  // pins opencode-ai@1.0.142 (dockerfiles/Dockerfile.tools); without this the
  // pod would silently upgrade back to a broken renderer (and hit the egress
  // proxy doing it). Set unconditionally (only opencode reads it) so a spare
  // retooled to opencode gets it.
  env.push('OPENCODE_DISABLE_AUTOUPDATE=1')

  // Point pi at its session-log dir inside the mounted `.pi` home so its JSONL
  // transcripts are readable on the host (first-message / status). pi resumes
  // by `--session-id` (buildAgentCmd), so the shared home holding every
  // session's logs is fine. Skip pi's startup version check so a fresh pod
  // doesn't stall on a network probe. Set unconditionally (only pi reads them)
  // so a spare retooled to pi gets them.
  env.push(`PI_CODING_AGENT_SESSION_DIR=${PI_SESSIONS_CONTAINER_DIR}`)
  env.push('PI_SKIP_VERSION_CHECK=1')

  // Port forwarding: reserve host ports in the server process so no
  // other process can claim them between discovery and the forwarder
  // starting up. The server owns the forwarders for the session's
  // lifetime; they are torn down by `deleteSession` and the stale-
  // session reaper.
  const forwardedPorts: ReservedPort[] = []
  if (config.portForward?.length) {
    for (const { containerPort, hostPortStart } of config.portForward) {
      emit(`Finding available host port starting from ${hostPortStart} for container port ${containerPort}...`, options)
      const reserved = await reserveAvailablePort(containerPort, hostPortStart)
      forwardedPorts.push(reserved)
      emit(`Forwarding host port ${reserved.hostPort} -> container port ${containerPort}`, options)
    }
  }

  // Inputs for the postStart setup script (yaac-session-init): git
  // identity, the initial agent window name, the tmux status line (embeds
  // the host ports reserved just above), and the nested-engine switches.
  env.push(`YAAC_TOOL=${tool}`)
  env.push(`YAAC_GIT_NAME=${gitUser.name}`)
  env.push(`YAAC_GIT_EMAIL=${gitUser.email}`)
  env.push(`YAAC_STATUS_RIGHT=${buildStatusRight(projectSlug, sessionId, forwardedPorts)}`)
  if (nestedContainers) {
    env.push('YAAC_NESTED_ENGINE=1')
    if (virtualCluster) {
      // The per-project registries.conf drop-in, written by the script
      // (sudo) before the engine starts. Base64 keeps the TOML free of
      // env-value quoting concerns.
      const conf = Buffer.from(projectRegistryConfDropIn(projectSlug), 'utf8').toString('base64')
      env.push(`YAAC_REGISTRY_CONF_B64=${conf}`)
    }
  }

  // vcluster wiring (KUBECONFIG, nested data dir, registry host) resolved
  // in the cluster leg.
  env.push(...cluster.vclusterEnv)

  // Nested-containers pod wiring: shared image store hostPath (node-local)
  // + graphroot/securityContext branch in the manifest.
  const nested: NestedContainersParams | undefined = nestedContainers
    ? { sharedImagesHostPath: sharedImageStoreHostPath(projectSlug) }
    : undefined

  // Inside a nested (inner) yaac no runtimeClassName is stamped — the
  // vcluster has no RuntimeClass objects, and the syncer sets the synced
  // pod's host runtime. Host pods get gvisor (pod-spec maps nested to the
  // gvisor-nested handler).
  const innerYaac = yaacEnv.nested

  const hostPathMounts: HostPathMount[] = [
    { hostPath: wtDir, mountPath: '/workspace' },
    { hostPath: `${repo}/.git`, mountPath: '/repo/.git' },
    { hostPath: claude, mountPath: '/home/yaac/.claude' },
    { hostPath: claudeJson, mountPath: '/home/yaac/.claude.json', type: 'File' },
    { hostPath: codex, mountPath: '/home/yaac/.codex' },
    { hostPath: opencodeData, mountPath: '/home/yaac/.local/share/opencode' },
    { hostPath: opencodeConfig, mountPath: '/home/yaac/.config/opencode' },
    { hostPath: pi, mountPath: PI_CONTAINER_HOME },
    { hostPath: cachedPackages, mountPath: '/home/yaac/.cached-packages' },
    { hostPath: tmuxHostDir, mountPath: CONTAINER_TMUX_DIR },
    ...cacheVolumeEntries.map(([key, containerPath]): HostPathMount => ({
      hostPath: cacheVolumeDir(projectSlug, key),
      mountPath: containerPath,
    })),
    // User bindMounts may point at files or directories — omit `type` so
    // the kubelet mounts whatever exists.
    ...(config.bindMounts ?? []).map(({ hostPath, containerPath, mode }): HostPathMount => ({
      hostPath,
      mountPath: containerPath,
      readOnly: mode === 'ro',
      type: '',
    })),
    ...ephemeralMounts.map((m): HostPathMount => ({
      hostPath: m.hostBacking,
      mountPath: m.containerPath,
    })),
    ...builtinSkillMounts(builtinSkillsStaging, builtinSkillNames),
    ...sessionBinMounts(sessionBinStaging, sessionBinNames),
    ...cluster.vclusterMounts,
    ...sshMounts,
  ]

  // Retry the entire Job create + setup so that if the pod dies
  // immediately after creation we start fresh instead of futilely retrying
  // individual exec calls against a dead pod.
  const maxStartAttempts = 3
  const setupParams: SessionSetupParams = {
    imageRef, jobName, projectSlug, sessionId, env, hostPathMounts,
    proxyHost: cluster.proxyHost, nested, innerYaac, tool, initWindows,
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
      // listActiveSessions as a bogus waiting session. Foreground cascade
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
      throw err instanceof SetupInputError ? err.inner : err
    }
  }

  // Pod is up — hand the reserved sockets off to long-lived forwarders
  // owned by the server. These stay alive across user attaches/detaches
  // and are torn down only by delete or the reaper.
  if (forwardedPorts.length > 0) {
    const stop = startPortForwarders(relayTcpFactory(sessionId), forwardedPorts)
    registerSessionForwarders(sessionId, stop, forwardedPorts)
  }

  return {
    sessionId,
    jobName,
    forwardedPorts: forwardedPorts.map(({ containerPort, hostPort }) => ({ containerPort, hostPort })),
    tool,
  }
}
