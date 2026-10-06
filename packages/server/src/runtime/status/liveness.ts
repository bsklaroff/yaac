/**
 * Is a workspace's agent still there? Two in-workspace probes, run through
 * the driver's exec, and their caches.
 *
 * Neither probe may conclude "dead" from a transport failure: the stale
 * reaper acts on the verdict, and a cluster blip read as death would
 * destroy a healthy workspace. So both return a tri-state with `unknown`.
 */
import { WorkspaceExecError, type RuntimeHandle } from '#drivers/contract'
import { workspaceDriver } from '#drivers/driver'
import { tmuxCmd } from '#runtime/agents'
import { isWorkspaceStreamHealthy } from './status-store'

/**
 * What a probe addresses: the workspace's identity (keying the cache and
 * the stream-health shortcut) plus the driver's unit name for the exec.
 * Taken whole because building a unit name would encode the driver's
 * naming scheme; callers already hold a `RuntimeHandle`.
 */
export type ProbeTarget = Pick<RuntimeHandle, 'projectId' | 'workspaceId' | 'jobName'>

/**
 * Outcome of a tmux liveness probe.
 * - `alive`:   the "yaac" tmux session exists (exec exited 0).
 * - `dead`:    tmux ran in the workspace and reported no session/server.
 * - `unknown`: no verdict (timeout, transport or API error). The reaper
 *              must not treat this as dead.
 */
export type TmuxLiveness = 'alive' | 'dead' | 'unknown'

/**
 * Cache of exec-probed tmux liveness, keyed by `${projectId}/${workspaceId}`.
 * Entries are a settled (value, expiresAt) or an in-flight Promise, so
 * concurrent callers share one probe.
 *
 * Only a fallback: a healthy status-watcher stream short-circuits to
 * `alive`, so only watcher-less workspaces (spares, streams down or still
 * attaching) reach the exec. The TTL bounds their exec rate across
 * reconcile passes, delaying a `dead` reap by at most the TTL.
 */
const TMUX_ALIVE_TTL_MS = 15_000
/** How long the reaper waits on a probe. A driver may raise it (k8s floors
 *  it at MIN_EXEC_TIMEOUT_MS, since its dial deadline derives from it);
 *  only an `unknown`, which never reaps, depends on the difference. */
const TMUX_PROBE_TIMEOUT_MS = 2_000

type TmuxAliveEntry =
  | { kind: 'settled'; value: TmuxLiveness; expiresAt: number }
  | { kind: 'inflight'; promise: Promise<TmuxLiveness> }

const tmuxAliveCache = new Map<string, TmuxAliveEntry>()

function tmuxAliveKey(projectId: string, workspaceId: string): string {
  return `${projectId}/${workspaceId}`
}

/**
 * Test-only: drop every cached entry. Production never needs this: the TTL
 * is short and `cleanupWorkspace` removes a workspace's entry.
 */
export function _clearTmuxAliveCacheForTests(): void {
  tmuxAliveCache.clear()
}

/**
 * Classify a failed `tmux has-session` probe as `dead` or `unknown`. Only a
 * `WorkspaceExecError` (tmux ran in the workspace and exited nonzero) is a
 * conclusive `dead`. Transport failures, timeouts and malformed results
 * prove nothing and must not reap. Exported for tests.
 */
export function classifyTmuxProbeError(err: unknown): 'dead' | 'unknown' {
  return err instanceof WorkspaceExecError ? 'dead' : 'unknown'
}

/**
 * Probe tmux liveness by running `tmux has-session` inside the workspace
 * via the driver's exec. Exit 0 is `alive`; failures are split by
 * `classifyTmuxProbeError` so a transport blip never looks like death.
 */
async function probeTmuxLivenessUncached(target: ProbeTarget): Promise<TmuxLiveness> {
  const driver = workspaceDriver()
  try {
    await driver.exec(
      target.jobName,
      `${tmuxCmd(driver.workspacePaths(target.jobName))} has-session -t yaac`,
      { timeout: TMUX_PROBE_TIMEOUT_MS, maxAttempts: 1 },
    )
    return 'alive'
  } catch (err) {
    return classifyTmuxProbeError(err)
  }
}

