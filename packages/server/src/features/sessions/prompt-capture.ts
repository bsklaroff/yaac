import { listSessionPods } from '#platform/k8s/pods'
import { classifySessionPods } from '#features/sessions/classify'
import { probeTmuxLiveness } from '#features/sessions/cleanup'
import { getSessionFirstMessage, normalizeTool } from '#features/sessions/state'
import {
  listSessionsMissingCapture,
  setSessionCapture,
  type SessionCaptureNeed,
} from '#features/sessions/store'
import { sessionTranscriptPath } from '#features/sessions/transcripts'
import type { TickSnapshot } from '#platform/k8s/tick-snapshot'
import { testEnv } from '@yaac/shared/env'

/**
 * Fill in what a session row can only learn from the running container:
 * its first user message, and the path of the transcript the agent is
 * writing. Both happen once per session, which is what lets every display
 * path read the prompt from the DB instead of re-parsing a transcript (or
 * re-probing a container) on every list tick.
 *
 * Driven by the reconciler rather than by a client poll, so the record
 * exists for `session list -d` and restart even when nothing is watching.
 * A session that already has its prompt (created with one) is still
 * visited until its transcript path is stamped — the deleted listing stats
 * that path for last-activity, and without it a session reports its
 * creation time as last activity forever.
 */
export async function captureSessionPrompts(snapshot?: TickSnapshot): Promise<void> {
  const pending = await listSessionsMissingCapture().catch((): SessionCaptureNeed[] => [])
  if (pending.length === 0) return

  let pods
  try {
    pods = await (snapshot ? snapshot.pods() : listSessionPods())
  } catch {
    return
  }
  const { running } = await classifySessionPods(
    pods, Date.now(), probeTmuxLiveness, testEnv.startingGraceMs,
  )
  const wanted = new Map(pending.map((r) => [`${r.projectSlug}/${r.sessionId}`, r]))

  await Promise.all(running.map(async (p) => {
    if (!p.sessionId || !p.projectSlug || !p.jobName) return
    const need = wanted.get(`${p.projectSlug}/${p.sessionId}`)
    if (!need) return
    const tool = normalizeTool(p.tool)
    try {
      // Only what's missing: a stored prompt is the ask the session was
      // created with, and must not be replaced by whatever the transcript
      // happens to start with now.
      const [prompt, transcriptPath] = await Promise.all([
        need.needsPrompt
          ? getSessionFirstMessage(p.projectSlug, p.sessionId, tool, p.jobName)
          : undefined,
        need.needsTranscriptPath
          ? sessionTranscriptPath(p.projectSlug, p.sessionId, tool)
          : undefined,
      ])
      // Nothing learned yet — the agent hasn't been prompted, so it has
      // written no transcript either. Next tick retries.
      if (prompt === undefined && transcriptPath === undefined) return
      await setSessionCapture(p.projectSlug, p.sessionId, {
        ...(prompt !== undefined ? { prompt } : {}),
        ...(transcriptPath !== undefined ? { transcriptPath } : {}),
      })
    } catch {
      // best-effort — next tick retries
    }
  }))
}
