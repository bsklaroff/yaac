import { listSessionPods } from '#platform/k8s'
import { isTmuxSessionAlive } from '#features/status'
import { resolveProjectConfig } from '#features/projects'
import { hasSessionForwarders, provisionSessionForwarders } from './port-forwarders'

interface RestoreCandidate {
  jobName: string
  projectSlug: string
  sessionId: string
}

/**
 * Rebuild port forwarders for every live session pod.
 *
 * The forwarder registry is in-memory, so a server restart loses it while the
 * pods keep running with a tmux `status-right` still advertising ports that
 * are no longer forwarded. Without this pass the bars lie. Run once as the
 * herd attaches, before it serves anything.
 *
 * Every step is skipped rather than retried: a pod that isn't running, one
 * that already has forwarders (nothing was lost), and one whose tmux is gone
 * (the reaper's business, not this pass's).
 */
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
