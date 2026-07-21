import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { listSessionJobs, listSessionPods, sessionJobName } from '#platform/k8s/pods'
import { k8sNamespace, kubectlWithRetry } from '#platform/k8s/kubectl'
import { execTarget } from '#platform/k8s/exec'
import { evictOpencodeProbeCache } from '#features/sessions/agents/opencode'
import { recordSessionDeleted } from '#features/sessions/deleted-store'
import { markSessionTerminating } from '#features/sessions/state'
import { evictSessionStatus, isSessionStreamHealthy } from '#features/sessions/status-store'
import { proxyClient } from '#features/sessions/egress/proxy-client'
import { salvageSessionImages } from '#features/images/image-promoter'
import {
  buildVclusterCleanupShellCommand,
  getVclusterStatus,
  removeSessionVcluster,
  vclusterName,
} from '#features/cluster/vcluster'
import {
  cachedPackagesDir,
  projectDir,
  sessionDir,
} from '@yaac/shared/project-paths'
import { CONTAINER_TMUX_SOCK, getProjectsDir } from '@yaac/shared/paths'
import type { SessionDeathCause } from '@yaac/shared/types'
import { stopSessionForwarders } from '#features/sessions/forwarders/port-forwarders'
import { serverLog } from '#log'

const execFileAsync = promisify(execFile)

/**
 * Absolute host path to `<cachedPackages>/modules/<sessionId>` — the
 * per-session ephemeral-modules root whose subdirs back the
 * `/workspace/<relPath>` symlinks installed at session start. See
 * `installEphemeralModuleLinks` in `packages/server/src/session-create.ts`.
 */
export function sessionModulesDir(projectSlug: string, sessionId: string): string {
  return path.join(cachedPackagesDir(projectSlug), 'modules', sessionId)
}

/**
 * Best-effort removal of the session's state from the proxy sidecar. If
 * the sidecar isn't running there's nothing to clean up. Errors are
 * swallowed so cleanup never blocks container teardown on a sidecar hiccup.
 */
async function removeSessionFromProxy(sessionId: string): Promise<void> {
  try {
    const attached = await proxyClient.attachIfRunning()
    if (!attached) return
    await proxyClient.removeSession(sessionId)
  } catch (err) {
    console.warn(
      `Failed to remove session ${sessionId} from proxy: ${(err as Error).message}`,
    )
  }
}

/**
 * Outcome of a tmux liveness probe.
 * - `alive`:   the "yaac" tmux session is present (exec exited 0).
 * - `dead`:    tmux ran inside the pod and reported no session/server —
 *              a conclusive "the agent is gone" signal.
 * - `unknown`: the probe couldn't reach a verdict (exec timed out, or
 *              failed with a transport/API error). The session may well
 *              be alive; destructive callers (the stale-session reaper)
 *              MUST NOT treat this as dead, or a transient VM/cluster blip
 *              reaps a healthy session (Job + vcluster, no recovery).
 */
export type TmuxLiveness = 'alive' | 'dead' | 'unknown'

/**
 * Cache for exec-probed tmux-liveness results, keyed by
 * `${slug}/${sessionId}`. Each entry holds either a settled
 * (value, expiresAt) row or an in-flight Promise so concurrent
 * callers coalesce onto the same probe.
 *
 * This is the FALLBACK path: sessions with a healthy status-watcher
 * stream short-circuit to `alive` in `probeTmuxLiveness` and never
 * reach the exec probe, so in steady state only watcher-less pods pay
 * it — prewarmed spares (no watchers by design) and sessions whose
 * stream is down or still attaching. The TTL bounds those pods' exec
 * rate against the 5s background tick (reap latency for a conclusive
 * `dead` grows by at most the TTL, well inside the reaper's grace).
 */
const TMUX_ALIVE_TTL_MS = 15_000
const TMUX_PROBE_TIMEOUT_MS = 2_000

type TmuxAliveEntry =
  | { kind: 'settled'; value: TmuxLiveness; expiresAt: number }
  | { kind: 'inflight'; promise: Promise<TmuxLiveness> }

const tmuxAliveCache = new Map<string, TmuxAliveEntry>()

function tmuxAliveKey(slug: string, sessionId: string): string {
  return `${slug}/${sessionId}`
}

