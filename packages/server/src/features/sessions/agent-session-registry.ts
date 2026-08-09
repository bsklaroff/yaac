import { isPrewarmed, listSessionPods, type TickSnapshot } from '#platform/k8s'
import { classifySessionPods, liveAgents, podAgentMode, probeTmuxLiveness } from '#features/status'
import {
  normalizeTool,
  readAcpFirstPrompt,
  readAllWorktreeLinks,
  sessionTranscriptPath,
  transcriptLastActiveMs,
  type AgentSessionLink,
} from '#features/agents'
import { serverLink } from '#server-link'
import { captureFirstPrompt } from './prompt-capture'
import path from 'node:path'
import { acpLogDir } from '@yaac/shared/project-paths'
import { testEnv } from '@yaac/shared/env'
import type { DiscoveredConversation } from '@yaac/shared/herd'
import type { AgentMode, AgentTool } from '@yaac/shared/types'

/**
 * Reconcile the agent-session model from what the pods report.
 *
 * Two independent sources, joined here:
 *  - the *history*: every conversation a worktree has hosted. Where it comes
 *    from is the one thing that differs by mode (see below);
 *  - the status watcher's live agent set (`status-store.ts`) — the *present*:
 *    which conversations are running right now, keyed by the driver's handle.
 *
 * A conversation is active in a worktree when the history names it AND its
 * handle is currently alive.
 *
 * For `tui`, history is the in-pod hook's link tree (`agent-links.ts`), and
 * neither source can answer alone: the pointers outlive the pane that wrote
 * them (a `/clear` leaves the previous conversation's pointer in place only
 * until the pane is rewritten, but a pane that simply exited leaves a
 * live-looking pointer behind), and the pane list knows nothing about which
 * conversation is loaded.
 *
 * For `acp` there is no hook and no link tree, because there is nothing to
 * discover: the server IS the ACP client, so `session/new` hands it the
 * conversation id directly and the live set carries it. That is a strictly
 * simpler path — the mode replaces a whole discovery mechanism with a return
 * value — and it is why the two branches below look so different in length.
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
        podAgentMode(pod),
        pod.jobName,
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
  mode: AgentMode = 'tui',
  jobName?: string,
): Promise<void> {
  if (mode === 'acp') {
    await reconcileAcpAgentSessions(projectSlug, worktreeId)
    return
  }
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
    //
    // opencode is exempt because for it the evidence can never exist: it
    // writes no host transcript and has no link tree, so the pin create made
    // is the only account of its conversation there will ever be, and its
    // opening message has to be probed out of the pod.
    const pinned = await sessionTranscriptPath(projectSlug, worktreeId, tool)
    if (pinned === undefined && tool !== 'opencode') return
    const legacy = [await withFirstPrompt(
      {
        tool,
        agentSessionId: worktreeId,
        ...(pinned !== undefined ? { transcriptPath: pinned } : {}),
      },
      projectSlug,
      jobName,
    )]
    await serverLink().workspaceEvent({
      type: 'conversations-discovered', projectSlug, worktreeId, conversations: legacy,
    })
    // Unlike the link-tree branch below, this reports the active set without
    // consulting `liveAgents` — safe only because a worktree reaching here has
    // exactly ONE conversation, the pin, so "all of them" and "the pinned one"
    // are the same list. If opencode ever grows a discoverable id source, or
    // anything else links a second conversation to such a worktree, this line
    // starts deactivating every conversation but the pin on each tick — and
    // the set it clobbers is the frozen one a restart reads back. Anything
    // that makes a second conversation reachable here must join against the
    // live set first.
    await serverLink().workspaceEvent({
      type: 'conversations-active',
      projectSlug,
      worktreeId,
      active: legacy.map((c) => ({ tool: c.tool, agentSessionId: c.agentSessionId })),
    })
    return
  }

  await serverLink().workspaceEvent({
    type: 'conversations-discovered',
    projectSlug,
    worktreeId,
    conversations: await Promise.all(
      links.map((l) => withFirstPrompt(toDiscovered(l), projectSlug, jobName)),
    ),
  })

  // Intersect the pointers with the conversations the status watcher can see.
  // When the watcher has no live set yet (a pod whose connection hasn't
  // attached), leave the active set alone rather than blanking it — a
  // transient stream gap must never look like "every agent exited".
  const observed = liveAgents(projectSlug, worktreeId)
  if (observed === undefined) return
  const handles = new Set(observed.map((a) => a.handle))
  const live = links
    .map((l) => ({
      tool: l.tool as AgentTool,
      agentSessionId: l.agentSessionId,
      paneId: l.paneIds.find((p) => handles.has(p)),
    }))
    .filter((l): l is { tool: AgentTool; agentSessionId: string; paneId: string } =>
      l.paneId !== undefined)
  await serverLink().workspaceEvent({ type: 'conversations-active', projectSlug, worktreeId, active: live })
}

/**
 * Add the conversation's opening message, when this herd has not read it yet.
 * Folded into the sweep rather than run as a pass of its own: the sweep has
 * just resolved the transcript, and the alternative — asking the server which
 * conversations still lack a prompt — is the row read this whole exercise is
 * removing. The server's write is fill-only, so re-reporting one it already
 * has costs nothing and cannot overwrite a create-time prompt.
 */
