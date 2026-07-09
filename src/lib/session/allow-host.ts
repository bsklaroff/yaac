import { isPrewarmed, listSessionPods } from '@/lib/k8s/pods'
import { proxyClient } from '@/lib/container/proxy-client'
import { addAllowedHostToProjectConfig } from '@/lib/project/local-config'
import { DaemonError } from '@/daemon/errors'

/**
 * Allow a previously-blocked egress host for a running session (the webapp
 * click-to-allow action). Without persist the widen is live-only: it exists in
 * the proxy's registration for this one session and is gone when the session
 * is recreated. With persist the host is first written into the project's
 * yaac-config.json (so every future session inherits it) and the live widen is
 * fanned out to all of the project's currently-running sessions — the proxy
 * reports sessions it has no registration for (allowHost → false), which the
 * fan-out tolerates, while a miss on the directly-targeted session is an error
 * the user should see.
 */
export async function allowSessionHost(
  target: { sessionId: string; projectSlug: string },
  host: string,
  opts: { persist: boolean },
): Promise<void> {
  await proxyClient.attachIfRunning()

  if (!opts.persist) {
    if (!(await proxyClient.allowHost(target.sessionId, host))) {
      throw new DaemonError(
        'CONFLICT',
        `session ${target.sessionId} is not registered with the egress proxy`,
      )
    }
    return
  }

  await addAllowedHostToProjectConfig(target.projectSlug, host)
  // Just the project's pods — not listActiveSessions, whose per-session
  // status/first-message/blocked-hosts reads the fan-out has no use for.
  const pods = await listSessionPods(target.projectSlug)
  await Promise.all(
    pods
      .filter((p) => p.running && p.sessionId && !isPrewarmed(p))
      .map((p) => proxyClient.allowHost(p.sessionId, host)),
  )
}