/**
 * Test-only: drop every cached entry. Production callers never need to
 * invalidate because the TTL is short and `cleanupSession` already
 * removes the cache entry — but tests that mock different probe
 * behavior across cases need to start each case from a clean slate.
 */
export function _clearTmuxAliveCacheForTests(): void {
  tmuxAliveCache.clear()
}

/**
 * Classify a failed `kubectl exec ... tmux has-session` into `dead`
 * (conclusively no session) vs `unknown` (inconclusive — don't reap).
 *
 * `kubectl exec` prints `command terminated with exit code N` only when
 * the *remote* command actually ran and exited non-zero — i.e. tmux
 * executed in the pod and reported the session/server absent. That line,
 * plus tmux's own "no server/session" messages, are the only conclusive
 * "dead" signals. Everything else — exec timeout (the child is killed
 * with SIGTERM), API/transport errors (`Error from server`, dialing the
 * backend, connection refused, TLS timeout), a `kubectl` binary that's
 * missing, or a pod that momentarily 404s mid-race — is inconclusive.
 *
 * Exported for unit testing the dead/unknown split.
 */
export function classifyTmuxProbeError(err: unknown): 'dead' | 'unknown' {
  const e = (err ?? {}) as { killed?: boolean; stderr?: unknown }
  // execFile's `timeout` kills the child (SIGTERM) — never conclusive.
  if (e.killed) return 'unknown'
  const stderr = typeof e.stderr === 'string'
    ? e.stderr
    : Buffer.isBuffer(e.stderr) ? e.stderr.toString('utf8') : ''
  if (/command terminated with exit code/i.test(stderr)) return 'dead'
  if (/can't find session|no server running|no current session|no sessions|error connecting to/i.test(stderr)) {
    return 'dead'
  }
  return 'unknown'
}

/**
 * Probe tmux liveness by running `tmux has-session` inside the session
 * pod via `kubectl exec`. We can't connect to the hostPath-mounted UNIX
 * socket from the host: the socket file is visible on the host but the
 * listening kernel state isn't host-connectable, so running the client
 * inside the container is the only portable signal.
 *
 * Exit 0 → `alive`. A failure is split into `dead`/`unknown` by
 * `classifyTmuxProbeError` so a transient exec failure never masquerades
 * as a dead session.
 */
async function probeTmuxLivenessUncached(slug: string, sessionId: string): Promise<TmuxLiveness> {
  const jobName = sessionJobName(slug, sessionId)
  try {
    await execFileAsync(
      'kubectl',
      [
        'exec', '-n', k8sNamespace(), execTarget(jobName), '--',
        'tmux', '-S', CONTAINER_TMUX_SOCK, 'has-session', '-t', 'yaac',
      ],
      { timeout: TMUX_PROBE_TIMEOUT_MS },
    )
    return 'alive'
  } catch (err) {
    return classifyTmuxProbeError(err)
  }
}

/**
 * Tri-state tmux liveness for the given session. A healthy
 * status-watcher stream answers `alive` with no exec at all — the
 * watcher's control-mode client is attached to the in-pod tmux server
 * and heartbeats it, which is conclusive proof of life (tmux dying
 * closes the stream immediately, and a wedged stream fails its
 * heartbeat within ~30s, flipping the health bit). Everything else
 * falls back to the exec probe, cached for `TMUX_ALIVE_TTL_MS` with
 * in-flight coalescing so the underlying `kubectl exec` runs at most
 * once per session per TTL window.
 *
 * Use this (not `isTmuxSessionAlive`) anywhere a not-alive verdict drives
 * a destructive action: an `unknown` result must be kept, not reaped.
 * The short-circuit only ever strengthens that guarantee — stream health
 * can produce `alive`, never `dead`.
 */
export async function probeTmuxLiveness(slug: string, sessionId: string): Promise<TmuxLiveness> {
  if (isSessionStreamHealthy(slug, sessionId)) return 'alive'
  const key = tmuxAliveKey(slug, sessionId)
  const now = Date.now()
  const cached = tmuxAliveCache.get(key)
  if (cached) {
    if (cached.kind === 'inflight') return cached.promise
    if (cached.expiresAt > now) return cached.value
  }
  const promise = probeTmuxLivenessUncached(slug, sessionId).then((value) => {
    tmuxAliveCache.set(key, {
      kind: 'settled',
      value,
      expiresAt: Date.now() + TMUX_ALIVE_TTL_MS,
    })
    return value
  })
  tmuxAliveCache.set(key, { kind: 'inflight', promise })
  return promise
}

