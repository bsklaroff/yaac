import { podman } from '@/lib/container/runtime'
import { getDataDir } from '@/lib/project/paths'
import { getSessionStatus, getToolFromContainer } from '@/lib/session/status'
import { isTmuxSessionAlive, cleanupSessionDetached } from '@/lib/session/cleanup'
import { isPrewarmSession } from '@/lib/prewarm'
import type { AgentTool } from '@/types'

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

  const results: WaitingSession[] = []
  const stale: Array<{ name: string; slug: string; sessionId: string }> = []

  for (const c of containers) {
    const sessionId = c.Labels?.['yaac.session-id'] ?? ''
    const slug = c.Labels?.['yaac.project'] ?? ''
    const name = c.Names?.[0]?.replace(/^\//, '') ?? c.Id

    if (!sessionId || !slug) continue

    if (alreadyCleaning?.has(sessionId)) continue

    if (c.State !== 'running') {
      stale.push({ name, slug, sessionId })
      continue
    }

    if (!isTmuxSessionAlive(name)) {
      stale.push({ name, slug, sessionId })
      continue
    }

    if (await isPrewarmSession(slug, sessionId)) continue

    const tool = getToolFromContainer(c)
    const status = await getSessionStatus(slug, sessionId, tool)
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
