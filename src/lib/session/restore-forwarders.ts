/**
 * Daemon-startup pass that rebuilds port forwarders for every live yaac
 * session container. A daemon restart loses the in-memory forwarder
 * registry while containers keep running with stale `status-right` info,
 * so without this pass the tmux bars lie about which ports are
 * actually forwarded.
 */

import { podman } from '@/lib/container/runtime'
import { getDataDir } from '@/lib/project/paths'
import { resolveProjectConfig } from '@/lib/project/config'
import { readPrewarmSessions } from '@/lib/prewarm'
import { isTmuxSessionAlive } from '@/lib/session/cleanup'
import { hasSessionForwarders, provisionSessionForwarders } from '@/lib/session/port-forwarders'

interface RestoreCandidate {
  containerName: string
  projectSlug: string
  sessionId: string
}

export async function restoreAllSessionForwarders(): Promise<void> {
  let containers
  try {
    containers = await podman.listContainers({
      all: true,
      filters: { label: [`yaac.data-dir=${getDataDir()}`] },
    })
  } catch (err) {
    console.error('[daemon] restore forwarders: list containers failed:', err)
    return
  }

  const prewarmData = await readPrewarmSessions()
  const prewarmSessionIds = new Set(Object.values(prewarmData).map((e) => e.sessionId))

  const candidates: RestoreCandidate[] = []
  for (const c of containers) {
    if (c.State !== 'running') continue
    const sessionId = c.Labels?.['yaac.session-id']
    const projectSlug = c.Labels?.['yaac.project']
    if (!sessionId || !projectSlug) continue
    if (prewarmSessionIds.has(sessionId)) continue
    const containerName = c.Names?.[0]?.replace(/^\//, '') ?? c.Id
    if (!containerName) continue
    if (hasSessionForwarders(sessionId)) continue
    if (!isTmuxSessionAlive(containerName)) continue
    candidates.push({ containerName, projectSlug, sessionId })
  }

  await Promise.allSettled(candidates.map(async ({ containerName, projectSlug, sessionId }) => {
    try {
      const config = await resolveProjectConfig(projectSlug) ?? {}
      await provisionSessionForwarders(projectSlug, sessionId, containerName, config.portForward)
    } catch (err) {
      console.error(
        `[daemon] restore forwarders for ${sessionId.slice(0, 8)}: `
        + (err instanceof Error ? err.message : String(err)),
      )
    }
  }))
}