/**
 * Boolean tmux liveness for display / non-destructive callers: true only
 * when the probe is conclusively `alive`. Both `dead` and `unknown` map
 * to false (skip / no-op), which is safe here — only the reaper needs to
 * tell them apart, and it uses `probeTmuxLiveness` directly.
 */
export async function isTmuxSessionAlive(slug: string, sessionId: string): Promise<boolean> {
  return (await probeTmuxLiveness(slug, sessionId)) === 'alive'
}

/**
 * Outcome of an agent-pane probe.
 * - `placeholder`: the first window's pane still runs the `sleep infinity`
 *                  keepalive that session create opens tmux with — setup
 *                  died between `new-session` and the agent
 *                  `respawn-window` (e.g. the server was restarted
 *                  mid-create), and no agent will ever start.
 * - `started`:     the pane runs something else — the agent respawn
 *                  happened. Terminal state: `respawn-window -k` killed
 *                  the placeholder, so a session can never go back.
 * - `unknown`:     the probe couldn't reach a verdict. Destructive
 *                  callers MUST NOT treat this as `placeholder`.
 */
export type AgentPaneState = 'placeholder' | 'started' | 'unknown'

/** Sessions whose agent pane was conclusively seen running (probe memo —
 *  `started` is terminal, so one positive verdict silences re-probing). */
const agentStartedCache = new Set<string>()

/**
 * Probe whether the agent window still runs the session-create
 * placeholder. Targets `yaac:^` (the lowest-index window — the one
 * `new-session` opened) rather than the tool-named window so a retooled
 * spare's rename can't dodge the check. `pane_current_command` for the
 * placeholder is `sleep` (verified against the exact `new-session`
 * invocation session create uses).
 */
export async function probeAgentPaneState(slug: string, sessionId: string): Promise<AgentPaneState> {
  const key = tmuxAliveKey(slug, sessionId)
  if (agentStartedCache.has(key)) return 'started'
  const jobName = sessionJobName(slug, sessionId)
  try {
    const { stdout } = await execFileAsync(
      'kubectl',
      [
        'exec', '-n', k8sNamespace(), execTarget(jobName), '--',
        'tmux', '-S', CONTAINER_TMUX_SOCK, 'display-message', '-p', '-t', 'yaac:^',
        '#{pane_current_command}',
      ],
      { timeout: TMUX_PROBE_TIMEOUT_MS },
    )
    if (stdout.trim() === 'sleep') return 'placeholder'
    agentStartedCache.add(key)
    return 'started'
  } catch {
    // Includes a dead tmux/session — the liveness probe owns that verdict.
    return 'unknown'
  }
}

/** Test helper: drop all memoized agent-started verdicts. */
export function _clearAgentStartedCacheForTests(): void {
  agentStartedCache.clear()
}

