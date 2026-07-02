import { listSessionPods, isPrewarmed } from '@/lib/k8s/pods'
import { normalizeTool } from '@/lib/session/status'
import { readSessionStatus } from '@/lib/session/status-store'
import { isTmuxSessionAlive, cleanupSessionDetached } from '@/lib/session/cleanup'
import { testEnv } from '@/shared/env'
import type { AgentTool } from '@/shared/types'

export interface WaitingSession {
  jobName: string
  sessionId: string
  projectSlug: string
  /** Pod creation time as epoch ms. */
  createdAtMs: number
  tool: AgentTool
}

export async function getWaitingSessions(
  projectSlug?: string,
  alreadyCleaning?: Set<string>,
): Promise<WaitingSession[]> {
  const pods = await listSessionPods(projectSlug)
  const nowMs = Date.now()
  const graceMs = testEnv.startingGraceMs

  const results: WaitingSession[] = []
  const stale: Array<{ jobName: string; slug: string; sessionId: string }> = []

  for (const p of pods) {
    if (!p.sessionId || !p.projectSlug) continue

    // Prewarmed spares aren't user sessions — keep them out of the stream
    // picker. A stuck spare is reaped by reconcileStaleSessions, not here.
    if (isPrewarmed(p)) continue

    if (alreadyCleaning?.has(p.sessionId)) continue

    const running = p.running && await isTmuxSessionAlive(p.projectSlug, p.sessionId)
    if (!running) {
      // Mirror classifySessionPods' grace window: session-create's retry
      // loop recreates the Job between attempts and does not start tmux
      // until the last step, so a young non-running / tmux-less pod is
      // almost certainly mid-creation, not stale.
      const ageMs = p.createdAtMs > 0 ? nowMs - p.createdAtMs : Infinity
      if (ageMs < graceMs) continue
      stale.push({ jobName: p.jobName, slug: p.projectSlug, sessionId: p.sessionId })
      continue
    }

    const tool = normalizeTool(p.tool)
    // Watcher-fed status (see status-store.ts) — a synchronous read.
    if (readSessionStatus(p.projectSlug, p.sessionId) !== 'waiting') continue

    results.push({
      jobName: p.jobName,
      sessionId: p.sessionId,
      projectSlug: p.projectSlug,
      createdAtMs: p.createdAtMs,
      tool,
    })
  }

  if (stale.length > 0) {
    console.log(`Cleaning up ${stale.length} stale session(s): ${stale.map((s) => s.sessionId.slice(0, 8)).join(', ')}`)
    await Promise.all(stale.map(({ jobName, slug, sessionId }) =>
      cleanupSessionDetached({ jobName, projectSlug: slug, sessionId }),
    ))
  }

  results.sort((a, b) => a.createdAtMs - b.createdAtMs)
  return results
}
