import { workspaceDriver } from '#drivers/driver'
import { StatusWatcherManager, onLiveAgentsChanged, onStreamHealthLost } from '#runtime/status'
import { restoreAllWorkspaceForwarders } from '#runtime/ports'
import { findWorkspaceRow, recordedConversationHandles } from '#db'
import { resolveProjectConfig } from '#domain/projects'
import { serverLog } from '#log'
import type { ReconcileTrigger, RuntimeHandle } from '#drivers/contract'

/**
 * Wires the driver's observations into the driver-neutral machinery. The
 * status watchers (`#runtime/status`) need recorded conversations and
 * permission modes from `#db`, and the forwarder restore needs project
 * config from `#domain`, neither of which a driver may import, so the
 * composition root supplies them.
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
 * Start the driver and wire what it reports into the machinery.
 *
 * `onAttached` fires once actually attached, which may be after this
 * resolves if the driver defers attaching. The reconcile loop starts from
 * that callback so its first pass does not force an early attach.
 */
export async function attachConvergence(opts: {
  onAttached: () => void
}): Promise<void> {
  // The ACP driver needs a workspace's recorded conversations to
  // re-address a live agent or `session/load` after a restart.
  const manager = new StatusWatcherManager({
    recordedSessions: (session) =>
      recordedConversationHandles(session.slug, session.workspaceId),
    // For `acp` the permission mode is sent over the protocol, so the
    // connection needs it. A missing row yields `undefined`, not a default:
    // assuming an unrestricted mode could auto-answer asks the user should
    // have seen.
    permissionMode: async (session) =>
      (await findWorkspaceRow(session.workspaceId))?.permissionMode,
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

  await workspaceDriver().start({
    trigger: fireChange,
    workspacesChanged: (workspaces: RuntimeHandle[]) => manager.sync(workspaces),
    // A restart loses the in-memory forwarder registry while running
    // workspaces still advertise their ports in tmux `status-right`.
    // Rebuild forwarders before anything watches.
    recover: async () => {
      try {
        await restoreAllWorkspaceForwarders(
          (slug: string) => resolveProjectConfig(slug).then((c) => c ?? undefined),
        )
      } catch (err) {
        serverLog(`[server] restore forwarders failed: ${String(err)}`)
      }
    },
    attached: opts.onAttached,
  })
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