export async function cleanupSession(params: {
  jobName: string
  projectSlug: string
  sessionId: string
  /** Why the session died, when a reaper (not the user) is tearing it
   *  down — persisted so the deleted-session view can say so. */
  cause?: SessionDeathCause
}): Promise<void> {
  const { jobName, projectSlug, sessionId, cause } = params

  // Mark terminating BEFORE evicting the status below: in the gap before
  // Kubernetes stamps the pod's deletionTimestamp, this is what keeps the
  // display path rendering "terminating…" instead of a stray waiting spell.
  markSessionTerminating(sessionId)

  // Stamp the deletion time (and death cause, when a reaper supplied one)
  // so the deleted-session view can order by recency and say why the
  // session went away (best-effort; falls back to transcript mtime if
  // unwritten).
  await recordSessionDeleted(projectSlug, sessionId, cause)

  // Drop any cached tmux-alive / opencode-probe entry and the watcher-fed
  // status-store row so a subsequent caller doesn't see a stale value
  // from this session (or, in the worst case, a value belonging to a
  // brand-new session with the same id).
  tmuxAliveCache.delete(tmuxAliveKey(projectSlug, sessionId))
  agentStartedCache.delete(tmuxAliveKey(projectSlug, sessionId))
  evictSessionStatus(projectSlug, sessionId)
  evictOpencodeProbeCache(projectSlug, sessionId)

  stopSessionForwarders(sessionId)
  await removeSessionFromProxy(sessionId)

  // Salvage built image layers into the project's shared store before the
  // pod (and its graphroot tmpfs) is destroyed. Best-effort, and the
  // in-pod survey self-gates on the nested mounts, so non-nested sessions
  // (and already-dead pods) no-op.
  await salvageSessionImages({ jobName, projectSlug, sessionId })

  // Delete the session Job; the pod's terminationGracePeriodSeconds (5s)
  // covers the graceful-stop window, so no separate stop step is needed.
  // --wait so the modules/tmux dirs below aren't yanked out from under a
  // still-terminating pod.
  try {
    await kubectlWithRetry([
      'delete', 'job', jobName, '-n', k8sNamespace(),
      '--ignore-not-found', '--wait=true', '--timeout=30s',
    ])
  } catch {
    // Job may already be gone, or deletion timed out — best-effort; the
    // background reconcile loop sweeps any leftover Job.
  }

  // Tear down the session's vcluster, if it had one. One cheap probe
  // gates the label-selector deletes so non-vcluster sessions pay a
  // single kubectl get. Best-effort: the background vcluster reconcile
  // sweeps anything this misses.
  try {
    if (await getVclusterStatus(sessionId)) {
      await removeSessionVcluster(vclusterName(sessionId))
    }
  } catch (err) {
    console.warn(`vcluster cleanup for ${sessionId} failed: ${(err as Error).message}`)
  }

  // Remove the per-session ephemeral-modules backing dir from
  // `.cached-packages/modules/<sid>`. No-op if the feature was disabled
  // for this session (dir won't exist).
  await fs.rm(sessionModulesDir(projectSlug, sessionId), {
    recursive: true,
    force: true,
  })

  // Remove the per-session dir (tmux socket dir, vcluster kubeconfig,
  // nested-yaac data). The pod is gone; the hostPath-mount sources are
  // garbage now.
  await fs.rm(sessionDir(projectSlug, sessionId), {
    recursive: true,
    force: true,
  })

  console.log(`Session ${sessionId} cleaned up.`)
}

/**
 * Remove the session's state from the proxy sidecar (in-process, fast),
 * then spawn a detached background process to do the slow Job teardown
 * so the calling process can exit immediately.
 */
export async function cleanupSessionDetached(params: {
  jobName: string
  projectSlug: string
  sessionId: string
  /** Why the session died, when a reaper (not the user) is tearing it
   *  down — persisted so the deleted-session view can say so. */
  cause?: SessionDeathCause
  /** Skip the deleted-store write, leaving whatever cause is already
   *  recorded intact. Set when the caller is *resuming* a teardown yaac
   *  already recorded — e.g. the stale reaper re-issuing the delete for a
   *  session whose in-memory terminating mark was lost to a server restart
   *  or the TTL. Re-recording there would overwrite the true cause (a plain
   *  user delete, or an earlier reaped death) with a spurious out-of-band
   *  reason. */
  preserveDeletedRecord?: boolean
}): Promise<void> {
  const { jobName, projectSlug, sessionId, cause, preserveDeletedRecord } = params

  // Audit every teardown: the actual work below runs as a detached,
  // stdio-ignored child, so without this line a session reaped by the
  // reconciler vanishes with no trace in the server log.
  serverLog(
    `[server] session teardown: session=${sessionId} job=${jobName} project=${projectSlug}`
    + (cause ? ` cause=${cause.reason}${cause.detail ? ` (${cause.detail})` : ''}` : ''),
  )

  // Mark terminating BEFORE evicting the status below (see cleanupSession).
  markSessionTerminating(sessionId)

  // Stamp the deletion time (and death cause, when a reaper supplied one)
  // so the deleted-session view can order by recency and say why the
  // session went away (best-effort; falls back to transcript mtime if
  // unwritten). Skipped when resuming a teardown yaac already recorded, so
  // the existing cause survives (see `preserveDeletedRecord`).
  if (!preserveDeletedRecord) {
    await recordSessionDeleted(projectSlug, sessionId, cause)
  }

  tmuxAliveCache.delete(tmuxAliveKey(projectSlug, sessionId))
  agentStartedCache.delete(tmuxAliveKey(projectSlug, sessionId))
  evictSessionStatus(projectSlug, sessionId)
  evictOpencodeProbeCache(projectSlug, sessionId)

  stopSessionForwarders(sessionId)
  await removeSessionFromProxy(sessionId)

  const modulesDir = sessionModulesDir(projectSlug, sessionId)
  const ephemeralModulesRm = `rm -rf '${modulesDir.replace(/'/g, `'\\''`)}' 2>/dev/null || true`

  const sessDir = sessionDir(projectSlug, sessionId)
  const sessionDirRm = `rm -rf '${sessDir.replace(/'/g, `'\\''`)}' 2>/dev/null || true`

  const script = [
    `kubectl delete job ${jobName} -n ${k8sNamespace()} --ignore-not-found 2>/dev/null || true`,
    // vcluster teardown: pure label-selector deletes, so non-vcluster
    // sessions no-op (every line carries --ignore-not-found + `|| true`).
    buildVclusterCleanupShellCommand(vclusterName(sessionId)),
    ephemeralModulesRm,
    sessionDirRm,
  ].join('; ')

  const spawnDetachedTeardown = (): void => {
    const child = spawn('sh', ['-c', script], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
  }

  // Salvage first: it execs into the pod, which the Job delete destroys.
  // Server-orchestrated (survey exec → node-side writer load — see
  // salvageSessionImages) rather than part of the detached script, and
  // bounded by its own timeouts so a wedged salvage can't strand the
  // teardown. If the server dies in this window, the Job survives and the
  // stale reaper resumes the (idempotent) teardown — the same recovery as
  // a lost detached script. Failures are logged inside and never block.
  void salvageSessionImages({ jobName, projectSlug, sessionId })
    .catch(() => false)
    .then(() => { spawnDetachedTeardown() })
}

