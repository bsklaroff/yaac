import { isPrewarmed, listWorktreePods } from '#drivers/k8s/substrate'
import { proxyClient } from './proxy-client'
import { notifyWorktreeListChanged } from '#notify'
import { ServerError } from '@yaac/shared/errors'

/**
 * Widen a running workspace's egress to reach `host`, live (the webapp's
 * click-to-allow action).
 *
 * Live is all this is: the host enters the proxy's registration for this one
 * workspace and is gone when the workspace is recreated. Making it stick is
 * the mediator's half — it writes the project config first, then asks for the
 * fan-out, which widens every one of the project's running workspaces so a
 * persisted host takes effect without waiting for each to be recreated.
 *
 * The two shapes differ in how a proxy miss reads. Widening one named
 * workspace, a miss is an error the user should see — they clicked on that
 * badge. Across a fan-out it is expected: the proxy reports a workspace it
 * holds no registration for (allowHost → false), and the whole point of the
 * sweep is to reach whichever ones it does hold.
 */
export async function allowWorktreeHost(
  target: { workspaceId: string; projectSlug: string },
  host: string,
  opts: { fanOutToProject: boolean },
): Promise<void> {
  await proxyClient.attachIfRunning()

  if (!opts.fanOutToProject) {
    if (!(await proxyClient.allowHost(target.workspaceId, host))) {
      throw new ServerError(
        'CONFLICT',
        `session ${target.workspaceId} is not registered with the egress proxy`,
      )
    }
    notifyBlockedHostsChanged()
    return
  }

  // Just the project's pods — not listActiveWorktrees, whose per-worktree
  // status/first-message/blocked-hosts reads the fan-out has no use for. The
  // target is one of them, so it needs no separate widen.
  const pods = await listWorktreePods(target.projectSlug)
  await Promise.all(
    pods
      .filter((p) => p.running && p.worktreeId && !isPrewarmed(p))
      .map((p) => proxyClient.allowHost(p.worktreeId, host)),
  )
  notifyBlockedHostsChanged()
}

/**
 * The allow just pruned the host from the proxy's recorded blocked set,
 * which the snapshot reads. Strictly speaking the proxy's own
 * `blocked-hosts` event covers this — but pushing here keeps the click
 * instant regardless of stream latency, and is the only signal at all
 * against a proxy predating the event stream. The hub diffs, so the
 * overlap costs a rebuild rather than a duplicate push.
 */
function notifyBlockedHostsChanged(): void {
  notifyWorktreeListChanged()
}
