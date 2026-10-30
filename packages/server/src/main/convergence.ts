import { workspaceDriver } from '#drivers/driver'
import { StatusWatcherManager, onLiveAgentsChanged, onStreamHealthLost, onWaitingEnded } from '#runtime/status'
import { acpLaunchModel } from '#runtime/agents'
import { startUsageSampler, stopUsageSampler } from '#runtime/usage'
import { loadToolAuthEntry } from '#domain/auth'
import { restoreAllWorkspaceForwarders } from '#main/restore-forwarders'
import { applyWorkspaceEvent, getProjectRow, listWorkspaceSessions } from '#db'
import { resolveProjectConfig } from '#domain/projects'
import { errorText, serverLog } from '#lib/log'
import type { ReconcileTrigger, RuntimeHandle } from '#drivers/contract'

/**
 * Wires the driver's observations into the driver-neutral machinery. The
 * status watchers (`#runtime/status`) need each workspace's open sessions
 * from `#db`, and the forwarder restore needs project config from
 * `#domain`, neither of which a driver may import, so the composition root
 * supplies them.
 *
 * Two reconcile triggers are raised here rather than by the driver, since
 * no substrate watch can see them: a conversation appearing, and a driver
 * connection dropping.
 */

export type ChangeSource = ReconcileTrigger

let statusWatchers: StatusWatcherManager | null = null
const changeListeners: ((source: ChangeSource) => void)[] = []

function fireChange(source: ReconcileTrigger): void {
  for (const fn of changeListeners) fn(source)
}

/**
 * Start the driver, wire what it reports into the machinery, and start the
 * usage history sampler.
 *
 * `onAttached` fires once actually attached, which may be after this
 * resolves if the driver defers attaching. The reconcile loop starts from
 * that callback so its first pass does not force an early attach.
 */
export async function attachConvergence(opts: {
  onAttached: () => void
}): Promise<void> {
  // The drivers need a workspace's sessions to know which windows to watch
  // and how; the ACP driver also to re-address a live agent or
  // `session/load` after a restart, and to tell an adapter its posture,
  // effort and, where it takes it no other way, its model.
  const manager = new StatusWatcherManager({
    sessions: async (workspace) => {
      const sessions = await listWorkspaceSessions(workspace.workspaceId)
      const owner = sessions.some((s) => s.tool === 'pi')
        ? (await getProjectRow(workspace.projectId))?.owner
        : undefined
      const piProvider = owner !== undefined ? (await loadToolAuthEntry(owner, 'pi'))?.piProvider : undefined
      return sessions.map((s) => {
        const model = acpLaunchModel({
          tool: s.tool,
          ...(s.model !== undefined ? { model: s.model } : {}),
          ...(piProvider !== undefined ? { piProvider } : {}),
        })
        return {
          window: s.window,
          tool: s.tool,
          mode: s.mode,
          sessionId: s.id,
          permissionMode: s.permissionMode,
          ...(s.conversationId !== undefined ? { conversationId: s.conversationId } : {}),
          ...(s.effort !== undefined ? { effort: s.effort } : {}),
          ...(model !== undefined ? { model } : {}),
        }
      })
    },
  })
  statusWatchers = manager

  // A conversation appearing, ending or learning its id needs reconcile
  // work, and no substrate watch sees it (for `acp` the id arrives from the
  // in-pod handshake). Without this, conversation rows and the chat pane
  // would wait for the 60s resync.
  onLiveAgentsChanged(() => fireChange('live-agents'))
  // Once a driver connection drops, a healthy stream no longer implies
  // tmux is alive, so wake the stale reaper to run its own probes.
  onStreamHealthLost(() => fireChange('status-streams'))
  // A session going back to work makes its next waiting spell unread.
  onWaitingEnded((projectId, workspaceId, window) => {
    applyWorkspaceEvent({ type: 'waiting-ended', projectId, workspaceId, window })
      .catch((err: unknown) => serverLog(`[server] record waiting end failed: ${errorText(err)}`))
  })

  await workspaceDriver().start({
    trigger: fireChange,
    workspacesChanged: (workspaces: RuntimeHandle[]) => manager.sync(workspaces),
    // A restart loses the in-memory forwarder registry while running
    // workspaces still advertise their ports in tmux `status-right`.
    // Rebuild forwarders before anything watches.
    recover: async () => {
      try {
        await restoreAllWorkspaceForwarders(
          (projectId: string) => resolveProjectConfig(projectId).then((c) => c ?? undefined),
        )
      } catch (err) {
        serverLog(`[server] restore forwarders failed: ${errorText(err)}`)
      }
    },
    attached: opts.onAttached,
  })
  startUsageSampler()
}

/**
 * Stop the driver's watches and streams and the status watchers over them.
 * Separate from `releaseConvergence` because the reconcile loop drains in
 * between: watches must stop before the drain, but forwarders must survive
 * it (a reap in the drain still tears its workspace's forwards down).
 */
export function stopConvergence(): void {
  // Stop watchers first; their streams run over the driver's transport.
  statusWatchers?.stopAll()
  statusWatchers = null
  stopUsageSampler()
  workspaceDriver().stop()
}

/** Release the driver's forwarders and control tunnel. Called after the
 *  reconcile drain, since a reap in the drain still uses them. */
export function releaseConvergence(): void {
  workspaceDriver().release()
}

/** Subscribe to change notifications from the convergence watches. */
export function onConvergenceChange(fn: (source: ChangeSource) => void): void {
  changeListeners.push(fn)
}