async function withFirstPrompt(
  conversation: DiscoveredConversation,
  projectSlug: string,
  jobName: string | undefined,
): Promise<DiscoveredConversation> {
  if (conversation.firstPrompt !== undefined) return conversation
  const firstPrompt = await captureFirstPrompt(
    projectSlug,
    conversation.tool,
    conversation.agentSessionId,
    conversation.transcriptPath,
    jobName,
  )
  return firstPrompt !== undefined ? { ...conversation, firstPrompt } : conversation
}

/**
 * The `acp` branch: the live set already carries each conversation's id, so
 * there is nothing to join against and nothing to discover. A conversation
 * appears here the moment the ACP handshake produces its id, which is what
 * makes the row exist for the restart path and the webapp's pane list.
 *
 * A conversation whose handshake hasn't landed yet has no id and is skipped —
 * recording it under its handle would mint a phantom the real one could never
 * displace.
 */
async function reconcileAcpAgentSessions(
  projectSlug: string,
  worktreeId: string,
): Promise<void> {
  const observed = liveAgents(projectSlug, worktreeId)
  if (observed === undefined) return
  const live = await Promise.all(
    observed
      .filter((a) => a.agentSessionId !== undefined)
      .map(async (a) => {
        const agentSessionId = a.agentSessionId as string
        // The ACP adapter is the tool's own SDK under a different front end, so
        // where it leaves a transcript it leaves it where the TUI would. Naming
        // it here is what gives an ACP conversation a last-activity time and
        // keeps it legible to every path that reads transcripts — the stopped
        // listing above all, which outlives the pod and so cannot ask the
        // conversation anything. Resolution is best-effort: a conversation with
        // no locatable transcript records none and loses only that timestamp.
        const transcriptPath = await sessionTranscriptPath(projectSlug, agentSessionId, a.tool)
        const lastActiveMs = transcriptPath !== undefined
          ? await transcriptLastActiveMs(transcriptPath)
          : undefined
        // The opening message, from the record rather than a live conversation:
        // the record is on disk whether or not anything is attached, so a
        // worktree can be labelled without one.
        const firstPrompt = await readAcpFirstPrompt(
          path.join(acpLogDir(projectSlug, worktreeId), `${agentSessionId}.jsonl`),
        )
        return {
          tool: a.tool,
          agentSessionId,
          paneId: a.handle,
          mode: 'acp' as const,
          ...(firstPrompt !== undefined ? { firstPrompt } : {}),
          ...(transcriptPath !== undefined ? { transcriptPath } : {}),
          ...(lastActiveMs !== undefined ? { lastActiveMs } : {}),
        }
      }),
  )
  if (live.length > 0) {
    await serverLink().workspaceEvent({
      type: 'conversations-discovered', projectSlug, worktreeId, conversations: live,
    })
  }
  await serverLink().workspaceEvent({
    type: 'conversations-active',
    projectSlug,
    worktreeId,
    active: live.map((c) => ({
      tool: c.tool, agentSessionId: c.agentSessionId, paneId: c.paneId,
    })),
  })
}

function toDiscovered(link: AgentSessionLink): DiscoveredConversation {
  return {
    tool: link.tool,
    agentSessionId: link.agentSessionId,
    firstSeenMs: link.firstSeenMs,
    ...(link.transcriptPath !== undefined ? { transcriptPath: link.transcriptPath } : {}),
    ...(link.lastActiveMs !== undefined ? { lastActiveMs: link.lastActiveMs } : {}),
    ...(link.paneIds[0] !== undefined ? { paneId: link.paneIds[0] } : {}),
  }
}
