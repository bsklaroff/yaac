import { worktreeDriver } from '#drivers/driver'
import { StatusWatcherManager, onLiveAgentsChanged, onStreamHealthLost } from '#runtime/status'
import { restoreAllWorkspaceForwarders } from '#runtime/ports'
import { findWorktreeRow, recordedConversationHandles } from '#db'
import { resolveProjectConfig } from '#domain/projects'
import { serverLog } from '#log'
import type { DriverDeps, ReconcileTrigger, RuntimeHandle } from '#drivers/contract'

/**
 * Convergence: everything push-fed, and the wiring between the driver that
 * observes and the machinery that interprets.
 *
 * What is left here after the driver took its own attach is the part that
 * is genuinely the composition root's — the two things a driver may not
 * reach for itself. The status watchers are driver-neutral machinery
 * (`#runtime/status`), and they need a worktree's recorded conversations,
 * which is a row; so main constructs them, feeds them the workspace set the
 * driver reports, and passes the db lookup down. Same for the forwarder
 * restore: machinery, over a project-config reader that is domain's.
 *
 * Two of the pass's trigger sources are raised here rather than by the
 * driver, and that is the point of them — a conversation appearing and a
 * driver connection dropping are in-workspace facts no watch of any
 * substrate can see.
 */

export type ChangeSource = ReconcileTrigger

let statusWatchers: StatusWatcherManager | null = null
const changeListeners: ((source: ChangeSource) => void)[] = []

function fireChange(source: ReconcileTrigger): void {
  for (const fn of changeListeners) fn(source)
}

/**
 * Attach: start the driver, and wire what it reports into the machinery.
 *
 * `onAttached` fires once really attached, which is not necessarily before
 * this resolves — a driver may defer attaching until first use. The
 * reconcile loop starts from that callback rather than from the return, so
 * a substrate that defers is not woken by the loop's first pass.
 */
export async function attachConvergence(opts: {
  onAttached: () => void
  sshIdentities?: DriverDeps['sshIdentities']
}): Promise<void> {
  // The ACP driver needs a worktree's already-recorded conversations to
  // re-address a live agent (and to `session/load` after a restart), and
  // which conversation sits on a handle is a row.
  const manager = new StatusWatcherManager({
    recordedSessions: (session) =>
      recordedConversationHandles(session.slug, session.worktreeId),
    // And its posture, which for `acp` is not a launch argument but something
    // the adapter is told over the protocol — so the connection needs it, and
    // only the row knows it.
    //
    // A missing row answers `undefined` rather than a default. It is not
    // evidence that this worktree runs unrestrained, and treating it as such
    // would auto-answer asks the row might well have said to forward — so the
    // absence is passed on as the absence it is.
    permissionMode: async (session) =>
      (await findWorktreeRow(session.worktreeId))?.permissionMode,
  })
  statusWatchers = manager

  // A conversation appearing, going, or learning its id is a change the
  // reconcile steps owe work on, and no watch below can see it: for `acp`
  // the id comes from the in-pod handshake, well after the substrate
  // deltas that created the window have gone quiet. Without this the
  // worktree's conversation rows — and so the webapp's chat pane — wait
  // for the 60s resync.
  onLiveAgentsChanged(() => fireChange('live-agents'))
  // Losing a driver connection retires the "stream healthy ⇒ tmux alive"
  // shortcut for that worktree, which is precisely when the stale reaper's
  // own probes are worth running. In-workspace tmux death is not a
  // substrate event, so without this the reaper would have nothing to
  // wake it.
  onStreamHealthLost(() => fireChange('status-streams'))

  await worktreeDriver().start({
    trigger: fireChange,
    workspacesChanged: (workspaces: RuntimeHandle[]) => manager.sync(workspaces),
    // A server restart loses the in-memory forwarder registry while
    // running workspaces keep their tmux `status-right` advertising ports
    // that aren't actually forwarded anymore. Rebuild them before anything
    // watches, so the displayed port mapping matches reality.
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
  }, {
    ...(opts.sshIdentities !== undefined ? { sshIdentities: opts.sshIdentities } : {}),
  })
}

/**
 * Stop everything push-fed, synchronously: the driver's watches and
 * streams, and the per-worktree status watchers over them.
 *
 * Separate from `releaseConvergence` because the reconcile loop drains
 * between the two — the watches must be down before the drain, and the
 * forwarders must survive it (a reap tick still tears its worktree down).
 */
export function stopConvergence(): void {
  // Before the driver's own stop: each watcher holds a long-lived stream
  // that the driver's transport is underneath.
  statusWatchers?.stopAll()
  statusWatchers = null
  worktreeDriver().stop()
}

/** Release what was borrowed from the host — the driver's forwarders and
 *  control tunnel. After the reconcile drain, because a reap tick in that
 *  drain still tears its worktree's forwards down. */
export function releaseConvergence(): void {
  worktreeDriver().release()
}

/** Subscribe to change notifications from the convergence watches. */
export function onConvergenceChange(fn: (source: ChangeSource) => void): void {
  changeListeners.push(fn)
}
