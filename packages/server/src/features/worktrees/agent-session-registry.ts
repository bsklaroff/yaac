import { isPrewarmed, listWorktreePods, type TickSnapshot } from '#platform/k8s'
import { classifyWorktreePods, liveAgents, podAgentMode, probeTmuxLiveness } from '#features/status'
import {
  normalizeTool,
  readAcpFirstPrompt,
  resolveProjectPath,
  sessionTranscriptPath,
  toProjectRelative,
  transcriptLastActiveMs,
} from '#features/agents'
import { applyHerdEvent } from '#features/records'
import { captureFirstPrompt } from './prompt-capture'
import {
  foldSessionStarts,
  mergeSessions,
  worktreesOnCurrentLife,
  updateWorktreeMeta,
} from './worktree-meta'
import path from 'node:path'
import { acpLogDir } from '@yaac/shared/project-paths'
import { testEnv } from '@yaac/shared/env'
import type { DiscoveredSession } from '@yaac/shared/herd'
import type { AgentMode, AgentTool } from '@yaac/shared/types'

/**
 * Reconcile the agent-session model from what the pods report.
 *
 * Two independent sources, joined here:
 *  - the *history*: every conversation a worktree has hosted. Where it comes
 *    from is the one thing that differs by mode (see below);
 *  - the status watcher's live agent set (`status-store.ts`) — the *present*:
 *    which sessions are running right now, keyed by the driver's handle.
 *
 * A session is active in a worktree when the history names it AND its handle
 * is currently alive.
 *
 * For `tui`, history is the worktree's metadata document, fed by the in-pod
 * hook's session-starts log (`worktree-meta.ts`), and neither source can
 * answer alone: a recorded handle outlives the pane that wrote it (a `/clear`
 * leaves the previous session's handle in place only until the pane is
 * rewritten, and a pane that simply exited leaves a live-looking one behind),
 * and the pane list knows nothing about which session is loaded.
 *
 * For `acp` there is no hook and no document to read, because there is nothing
 * to discover: the server IS the ACP client, so `session/new` hands it the
 * session id directly and the live set carries it. That is a strictly
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
    pods = await (snapshot ? snapshot.pods() : listWorktreePods())
  } catch {
    return
  }
  const { running } = await classifyWorktreePods(
    pods, Date.now(), probeTmuxLiveness, testEnv.startingGraceMs,
  )

  await Promise.all(running.map(async (pod) => {
    if (!pod.worktreeId || !pod.projectSlug) return
    // A prewarmed spare is not a worktree until claimed, and its warm-time
    // agent is not one of the claimant's conversations. Recording it would
    // leave permanently-active links (the status watcher skips spares, so
    // `liveAgentPanes` never corrects them) that a later restart resumes
    // instead of the real conversation — and outlive the reaped spare.
    if (isPrewarmed(pod)) return
    try {
      await reconcileWorktreeAgentSessions(
        pod.projectSlug,
        pod.worktreeId,
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
  // Fold whatever the in-pod hook has appended since last tick into the
  // worktree's document, then read the document back. The hook is the only
  // witness of a user-started session — `/clear`, a hand-typed
  // `claude --resume` — and the document is where the herd remembers it.
  const meta = await foldSessionStarts(projectSlug, worktreeId)
  const sessions = meta?.sessions ?? []
  if (sessions.length === 0) {
    // Nothing recorded yet. That is ambiguous: either the pod predates the
    // hook (its one session is pinned to the worktree id by `--session-id`),
    // or the agent simply has not started — a pod lists as running as soon
    // as its keepalive tmux is up, minutes before the agent window is
    // respawned, so this branch is hit on nearly every fresh create.
    //
    // Only the first case may be recorded, and the pinned transcript
    // existing is the evidence that separates them. Guessing instead would
    // mint a phantom session that never existed, claim ordinal 0, and
    // starve the real one of its founding prompt.
    //
    // opencode is exempt because for it the evidence can never exist: it
    // writes no host transcript and no hook fires for it, so the pin create
    // made is the only account of its session there will ever be, and its
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
    await applyHerdEvent({
      type: 'sessions-discovered',
      projectSlug,
      worktreeId,
      sessions: legacy.map((c) => toReported(projectSlug, c)),
    })
    // Unlike the branch below, this reports the active set without consulting
    // `liveAgents` — safe only because a worktree reaching here has exactly
    // ONE session, the pin, so "all of them" and "the pinned one" are the same
    // list. If opencode ever grows a discoverable id source, or anything else
    // records a second session on such a worktree, this line starts
    // deactivating every session but the pin on each tick — and the set it
    // clobbers is the frozen one a restart reads back. Anything that makes a
    // second session reachable here must join against the live set first.
    await applyHerdEvent({
      type: 'sessions-active',
      projectSlug,
      worktreeId,
      active: legacy.map((c) => ({ tool: c.tool, agentSessionId: c.agentSessionId })),
    })
    return
  }

  // Opening messages are read once per session per herd life and folded back
  // into the document, so a settled worktree costs one file read a tick.
  const withPrompts = await Promise.all(sessions.map(async (s) => {
    if (s.firstPrompt !== undefined) return s
    const firstPrompt = await captureFirstPrompt(
      projectSlug,
      s.tool,
      s.agentSessionId,
      s.transcriptPath === undefined
        ? undefined
        : resolveProjectPath(projectSlug, s.transcriptPath),
      jobName,
    )
    return firstPrompt !== undefined ? { ...s, firstPrompt } : s
  }))
  if (withPrompts.some((s, i) => s !== sessions[i])) {
    await updateWorktreeMeta(projectSlug, worktreeId, (current) =>
      current === undefined ? undefined : mergeSessions(current, withPrompts, Date.now()))
  }

  await applyHerdEvent({
    type: 'sessions-discovered',
    projectSlug,
    worktreeId,
    sessions: withPrompts.map((s) => ({
      tool: s.tool,
      agentSessionId: s.agentSessionId,
      mode: s.mode,
      firstSeenMs: s.firstSeenMs,
      ...(s.transcriptPath !== undefined ? { transcriptPath: s.transcriptPath } : {}),
      ...(s.firstPrompt !== undefined ? { firstPrompt: s.firstPrompt } : {}),
    })),
  })

  // Intersect the recorded handles with what the status watcher can see. When
  // the watcher has no live set yet (a pod whose connection hasn't attached),
  // leave the active set alone rather than blanking it — a transient stream
  // gap must never look like "every agent exited".
  const observed = liveAgents(projectSlug, worktreeId)
  if (observed === undefined) return
  const handles = new Set(observed.map((a) => a.handle))
  // Only handles from the current life count: tmux pane ids restart at %0, so
  // one recorded by the previous life would name a pane this life owns.
  const live = (meta === undefined ? [] : worktreesOnCurrentLife(meta))
    .filter((s) => s.handle !== undefined && handles.has(s.handle))
    .map((s) => ({ tool: s.tool, agentSessionId: s.agentSessionId, paneId: s.handle as string }))
  await applyHerdEvent({ type: 'sessions-active', projectSlug, worktreeId, active: live })
}

/**
 * The form a session crosses the boundary in: its transcript path made
 * project-relative.
 *
 * The herd works in absolute paths — it stats transcripts and hands them to
 * parsers — but it must not report one. An absolute path names a place on the
 * herd's own machine, which the server can neither resolve nor meaningfully
 * store once the two are separate processes, and storing one would pin the row
 * to the data dir that wrote it. So the conversion happens here, at the last
 * moment before the event, rather than at every site that produced a path.
 *
 * A path with no relative form is dropped rather than sent absolute: the
 * session is still real, only its transcript is unaddressable, which is the
 * same verdict the in-pod hook reaches when it records an empty path.
 */
