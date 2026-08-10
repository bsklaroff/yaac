import { isPrewarmed, listWorktreePods } from '#platform/k8s'
import { addWorktreeForwarder } from './port-forwarders'
import { getUnforwardedPorts } from './port-detector'
import { addPortForwardToProjectConfig } from '#store/projects'
import { ServerError } from '@yaac/shared/errors'
import { serverLog } from '#log'
import type { PortMapping } from '@yaac/shared/types'

/**
 * Forward a detected-but-unforwarded port for a running worktree (the
 * webapp's click-to-forward action, mirroring allowWorktreeHost). The port
 * must be in the worktree's currently-surfaced unforwarded set — the
 * action can't be driven to forward an arbitrary port, only one whose
 * listener detection observed and the filters allowed. Without persist
 * the forward is live-only: it exists in this server's forwarder registry
 * and is gone when the worktree is recreated. With persist the port is
 * first written into the project's yaac-config.json (so every future
 * worktree inherits it) and the live forward is fanned out to all of the
 * project's currently-running worktrees — best-effort for the siblings
 * (a sibling with nothing listening just holds a forward that fails per
 * connection, same as any config-declared forward), while a failure on
 * the directly-targeted worktree is an error the user should see.
 */
export async function forwardWorktreePort(
  target: { worktreeId: string; projectSlug: string; jobName: string },
  containerPort: number,
  opts: { persist: boolean },
): Promise<PortMapping> {
  if (!getUnforwardedPorts(target.worktreeId).includes(containerPort)) {
    throw new ServerError(
      'CONFLICT',
      `port ${containerPort} is not an unforwarded listener in session ${target.worktreeId.slice(0, 8)}`,
    )
  }

  if (opts.persist) {
    await addPortForwardToProjectConfig(target.projectSlug, containerPort)
  }

  const mapping = await addWorktreeForwarder(
    target.projectSlug, target.worktreeId, target.jobName, containerPort,
  )

  if (opts.persist) {
    // Just the project's pods — the fan-out has no use for the full
    // worktree-list snapshot (matching allowWorktreeHost).
    const pods = await listWorktreePods(target.projectSlug)
    await Promise.all(
      pods
        .filter((p) => p.running && p.worktreeId && p.worktreeId !== target.worktreeId && !isPrewarmed(p))
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
