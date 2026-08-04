import { type TickSnapshot, listSessionPods } from '#platform/k8s'
import { classifySessionPods, probeTmuxLiveness } from '#features/status'
import { getAgentSessionFirstMessage } from '#features/agents'
import {
  listAgentSessionsMissingPrompt,
  setAgentSessionCapture,
} from './agent-session-store'
import { testEnv } from '@yaac/shared/env'

/**
 * Fill in each agent session's first user message, read from the transcript
 * its link resolved. Once per conversation, which is what lets every display
 * path read prompts from the DB instead of re-parsing a transcript (or
 * re-probing a container) on every list tick.
 *
 * There is no separate worktree-level capture: a worktree's founding ask *is*
 * its first conversation's opening message, read through that link. That is
 * also what makes it survive a `/clear` — the new conversation is a second
 * row, so the first one's message stays the worktree's label.
 *
 * Driven by the reconciler rather than by a client poll, so the record exists
 * for `worktree list -s` and restart even when nothing is watching. Runs
 * after the agent-session registry on the same tick, so the conversations it
 * captures for are the ones the registry has just discovered.
 */
export async function captureSessionPrompts(snapshot?: TickSnapshot): Promise<void> {
  let pods
  try {
    pods = await (snapshot ? snapshot.pods() : listSessionPods())
  } catch {
    return
  }
  const { running } = await classifySessionPods(
    pods, Date.now(), probeTmuxLiveness, testEnv.startingGraceMs,
  )

  await Promise.all(running.map(async (p) => {
    if (!p.sessionId || !p.projectSlug || !p.jobName) return
    const jobName = p.jobName
    const projectSlug = p.projectSlug
    const worktreeId = p.sessionId
    try {
      for (const link of await listAgentSessionsMissingPrompt(projectSlug, worktreeId)) {
        const prompt = await getAgentSessionFirstMessage(
          link.tool,
          link.transcriptPath,
          jobName,
        )
        // The agent hasn't been prompted yet — nothing to write; next tick
        // retries.
        if (prompt === undefined) continue
        await setAgentSessionCapture(projectSlug, link.tool, link.agentSessionId, {
          firstPrompt: prompt,
        })
      }
    } catch {
      // best-effort — next tick retries
    }
  }))
}