function toReported(
  projectSlug: string,
  session: DiscoveredSession,
): DiscoveredSession {
  if (session.transcriptPath === undefined) return session
  const rel = toProjectRelative(projectSlug, session.transcriptPath)
  const { transcriptPath: _absolute, ...rest } = session
  return rel === null ? rest : { ...rest, transcriptPath: rel }
}

/**
 * Add the session's opening message, when this herd has not read it yet.
 * Folded into the sweep rather than run as a pass of its own: the sweep has
 * just resolved the transcript, and the alternative — asking the server which
 * conversations still lack a prompt — is the row read this whole exercise is
 * removing. The server's write is fill-only, so re-reporting one it already
 * has costs nothing and cannot overwrite a create-time prompt.
 */
async function withFirstPrompt(
  conversation: DiscoveredSession,
  projectSlug: string,
  jobName: string | undefined,
): Promise<DiscoveredSession> {
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
  // Through the same conversion the tui branch uses: `sessionTranscriptPath`
  // hands back an absolute path, and an absolute path must never cross the
  // boundary — it names a place on the herd's machine and re-pins the row to
  // this data dir.
  const reported = live.map((c) => toReported(projectSlug, c))
  if (reported.length > 0) {
    await applyHerdEvent({
      type: 'sessions-discovered', projectSlug, worktreeId, sessions: reported,
    })
  }
  await applyHerdEvent({
    type: 'sessions-active',
    projectSlug,
    worktreeId,
    active: live.map((c) => ({
      tool: c.tool, agentSessionId: c.agentSessionId, paneId: c.paneId,
    })),
  })
}
