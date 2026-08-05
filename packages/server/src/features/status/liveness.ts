/**
 * Is a session's agent still there? Two in-pod probes and their caches.
 *
 * Both run the tmux client *inside* the container over the stream relay: the
 * server socket is hostPath-mounted, but the listening kernel state isn't
 * host-connectable, so a host-side connect() is not a portable signal.
 *
 * Neither probe may conclude "dead" from a transport failure. A destructive
 * caller (the stale reaper) acts on the verdict, and a cluster blip that read
 * as death would reap a healthy session — Job, vcluster and all — with no
 * recovery. That is why both return a tri-state with an explicit `unknown`.
 */
import {
  RelayExecError,
  sessionExec,
  sessionJobName,
} from '#platform/k8s'
import { CONTAINER_TMUX_SOCK } from '@yaac/shared/paths'
import { isSessionStreamHealthy } from './status-store'

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
/** How long the reaper is willing to wait on a probe. `sessionExec` floors
 *  it at MIN_EXEC_TIMEOUT_MS, since the dial deadline derives from this and
 *  a probe's impatience is not a verdict on the relay every session shares
 *  — so the real ceiling is that floor, and an `unknown` verdict (which
 *  never reaps) is all that is at stake in the difference. */
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
 * Classify a failed in-pod `tmux has-session` probe into `dead`
 * (conclusively no session) vs `unknown` (inconclusive — don't reap).
 *
 * A `RelayExecError` means the probe REACHED the pod: streamd ran tmux
 * and it exited nonzero — the session/server is absent. That is the only
 * conclusive "dead" signal. Everything else — a relay dial failure (proxy
 * down, streamd dead, pod gone mid-race), a timeout, a malformed result —
 * proves nothing about the session and must be kept, not reaped.
 *
 * Exported for unit testing the dead/unknown split.
 */
export function classifyTmuxProbeError(err: unknown): 'dead' | 'unknown' {
  return err instanceof RelayExecError ? 'dead' : 'unknown'
}

/**
 * Probe tmux liveness by running `tmux has-session` inside the session
 * pod via its streamd (relay exec). We can't connect to the
 * hostPath-mounted UNIX socket from the host: the socket file is visible
 * on the host but the listening kernel state isn't host-connectable, so
 * running the client inside the container is the only portable signal.
 *
 * Exit 0 → `alive`. A failure is split into `dead`/`unknown` by
 * `classifyTmuxProbeError` so a transient transport failure never
 * masquerades as a dead session.
 */
async function probeTmuxLivenessUncached(slug: string, sessionId: string): Promise<TmuxLiveness> {
  const jobName = sessionJobName(slug, sessionId)
  try {
    await sessionExec(
      jobName,
      `tmux -S ${CONTAINER_TMUX_SOCK} has-session -t yaac`,
      { timeout: TMUX_PROBE_TIMEOUT_MS, maxAttempts: 1 },
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
    const { stdout } = await sessionExec(
      jobName,
      `tmux -S ${CONTAINER_TMUX_SOCK} display-message -p -t 'yaac:^' '#{pane_current_command}'`,
      { timeout: TMUX_PROBE_TIMEOUT_MS, maxAttempts: 1 },
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

/**
 * Drop a session's cached probe verdicts. Called from session teardown so a
 * later caller can't read a stale value — in the worst case one belonging to
 * a brand-new session that reused the id.
 */
export function forgetLiveness(slug: string, sessionId: string): void {
  const key = tmuxAliveKey(slug, sessionId)
  tmuxAliveCache.delete(key)
  agentStartedCache.delete(key)
}
