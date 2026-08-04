import { isPrewarmed, listSessionPods, type TickSnapshot } from '#platform/k8s'
import { classifySessionPods } from '#features/sessions/classify'
import { probeTmuxLiveness } from '#features/sessions/cleanup'
import { readAllWorktreeLinks, type AgentSessionLink } from '#features/sessions/agent-links'
import {
  recordAgentSessions,
  setActiveAgentSessions,
  type DiscoveredAgentSession,
} from '#features/sessions/agent-session-store'
import { liveAgentPanes } from '#features/sessions/status-store'
import { normalizeTool } from '#features/sessions/state'
import { sessionTranscriptPath } from '#features/sessions/transcripts'
import { testEnv } from '@yaac/shared/env'
import type { AgentTool } from '@yaac/shared/types'

/**
 * Reconcile the agent-session model from what the pods report.
 *
 * Two independent sources, joined here:
 *  - the in-pod hook's link tree (`agent-links.ts`) — the *history*: every
 *    conversation a worktree has hosted, readable even after the pod is gone;
 *  - the status watcher's live pane set (`status-store.ts`) — the *present*:
 *    which panes are running an agent right now.
 *
 * A conversation is active in a worktree when a pane pointer names it AND
 * that pane is currently alive. Neither source can answer that alone: the
 * pointers outlive the pane that wrote them (a `/clear` leaves the previous
 * conversation's pointer in place only until the pane is rewritten, but a
 * pane that simply exited leaves a live-looking pointer behind), and the pane
 * list knows nothing about which conversation is loaded.
 *
 * Runs on the reconciler tick, like prompt capture, so the record exists for
 * `worktree list` and restart even when no client is watching. Only running
 * worktrees are visited: a stopped worktree's active set is frozen, and it is
 * exactly what its restart reads back.
 */
export async function reconcileAgentSessions(snapshot?: TickSnapshot): Promise<void> {
  let pods
  try {
    pods = await (snapshot ? snapshot.pods() : listSessionPods())
  } catch {
    return
  }
  const { running } = await classifySessionPods(
    pods, Date.now(), probeTmuxLiveness, testEnv.startingGraceMs,
  )

  await Promise.all(running.map(async (pod) => {
    if (!pod.sessionId || !pod.projectSlug) return
    // A prewarmed spare is not a worktree until claimed, and its warm-time
    // agent is not one of the claimant's conversations. Recording it would
    // leave permanently-active links (the status watcher skips spares, so
    // `liveAgentPanes` never corrects them) that a later restart resumes
    // instead of the real conversation — and outlive the reaped spare.
    if (isPrewarmed(pod)) return
    try {
      await reconcileWorktreeAgentSessions(
        pod.projectSlug,
        pod.sessionId,
        normalizeTool(pod.tool),
      )
    } catch {
      // best-effort — next tick retries
    }
  }))
}

/**
 * One worktree's reconcile. Split out so the create path can run it as soon
 * as a session's first agent lands, rather than waiting a tick.
 */
export async function reconcileWorktreeAgentSessions(
  projectSlug: string,
  worktreeId: string,
  tool: AgentTool,
): Promise<void> {
  const links = await readAllWorktreeLinks(projectSlug, worktreeId)
  if (links.length === 0) {
    // No link tree yet. That is ambiguous: either the pod predates the hook
    // (its one conversation is pinned to the worktree id by `--session-id`),
    // or the agent simply has not started — a pod lists as running as soon
    // as its keepalive tmux is up, minutes before the agent window is
    // respawned, so this branch is hit on nearly every fresh create.
    //
    // Only the first case may be recorded, and the pinned transcript
    // existing is the evidence that separates them. Guessing instead would
    // mint a phantom conversation that never existed, claim ordinal 0, and
    // starve the real one of its founding prompt.
    const pinned = await sessionTranscriptPath(projectSlug, worktreeId, tool)
    if (pinned === undefined) return
    const legacy = [{ tool, agentSessionId: worktreeId, transcriptPath: pinned }]
    await recordAgentSessions(projectSlug, worktreeId, legacy)
    await setActiveAgentSessions(projectSlug, worktreeId, legacy)
    return
  }

  await recordAgentSessions(projectSlug, worktreeId, links.map(toDiscovered))

  // Intersect the pointers with the panes the status watcher can see. When
  // the watcher has no pane list yet (a pod whose control stream hasn't
  // attached), leave the active set alone rather than blanking it — a
  // transient stream gap must never look like "every agent exited".
  const panes = liveAgentPanes(projectSlug, worktreeId)
  if (panes === undefined) return
  const live = links
    .map((l) => ({
      tool: l.tool as AgentTool,
      agentSessionId: l.agentSessionId,
      paneId: l.paneIds.find((p) => panes.has(p)),
    }))
    .filter((l): l is { tool: AgentTool; agentSessionId: string; paneId: string } =>
      l.paneId !== undefined)
  await setActiveAgentSessions(projectSlug, worktreeId, live)
}

function toDiscovered(link: AgentSessionLink): DiscoveredAgentSession {
  return {
    tool: link.tool,
    agentSessionId: link.agentSessionId,
    firstSeenMs: link.firstSeenMs,
    ...(link.transcriptPath !== undefined ? { transcriptPath: link.transcriptPath } : {}),
    ...(link.lastActiveMs !== undefined ? { lastActiveMs: link.lastActiveMs } : {}),
    ...(link.paneIds[0] !== undefined ? { paneId: link.paneIds[0] } : {}),
  }
}