/**
 * Tri-state tmux liveness. A healthy status-watcher stream answers `alive`
 * without an exec: its control-mode client is attached to tmux and
 * heartbeats it (tmux dying closes the stream; a wedged stream fails its
 * heartbeat within ~30s). Otherwise the exec probe runs, cached for
 * `TMUX_ALIVE_TTL_MS` with in-flight sharing.
 *
 * Use this, not `isTmuxSessionAlive`, wherever not-alive triggers a
 * destructive action. Stream health can only produce `alive`, never `dead`.
 */
export async function probeTmuxLiveness(target: ProbeTarget): Promise<TmuxLiveness> {
  const { projectId, workspaceId } = target
  if (isWorkspaceStreamHealthy(projectId, workspaceId)) return 'alive'
  const key = tmuxAliveKey(projectId, workspaceId)
  const now = Date.now()
  const cached = tmuxAliveCache.get(key)
  if (cached) {
    if (cached.kind === 'inflight') return cached.promise
    if (cached.expiresAt > now) return cached.value
  }
  const promise = probeTmuxLivenessUncached(target).then((value) => {
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
 * Boolean tmux liveness for display and non-destructive callers: true only
 * when conclusively `alive`. Only the reaper needs to tell `dead` from
 * `unknown`, and it uses `probeTmuxLiveness`.
 */
export async function isTmuxSessionAlive(target: ProbeTarget): Promise<boolean> {
  return (await probeTmuxLiveness(target)) === 'alive'
}

/**
 * Outcome of an agent-pane probe.
 * - `placeholder`: the first pane still runs create's `sleep infinity`
 *                  keepalive; setup died before `respawn-window` (e.g. a
 *                  server restart mid-create), so no agent will start.
 * - `started`:     the agent was respawned. Final: `respawn-window -k`
 *                  killed the placeholder.
 * - `unknown`:     no verdict; must not be treated as `placeholder`.
 */
export type AgentPaneState = 'placeholder' | 'started' | 'unknown'

/** Workspaces whose agent was seen started; `started` is final, so they are
 *  not probed again. */
const agentStartedCache = new Set<string>()

/**
 * Probe whether the first window still runs create's placeholder. Targets
 * `yaac:^` (the lowest-index window, opened by `new-session`) rather than
 * the tool-named window, so a retooled spare's rename cannot hide it. The
 * placeholder's `pane_current_command` is `sleep`.
 */
export async function probeAgentPaneState(target: ProbeTarget): Promise<AgentPaneState> {
  const key = tmuxAliveKey(target.projectId, target.workspaceId)
  if (agentStartedCache.has(key)) return 'started'
  try {
    const driver = workspaceDriver()
    const { stdout } = await driver.exec(
      target.jobName,
      `${tmuxCmd(driver.workspacePaths(target.jobName))} `
      + "display-message -p -t 'yaac:^' '#{pane_current_command}'",
      { timeout: TMUX_PROBE_TIMEOUT_MS, maxAttempts: 1 },
    )
    if (stdout.trim() === 'sleep') return 'placeholder'
    agentStartedCache.add(key)
    return 'started'
  } catch {
    // Includes a dead tmux; the liveness probe decides that.
    return 'unknown'
  }
}

/** Test helper: drop all memoized agent-started verdicts. */
export function _clearAgentStartedCacheForTests(): void {
  agentStartedCache.clear()
}

/**
 * Drop a workspace's cached probe verdicts. Called on teardown so a new
 * workspace reusing the id cannot read a stale value.
 */
export function forgetLiveness(projectId: string, workspaceId: string): void {
  const key = tmuxAliveKey(projectId, workspaceId)
  tmuxAliveCache.delete(key)
  agentStartedCache.delete(key)
}