/**
 * Server-startup sweep: remove `.cached-packages/modules/<sid>`
 * directories whose session is no longer alive. Catches leftovers from
 * crashes, killed servers, and host reboots.
 */
export async function gcOrphanEphemeralModuleDirs(): Promise<void> {
  let liveSessionIds: Set<string>
  try {
    // Union of pod and Job session ids: a Job mid-recreate (pod evicted,
    // replacement not scheduled yet) only shows up in the Job list, and
    // must not have its dirs swept.
    const [pods, jobs] = await Promise.all([listSessionPods(), listSessionJobs()])
    liveSessionIds = new Set(
      [...pods.map((p) => p.sessionId), ...jobs.map((j) => j.sessionId)]
        .filter((id) => !!id),
    )
  } catch (err) {
    console.warn(`Orphan modules GC: failed to list session pods/jobs: ${(err as Error).message}`)
    return
  }

  let projectSlugs: string[]
  try {
    projectSlugs = await fs.readdir(getProjectsDir())
  } catch {
    return
  }

  for (const slug of projectSlugs) {
    const modulesRoot = path.join(cachedPackagesDir(slug), 'modules')
    let entries: string[] = []
    try {
      entries = await fs.readdir(modulesRoot)
    } catch { /* missing modules dir → nothing to sweep there */ }
    for (const sid of entries) {
      if (liveSessionIds.has(sid)) continue
      const dir = path.join(modulesRoot, sid)
      try {
        await fs.rm(dir, { recursive: true, force: true })
        console.log(`Removed orphan ephemeral modules dir ${dir}`)
      } catch (err) {
        console.warn(`Orphan modules GC: failed to remove ${dir}: ${(err as Error).message}`)
      }
    }

    // Per-session tmux bind-mount dirs live under <projectDir>/sessions/<sid>/tmux.
    // The parent `sessions/` dir is unique to this feature, so a flat
    // readdir of `sessions/` gives us the session id list directly.
    const sessionsRoot = path.join(projectDir(slug), 'sessions')
    let sessionEntries: string[] = []
    try {
      sessionEntries = await fs.readdir(sessionsRoot)
    } catch { /* missing sessions dir → nothing to sweep there */ }
    for (const sid of sessionEntries) {
      if (liveSessionIds.has(sid)) continue
      const dir = path.join(sessionsRoot, sid)
      try {
        await fs.rm(dir, { recursive: true, force: true })
        console.log(`Removed orphan session dir ${dir}`)
      } catch (err) {
        console.warn(`Orphan session GC: failed to remove ${dir}: ${(err as Error).message}`)
      }
    }
  }
}
