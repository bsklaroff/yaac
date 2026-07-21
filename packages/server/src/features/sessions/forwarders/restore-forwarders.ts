/**
 * Server-startup pass that rebuilds port forwarders for every live yaac
 * session pod. A server restart loses the in-memory forwarder registry
 * while session pods keep running with stale `status-right` info, so
 * without this pass the tmux bars lie about which ports are
 * actually forwarded.
 */

import { listSessionPods } from '#platform/k8s/pods'
import { resolveProjectConfig } from '#features/projects/config'
import { isTmuxSessionAlive } from '#features/sessions/cleanup'
import { hasSessionForwarders, provisionSessionForwarders } from '#features/sessions/forwarders/port-forwarders'

interface RestoreCandidate {
  jobName: string
  projectSlug: string
  sessionId: string
}

export async function restoreAllSessionForwarders(): Promise<void> {
  let pods
  try {
    pods = await listSessionPods()
  } catch (err) {
    console.error('[server] restore forwarders: list session pods failed:', err)
    return
  }

  const candidates: RestoreCandidate[] = []
  for (const p of pods) {
    if (!p.running) continue
    if (!p.sessionId || !p.projectSlug || !p.jobName) continue
    if (hasSessionForwarders(p.sessionId)) continue
    if (!(await isTmuxSessionAlive(p.projectSlug, p.sessionId))) continue
    candidates.push({ jobName: p.jobName, projectSlug: p.projectSlug, sessionId: p.sessionId })
  }

  await Promise.allSettled(candidates.map(async ({ jobName, projectSlug, sessionId }) => {
    try {
      const config = await resolveProjectConfig(projectSlug) ?? {}
      await provisionSessionForwarders(projectSlug, sessionId, jobName, config.portForward)
    } catch (err) {
      console.error(
        `[server] restore forwarders for ${sessionId.slice(0, 8)}: `
        + (err instanceof Error ? err.message : String(err)),
      )
    }
  }))
}
