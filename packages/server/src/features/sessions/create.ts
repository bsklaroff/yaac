import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import simpleGit from 'simple-git'
import { ensureContainerRuntime } from '#platform/container/runtime'
import { ensureImage, pushImageShared } from '#features/images/build-coordinator'
import { sharedImageStoreHostPath } from '#features/images/image-promoter'
import {
  proxyClient,
  PROXY_CA_BUNDLE_PATH,
  SSH_AGENT_MOUNT,
  SSH_AGENT_SOCKET_PATH,
} from '#features/sessions/egress/proxy-client'
import { buildSessionRegistration, syncProxySecrets } from '#features/sessions/egress/proxy-registration'
import { resolveAllowedHosts } from '#features/sessions/egress/default-allowed-hosts'
import { reserveAvailablePort, startPortForwarders, kubectlRelay } from '#platform/container/port'
import type { ReservedPort } from '#platform/container/port'
import { containerExec } from '#platform/k8s/exec'
import { createKeyedMutex } from '#platform/keyed-mutex'
import { dataDirHash, k8sNamespace, kubectlApply, kubectlGetJson, kubectlWithRetry } from '#platform/k8s/kubectl'
// Aliased: this module uses a local `env: string[]` for the pod's env vars.
import { env as yaacEnv, testEnv } from '@yaac/shared/env'
import {
  JOB_NAME_LABEL,
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
  vclusterName,
  waitForVclusterKubeconfig,
} from '#features/cluster/vcluster'
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
  worktreesDir,
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
import { ensureCodexHooksJson, ensureCodexConfigToml } from '#features/sessions/agents/codex'
import { ensureOpencodeConfigJson } from '#features/sessions/agents/opencode'
import {
  shellEscape,
  TMUX,
  resolveInitWindows,
  initWindowCommand,
  buildAgentCmd,
  typeInitialPrompt,
} from '#features/sessions/agent-command'
import { seedClaudeJson, seedClaudeSettings, prepareEphemeralMounts } from '#features/sessions/seed'
import { builtinSkillsDir, stageBuiltinSkills, builtinSkillMounts } from '#features/skills/builtin'
import { sessionBinDir, stageSessionBin, sessionBinMounts } from '#features/sessions/spawn-script'
import { ServerError } from '@yaac/shared/errors'
import {
  buildStatusRight,
  registerSessionForwarders,
} from '#features/sessions/forwarders/port-forwarders'
import { AGENT_TOOLS } from '@yaac/shared/types'
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
  /** Set for virtualCluster sessions — the per-project push registry. */
  virtualCluster?: boolean
  tool: AgentTool
  /** pi only — provider whose default model drives `pi --model`. */
  piProvider?: PiProvider
  config: YaacConfig
  options: SessionCreateOptions
  gitUser: { name: string; email: string }
  forwardedPorts: ReservedPort[]
  /**
   * `origin/<defaultBranch>` when the worktree was freshly created —
   * `startJobWithSetup` then sets the session branch's upstream from
   * inside the pod. Unset when resuming onto an existing worktree, whose
   * upstream is left untouched.
   */
  upstreamStartPoint?: string
}

