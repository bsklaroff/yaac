import { isPrewarmed, listSessionPods } from '#platform/k8s'
import { addSessionForwarder } from './port-forwarders'
import { getUnforwardedPorts } from './port-detector'
import { addPortForwardToProjectConfig } from '#features/projects'
import { ServerError } from '@yaac/shared/errors'
import { serverLog } from '#log'
import type { PortMapping } from '@yaac/shared/types'

/**
 * Forward a detected-but-unforwarded port for a running session (the
 * webapp's click-to-forward action, mirroring allowSessionHost). The port
 * must be in the session's currently-surfaced unforwarded set — the
 * action can't be driven to forward an arbitrary port, only one whose
 * listener detection observed and the filters allowed. Without persist
 * the forward is live-only: it exists in this server's forwarder registry
 * and is gone when the session is recreated. With persist the port is
 * first written into the project's yaac-config.json (so every future
 * session inherits it) and the live forward is fanned out to all of the
 * project's currently-running sessions — best-effort for the siblings
 * (a sibling with nothing listening just holds a forward that fails per
 * connection, same as any config-declared forward), while a failure on
 * the directly-targeted session is an error the user should see.
 */
export async function forwardSessionPort(
  target: { sessionId: string; projectSlug: string; jobName: string },
  containerPort: number,
  opts: { persist: boolean },
): Promise<PortMapping> {
  if (!getUnforwardedPorts(target.sessionId).includes(containerPort)) {
    throw new ServerError(
      'CONFLICT',
      `port ${containerPort} is not an unforwarded listener in session ${target.sessionId.slice(0, 8)}`,
    )
  }

  if (opts.persist) {
    await addPortForwardToProjectConfig(target.projectSlug, containerPort)
  }

  const mapping = await addSessionForwarder(
    target.projectSlug, target.sessionId, target.jobName, containerPort,
  )

  if (opts.persist) {
    // Just the project's pods — the fan-out has no use for the full
    // session-list snapshot (matching allowSessionHost).
    const pods = await listSessionPods(target.projectSlug)
    await Promise.all(
      pods
        .filter((p) => p.running && p.sessionId && p.sessionId !== target.sessionId && !isPrewarmed(p))
        .map((p) =>
          addSessionForwarder(p.projectSlug, p.sessionId, p.jobName, containerPort)
            .catch((err: unknown) => {
              serverLog(
                `[server] forward-port fan-out to ${p.sessionId.slice(0, 8)} failed: `
                + (err instanceof Error ? err.message : String(err)),
              )
            })),
    )
  }

  return mapping
}
