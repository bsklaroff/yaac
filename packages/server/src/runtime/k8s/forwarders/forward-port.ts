import { isPrewarmed, listWorktreePods } from '#runtime/k8s/substrate'
import { addWorktreeForwarder } from './port-forwarders'
import { getUnforwardedPorts } from './port-detector'
import { ServerError } from '@yaac/shared/errors'
import { serverLog } from '#log'
import type { PortMapping } from '@yaac/shared/types'

/**
 * Forward a detected-but-unforwarded port for a running workspace, live (the
 * webapp's click-to-forward action, mirroring allowWorktreeHost).
 *
 * The port must be in the workspace's currently-surfaced unforwarded set —
 * the action can't be driven to forward an arbitrary port, only one whose
 * listener detection observed and the filters allowed.
 *
 * Live is all this is: the forward exists in this server's forwarder registry
 * and is gone when the workspace is recreated. Making it stick is the
 * mediator's half — it writes the project config first, then asks for the
 * fan-out, which forwards the same port on the project's other running
 * workspaces. The siblings are best-effort (one with nothing listening just
 * holds a forward that fails per connection, same as any config-declared
 * forward), while a failure on the named target is an error the user should
 * see.
 */
export async function forwardWorktreePort(
  target: { workspaceId: string; projectSlug: string; jobName: string },
  containerPort: number,
  opts: { fanOutToProject: boolean },
): Promise<PortMapping> {
  if (!getUnforwardedPorts(target.workspaceId).includes(containerPort)) {
    throw new ServerError(
      'CONFLICT',
      `port ${containerPort} is not an unforwarded listener in session ${target.workspaceId.slice(0, 8)}`,
    )
  }

  const mapping = await addWorktreeForwarder(
    target.projectSlug, target.workspaceId, target.jobName, containerPort,
  )

  if (opts.fanOutToProject) {
    // Just the project's pods — the fan-out has no use for the full
    // worktree-list snapshot (matching allowWorktreeHost).
    const pods = await listWorktreePods(target.projectSlug)
    await Promise.all(
      pods
        .filter((p) => p.running && p.worktreeId && p.worktreeId !== target.workspaceId && !isPrewarmed(p))
        .map((p) =>
          addWorktreeForwarder(p.projectSlug, p.worktreeId, p.jobName, containerPort)
            .catch((err: unknown) => {
              serverLog(
                `[server] forward-port fan-out to ${p.worktreeId.slice(0, 8)} failed: `
                + (err instanceof Error ? err.message : String(err)),
              )
            })),
    )
  }

  return mapping
}
