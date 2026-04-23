import { podman } from '@/lib/container/runtime'
import { getDataDir } from '@/lib/project/paths'
import { getSessionStatus, getToolFromContainer } from '@/lib/session/status'
import { isTmuxSessionAlive, cleanupSessionDetached } from '@/lib/session/cleanup'
import { resolveStartingGraceMs } from '@/lib/session/list'
import { isPrewarmSession } from '@/lib/prewarm'
import type { AgentTool } from '@/shared/types'

export interface WaitingSession {
  containerName: string
  sessionId: string
  projectSlug: string
  created: number
  tool: AgentTool
}

export async function getWaitingSessions(
  projectSlug?: string,
  alreadyCleaning?: Set<string>,
): Promise<WaitingSession[]> {
  const filters: Record<string, string[]> = {
    label: [`yaac.data-dir=${getDataDir()}`],
  }
  if (projectSlug) {
    filters.label.push(`yaac.project=${projectSlug}`)
  }

  const containers = await podman.listContainers({ all: true, filters })
  const nowMs = Date.now()
  const graceMs = resolveStartingGraceMs()

  const results: WaitingSession[] = []
  const stale: Array<{ name: string; slug: string; sessionId: string }> = []

  for (const c of containers) {
    const sessionId = c.Labels?.['yaac.session-id'] ?? ''
    const slug = c.Labels?.['yaac.project'] ?? ''
    const name = c.Names?.[0]?.replace(/^\//, '') ?? c.Id

    if (!sessionId || !slug) continue

    if (alreadyCleaning?.has(sessionId)) continue

    // Prewarm lifecycle is owned by ensurePrewarmSession. Skip before the
    // state/tmux checks so a prewarm container still mid-creation (or one
    // whose tmux hasn't come up) doesn't get swept — that would fire
    // cleanupSessionDetached, which awaits removeSessionFromProxy and drops
    // the allowlist for a session that pickNextStreamSession is about to
    // claim, turning the next outbound request into a 403.
    if (await isPrewarmSession(slug, sessionId)) continue

    const running = c.State === 'running' && await isTmuxSessionAlive(name)
    if (!running) {
      // Mirror classifySessionContainers' grace window: session-create's
      // retry loop recreates the container between attempts and does not
      // start tmux until the last step, so a young stopped / tmux-less
      // container is almost certainly mid-creation, not stale.
      const ageMs = typeof c.Created === 'number' ? nowMs - c.Created * 1000 : Infinity
      if (ageMs < graceMs) continue
      stale.push({ name, slug, sessionId })
      continue
    }

    const tool = getToolFromContainer(c)
    const status = await getSessionStatus(slug, sessionId, tool, name)
    if (status !== 'waiting') continue

    results.push({
      containerName: name,
      sessionId,
      projectSlug: slug,
      created: c.Created,
      tool,
    })
  }

  if (stale.length > 0) {
    console.log(`Cleaning up ${stale.length} stale session(s): ${stale.map((s) => s.sessionId.slice(0, 8)).join(', ')}`)
    await Promise.all(stale.map(({ name, slug, sessionId }) =>
      cleanupSessionDetached({ containerName: name, projectSlug: slug, sessionId }),
    ))
  }

  results.sort((a, b) => a.created - b.created)
  return results
}