/** Poll until the session pod is Ready, failing fast on terminal states. */
async function waitForPodReady(jobName: string, timeoutMs = 180_000): Promise<void> {
  interface RawPods {
    items: Array<{
      status?: {
        phase?: string
        containerStatuses?: Array<{
          ready?: boolean
          state?: { waiting?: { reason?: string; message?: string } }
        }>
      }
    }>
  }
  const deadline = Date.now() + timeoutMs
  let lastDetail = 'pod not created yet'
  while (Date.now() < deadline) {
    const list = await kubectlGetJson<RawPods>([
      'get', 'pods', '-n', k8sNamespace(), '-l', `${JOB_NAME_LABEL}=${jobName}`,
    ])
    const pod = list?.items[0]
    if (pod) {
      const phase = pod.status?.phase ?? 'Unknown'
      // containerStatuses[0] is the session container (egress is redirected
      // at the cluster level now, so there is no per-pod sidecar to gate on).
      const cs = pod.status?.containerStatuses?.[0]
      if (cs?.ready) return
      if (phase === 'Failed' || phase === 'Succeeded') {
        throw new Error(`session pod for ${jobName} reached terminal phase ${phase}`)
      }
      const waiting = cs?.state?.waiting
      lastDetail = waiting?.reason
        ? `${waiting.reason}${waiting.message ? `: ${waiting.message}` : ''}`
        : `phase ${phase}`
      // Image-pull failures never self-heal for content-hash tags — the
      // bytes are either in the registry or they aren't. Fail fast with
      // the reason instead of burning the whole timeout.
      if (waiting?.reason === 'ErrImagePull' || waiting?.reason === 'ImagePullBackOff') {
        throw new Error(`session pod for ${jobName} cannot pull its image (${lastDetail})`)
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`session pod for ${jobName} not ready after ${timeoutMs}ms (${lastDetail})`)
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
    proxyHost, nested, innerYaac, virtualCluster, tool, piProvider, config,
    options, gitUser, forwardedPorts, upstreamStartPoint,
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
  })
  await kubectlApply(manifest)
  await waitForPodReady(jobName)

  // No ownership fixup is needed for server-created hostPath mounts: the
  // image's yaac user is built with the server's uid (YAAC_UID build arg,
  // see sessionUid in image-builder). Under gVisor there is no userns and no
  // idmapped mount, so numeric uids pass through raw — server-owned dirs are
  // yaac-writable as-is.

  // Fix worktree git pointers for in-container paths
  await containerExec(jobName, `sh -c "echo 'gitdir: /repo/.git/worktrees/${sessionId}' > /workspace/.git"`)
  await containerExec(jobName, `sh -c "echo '/workspace/.git' > /repo/.git/worktrees/${sessionId}/gitdir"`)

  // Lock the worktree so `git worktree prune` can never reap it. Every
  // session worktree's gitdir points at /workspace — valid only inside its
  // own pod — so from the host, or any other pod sharing this /repo mount,
  // it looks "prunable". A single prune (explicit, or one mis-firing under
  // FD/PID exhaustion — gc does not prune worktrees) would otherwise wipe
  // every session's admin dir at once, breaking git in all live sessions.
  // The lock file is checked before the prunable test, so prune skips it.
  // Worktrees are never `git worktree remove`d (teardown rm -rf's the dirs),
  // so the lock needs no clearing; admin dirs accumulating under
  // /repo/.git/worktrees is acceptable (the pivotal repo already has 500+).
  await containerExec(jobName, `sh -c "printf 'yaac session ${sessionId}' > /repo/.git/worktrees/${sessionId}/locked"`)

  // Configure git identity and trust mounted directories inside container
  await containerExec(jobName, `git config --global user.name '${shellEscape(gitUser.name)}'`)
  await containerExec(jobName, `git config --global user.email '${shellEscape(gitUser.email)}'`)
  await containerExec(jobName, 'git config --global --add safe.directory /workspace')
  await containerExec(jobName, 'git config --global --add safe.directory /repo')

  // Set the session branch's upstream from INSIDE the pod, not on the host
  // at worktree-add time. A host-side rewrite of the shared
  // /repo/.git/config replaces the file's inode underneath the VM-kernel
  // virtiofs cache that every session pod reads through, and any in-pod
  // git command racing the stale window dies with "fatal: unknown error
  // occurred while reading the configuration files" until the cache
  // expires (see addWorktree). A write from inside a pod goes through that
  // same shared cache, so every pod — and the host, which reads the real
  // filesystem — observes it coherently.
  if (upstreamStartPoint) {
    await withUpstreamConfigLock(projectSlug, async () => {
      await containerExec(jobName, `git -C /workspace branch --set-upstream-to '${shellEscape(upstreamStartPoint)}'`)
    })
  }

  // Start the agent tool in a tmux session
  const agentCmd = buildAgentCmd(tool, sessionId, options.resume === true, piProvider, options.model)
  const toolLabel =
    tool === 'codex' ? 'Codex' :
    tool === 'opencode' ? 'OpenCode' :
    tool === 'pi' ? 'Pi' :
    'Claude Code'
  emit(`Starting ${toolLabel}...`, options)
  // Open the tmux session with a placeholder keepalive (`sleep infinity`)
  // instead of the agent directly. If we launched the agent here, a
  // fast-failing process — common under heavy test-suite load — would
  // end the session before the set-option calls below could reach it,
  // and every subsequent `tmux ...` exec would fail with "no such
  // session: yaac" or "no server running" and burn the 120s hook
  // timeout. Once the tmux config below is in place, we respawn-window
  // to swap the keepalive for the real agent. The placeholder never
  // reaches the user — they attach after setup completes.
  //
  // `-x`/`-y` set generous initial dimensions so the respawned agent
  // inherits a window larger than any realistic terminal. On attach,
  // tmux shrinks the window to fit the client — shrink-then-render is
  // reliable for TUI apps. Without this, the session is created at
  // tmux's default 80x24 and a race against the agent's startup render
  // can leave Claude stuck at 80x24 until the user resizes the host
  // terminal to force a fresh SIGWINCH.
  //
  // `env COLORTERM=truecolor` seeds the tmux *server* environment (the
  // server forks from this first client), which every pane on it inherits —
  // the agent, init windows, and scratch shells. TUIs decide whether to
  // emit 24-bit color from COLORTERM in their own environment; without it
  // they see only TERM=tmux-256color and quantize their themes to the
  // 256-color palette before the RGB passthrough configured below can
  // help. (opencode was the visible casualty: its truecolor theme banded
  // badly in the webapp's xterm.js pane.)
  await containerExec(jobName, `env COLORTERM=truecolor ${TMUX} -u new-session -d -s yaac -n ${tool} -x 500 -y 200 'sleep infinity'`)

  // Nested sessions: start the in-pod ROOTFUL podman engine (it serves the
  // Docker Engine API on the socket DOCKER_HOST points at). The engine runs
  // as real root inside the sentry — `sudo podman system service` — and the
  // socket it creates under root-owned /run/podman is opened to the yaac
  // user (who runs the agent + docker CLI). Backgrounded with all
  // fds redirected to a log file — kubectl exec has no `-d`, so the exec
  // stream closes and `containerExec` returns while the service keeps
  // running, reparented to the container's catatonit init. Then gate on
  // `docker version` so a broken engine fails here with a clear error
  // instead of a confusing "cannot connect to docker" the first time the
  // agent runs.
  if (nested) {
    // virtualCluster sessions: drop a registries.conf.d entry marking the
    // per-project registry (plain HTTP on :5000) insecure, so user-driven
    // `docker push` works without --tls-verify gymnastics. Written before
    // the engine starts; per-project host, so it can't live in the shared
    // nestable image layer. The single quotes around the printf args are
    // safe: the drop-in contains double quotes only.
    if (virtualCluster) {
      // Rootful engine reads /etc/containers/registries.conf.d — sudo to
      // write there (per-project host, so it can't live in the shared image
      // layer). The single quotes around the printf args are safe: the
      // drop-in contains double quotes only.
      const confDir = '/etc/containers/registries.conf.d'
      const lines = projectRegistryConfDropIn(projectSlug)
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => `'${l.replace(/"/g, '\\"')}'`)
        .join(' ')
      await containerExec(
        jobName,
        `sudo sh -c "mkdir -p ${confDir} && printf '%s\\n' ${lines} > ${confDir}/yaac-project-registry.conf"`,
      )
    }
    // Start the rootful engine (as root, via the image's passwordless
    // sudo), wait for its socket, and hand it to the yaac user — one exec:
    // /run/podman is created root:0700, so make it traversable and give
    // the socket to yaac. On timeout the script exits 1 with the engine
    // log tail, so a dead-on-arrival engine surfaces its real error here
    // instead of a bare chown failure.
    //
    // SSL_CERT_FILE must be set INSIDE the sudo'd shell: the engine (a Go
    // binary) trusts the MITM proxy CA for registry pulls via this var,
    // but sudo's env_reset strips the pod env. It points at the combined
    // bundle ({public roots} ∪ {proxy CA}) so both MITM'd and tunnelled
    // registries verify. Nested containers + build RUN steps get their own
    // CA trust from /etc/containers/containers.conf, independent of this.
    //
    // BUILDAH_ISOLATION=chroot: under buildah's default oci isolation the
    // sentry breaks the RUN-step stdio relay after a few tens of KB of
    // output — the step's writes hit EPIPE and chatty commands (apt-get)
    // die with their own error codes while quiet builds pass (why the
    // e2e never caught it). chroot isolation streams fine, keeps RUN on
    // the pod netns, and holds setcap file caps on the tmpfs graphroot
    // (all verified in-pod). Remote builds resolve isolation SERVER-side,
    // so the service env covers every client: an inner yaac's podman,
    // user `docker build`, and compose --build.
    await containerExec(
      jobName,
      'sudo -n sh -c \''
      + `export SSL_CERT_FILE=${PROXY_CA_BUNDLE_PATH} BUILDAH_ISOLATION=chroot; `
      // `&` terminates the background command — no `;` may follow it.
      + 'podman system service --time=0 >/tmp/podman-service.log 2>&1 & i=0; '
      + 'while [ $i -lt 120 ] && ! [ -S /run/podman/podman.sock ]; do i=$((i+1)); sleep 0.5; done; '
      + 'if ! [ -S /run/podman/podman.sock ]; then'
      + ' echo "yaac: in-pod podman engine did not create /run/podman/podman.sock within 60s; engine log tail:" >&2;'
      + ' tail -n 20 /tmp/podman-service.log >&2 || true; exit 1; fi; '
      + 'chmod 0755 /run/podman && chown yaac /run/podman/podman.sock\'',
      { maxAttempts: 1, timeout: 90_000 },
    )
    emit('Waiting for the in-pod container engine...', options)
    const deadline = Date.now() + 60_000
    for (;;) {
      try {
        await containerExec(jobName, 'docker version', { maxAttempts: 1, timeout: 10_000 })
        break
      } catch (err) {
        if (Date.now() > deadline) {
          throw new Error(
            'in-pod podman did not become ready within 60s — check '
            + `/tmp/podman-service.log in session ${sessionId} `
            + `(${(err as Error).message})`,
          )
        }
        await new Promise((r) => setTimeout(r, 500))
      }
    }
  }

  // Run init commands in background tmux windows (parallel to the agent).
  // One window per InitWindow — string-form configs collapse to a single
  // `init` window, object-form configs get one window per entry so a
  // backend and frontend can run side by side.
  for (const win of resolveInitWindows(config)) {
    // Reject every tool name, not just the active tool's: a prewarmed spare
    // can be retooled at claim time, which renames the agent window to the
    // requested tool — an init window with that name would make the tmux
    // target ambiguous.
    if ((AGENT_TOOLS as readonly string[]).includes(win.name)) {
      throw new ServerError(
        'VALIDATION',
        `initCommands window name "${win.name}" collides with an agent tool window`,
      )
    }
    await containerExec(jobName, initWindowCommand(win))
  }

  // Configure tmux UX. All options are chained with `\;` into ONE tmux
  // invocation (tmux command sequences, same trick as the PTY bridge's view
  // options) so session create pays one kubectl exec round-trip, not twelve.
  const statusRight = buildStatusRight(projectSlug, sessionId, forwardedPorts)
  const tmuxSetup = [
    'set-option -g history-limit 200000',
    'set-option -g mouse on',
    'set-option -g focus-events on',
    // Propagate terminal bells (\a) from any window through to the attached
    // client so the user's terminal emulator can surface notifications.
    'set-option -g monitor-bell on',
    'set-option -g bell-action any',
    'set-option -g visual-bell off',
    'set-option -g allow-passthrough on',
    // Forward CSI-u "extended keys" to any pane app that opts in. The `on`
    // mode negotiates per-app (a shell, or an agent that never requests them,
    // is unaffected), so this can't regress classic key encoding. Agent TUIs
    // use it to tell modified Enter (Shift/Ctrl+Enter) apart from a plain
    // newline; pi prints a startup warning when it finds this off. Server-
    // global, so it survives the claim-time respawn and every view session.
    // (Silences pi's warning and enables the native-CLI path; the webapp pane
    // needs extra xterm.js + terminal-features work to actually carry them.)
    'set-option -g extended-keys on',
    // Advertise 24-bit (truecolor) support so tmux forwards RGB escape
    // sequences to the attached terminal — the embedded xterm.js pane and the
    // CLI's host emulator are both truecolor-capable — instead of quantizing
    // them down to the 256-color palette. The quantization is what made
    // `git diff` unreadable: delta (and other tools) emit subtle 24-bit diff
    // backgrounds, and squashing them onto the nearest 256 cube color turns
    // them into saturated blocks that swallow dim syntax tokens like comments.
    // The `*` glob in the value must stay single-quoted so the host shell in
    // containerExec doesn't expand it.
    'set-option -g default-terminal tmux-256color',
    "set-option -as terminal-features ',*:RGB'",
    'set-option -t yaac status-right-length 80',
    `set-option -t yaac status-right '${shellEscape(statusRight)}'`,
    // C-b k kills the whole tmux server (every window, shell, and the agent —
    // the session is then reaped as a zombie). Guard it with a confirm: a
    // stray prefix+k in any attached terminal (CLI or a webapp pane) was a
    // one-keystroke session killer. Kept last: the `\;` separator ends
    // bind-key's command arguments.
    `bind-key k confirm-before -p 'kill this yaac session? (y/n)' kill-server`,
  ]
  await containerExec(jobName, `${TMUX} ${tmuxSetup.join(' \\; ')}`)

  // Now that the window's tmux options are settled, replace the keepalive
  // `sleep infinity` with the real agent. respawn-window -k kills the
  // placeholder and starts the agent in the same window, preserving the
  // tmux state we just built.
  await containerExec(jobName, `${TMUX} respawn-window -k -t yaac:${tool} '${agentCmd}'`)

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

  // Test-only: e2e fixtures pre-populate the bare repo, so skip the host-side
  // fetchOrigin (which would try to reach the real remote from the server
  // process — outside the proxy's reach).
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

  // nestedContainers shapes the image chain (nestable layer), the pod
  // spec (nested branch), the proxy allowlist (registry hosts), and the
  // in-pod engine start + readiness gate below. virtualCluster (config
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
  // lacks the infrastructure (Cilium CRDs don't sync, no kind node).
  if (virtualCluster && yaacEnv.nested) {
    throw new ServerError(
      'VALIDATION',
      'virtualCluster is not supported inside a nested yaac (no vcluster-in-vcluster).',
    )
  }

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
  const imageRef = await pushImageShared(imageName, { projectSlug, reason: 'session' })

  const sessionId = options.sessionId ?? crypto.randomUUID()
  const wtDir = worktreeDir(projectSlug, sessionId)

  // Create worktree (or reuse an existing one when resuming)
  await fs.mkdir(worktreesDir(projectSlug), { recursive: true })
  const worktreeExists = await fs.access(wtDir).then(() => true).catch(() => false)
  let upstreamStartPoint: string | undefined
  if (options.resume && worktreeExists) {
    emit(`Reusing existing worktree at ${wtDir}`, options)
  } else {
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
    await addWorktree(repo, wtDir, `agent/${sessionId}`, `origin/${refBranch}`)
    upstreamStartPoint = `origin/${refBranch}`
  }

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
  // The vcluster is created here so its cold start overlaps the
  // worktree/setup work below; the kubeconfig is awaited just before the
  // mounts are assembled.
  if (virtualCluster) {
    emit('Ensuring project registry...', options)
    await ensureProjectRegistry(projectSlug)

    emit('Creating virtual cluster...', options)
    await ensureVclusterImages()
    await ensureSessionVcluster({
      sessionId,
      allowedHostPathPrefix: nestedYaacDataDir(projectSlug, sessionId),
      onProgress: (m) => emit(m, options),
    })
  }

  // Egress: the session pod's outbound 443/80 is redirected to the proxy at
  // the cluster level by the Cilium CEC + CNP (buildEgressRedirectCecManifest)
  // — no per-pod sidecar. The pod also points its resolver at the proxy
  // (DNS stub) and dials the SSH tunnel sentinel; both are admitted by the
  // same redirect CNP. The proxy identifies the session by the source pod IP
  // it watches, so nothing per-session needs injecting here.
  //
  // The proxy Service ClusterIP is allocator-assigned (no longer pinned) — for
  // both the outer and the vcluster-allocated inner proxy — so read it live.
  // Stable for the cluster's lifetime: the Service is never deleted/recreated.
  const proxyHost = await proxyServiceClusterIp()

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

  // Load every tool's stored credential, not just the active tool's: pods
  // are provisioned tool-agnostically (a prewarmed spare can be retooled to
  // any agent at claim time), so the env placeholders and per-project
  // placeholder refreshes below cover each tool that has credentials, each
  // gated on its own credential's kind.
  const toolAuthByTool = {
    claude: await loadToolAuthEntry('claude'),
    codex: await loadToolAuthEntry('codex'),
    opencode: await loadToolAuthEntry('opencode'),
    pi: await loadToolAuthEntry('pi'),
  }

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

  // CA-trust env only — no HTTP(S)_PROXY routing vars. Interception is
  // transparent at the network layer (see redirectInit above), so the
  // container needs nothing but trust in the MITM CA.
  env.push(...proxyClient.getCaTrustEnv())

  // SSH provisioning: when the project's remote is SSH, expose the proxy's
  // ssh-agent into the pod (no private key inside the container) and
  // configure git's SSH transport to (a) use the agent for identity, (b)
  // verify with our project-scoped known_hosts, (c) tunnel through the MITM
  // proxy via HTTP CONNECT so the allowlist still applies.
  const sshMounts: HostPathMount[] = []
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
    // ncat speaks CONNECT to a sentinel address that Cilium redirects
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
    env.push(`SSH_AUTH_SOCK=${SSH_AGENT_SOCKET_PATH}`)
    env.push(`GIT_SSH_COMMAND=${gitSshCmd}`)
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

  const jobName = sessionJobName(projectSlug, sessionId)
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

  // Codex: transcript symlink dir + a SessionStart hook that symlinks the
  // transcript into a directory keyed by YAAC session ID, so yaac can read
  // it directly.
  const transcriptDir = codexTranscriptDir(projectSlug)
  await fs.mkdir(transcriptDir, { recursive: true })
  const hookScript = path.join(codex, '.yaac-hook.sh')
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
  await ensureCodexHooksJson(codex)
  await ensureCodexConfigToml(codex)

  // opencode: grant the websearch permission in the shared opencode.json so
  // the Exa-backed tool is usable (paired with OPENCODE_ENABLE_EXA above).
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

  // vcluster kubeconfig: wait for the syncer to publish it (the cold
  // start has been running since the ensure above), write it under the
  // session dir, and dir-mount it at ~/.kube. Speaks to the pinned
  // VIP:8443 (IP SAN) — no DNS involved.
  const vclusterMounts: HostPathMount[] = []
  if (virtualCluster) {
    emit('Waiting for the virtual cluster API...', options)
    const kubeconfig = await waitForVclusterKubeconfig(vclusterName(sessionId))
    const vcDir = sessionVclusterDir(projectSlug, sessionId)
    await fs.mkdir(vcDir, { recursive: true })
    await fs.writeFile(path.join(vcDir, 'config'), kubeconfig, { mode: 0o600 })
    vclusterMounts.push({ hostPath: vcDir, mountPath: '/home/yaac/.kube' })
    env.push('KUBECONFIG=/home/yaac/.kube/config')

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
    env.push(`YAAC_DATA_DIR=${nestedDataDir}`)
    env.push('YAAC_NESTED=1')
    env.push(`YAAC_K8S_REGISTRY=${projectRegistryHost(projectSlug)}`)
  }

  // yaac's own bundled skills: stage a fresh copy under the session dir and
  // mount them read-only into every tool's personal skills root below. Copied
  // per session so they track the installed yaac version, and never written
  // into the persisted per-project config dirs (no staleness). Removed with the
  // session dir on cleanup.
  const builtinSkillsStaging = path.join(sessionDir(projectSlug, sessionId), 'builtin-skills')
  const builtinSkillNames = await stageBuiltinSkills(builtinSkillsDir(), builtinSkillsStaging)

  // In-session helper commands (yaac-spawn): staged like the builtin skills
  // and File-mounted read-only onto /usr/local/bin in the pod.
  const sessionBinStaging = path.join(sessionDir(projectSlug, sessionId), 'bin')
  const sessionBinNames = await stageSessionBin(sessionBinDir(), sessionBinStaging)
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
    ...vclusterMounts,
    ...sshMounts,
  ]

  // Retry the entire Job create + setup so that if the pod dies
  // immediately after creation we start fresh instead of futilely retrying
  // individual exec calls against a dead pod.
  const maxStartAttempts = 3
  const setupParams: SessionSetupParams = {
    imageRef, jobName, projectSlug, sessionId, env, hostPathMounts,
    proxyHost, nested, innerYaac, virtualCluster, tool,
    piProvider: toolAuthByTool.pi?.piProvider,
    config, options,
    gitUser, forwardedPorts, upstreamStartPoint,
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
      // waitForPodReady matches pods by the job-name label and must not
      // see the previous attempt's terminating pod.
      try {
        await kubectlWithRetry([
          'delete', 'job', jobName, '-n', k8sNamespace(),
          '--ignore-not-found', '--cascade=foreground',
          '--wait=true', '--timeout=30s',
        ])
      } catch { /* already gone */ }
      if (attempt < maxStartAttempts) {
        emit(`Session startup failed (attempt ${attempt}/${maxStartAttempts}), retrying...`, options)
        continue
      }
      // Release any pre-bound host ports so a retry (or the reaper) can
      // rebind them.
      for (const p of forwardedPorts) p.server.close()
      throw err
    }
  }

  // Pod is up — hand the reserved sockets off to long-lived forwarders
  // owned by the server. These stay alive across user attaches/detaches
  // and are torn down only by delete or the reaper.
  if (forwardedPorts.length > 0) {
    const stop = startPortForwarders(kubectlRelay(jobName), forwardedPorts)
    registerSessionForwarders(sessionId, stop, forwardedPorts)
  }

  return {
    sessionId,
    jobName,
    forwardedPorts: forwardedPorts.map(({ containerPort, hostPort }) => ({ containerPort, hostPort })),
    tool,
  }
}
