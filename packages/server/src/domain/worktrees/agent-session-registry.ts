import { isPrewarmed, listWorktreePods, type TickSnapshot } from '#platform/k8s'
import { classifyWorktreePods, liveAgents, podAgentMode, probeTmuxLiveness } from '#runtime/status'
import { normalizeTool, readAcpFirstPrompt } from '#runtime/agents'
import { sessionTranscriptPath, toProjectRelative, transcriptLastActiveMs } from '#store/transcripts'
import {
  applyWorktreeEvent,
  getWorktreeRow,
  listWorktreeAgentSessions,
  setAgentSessionCapture,
} from '#records'
import { captureFirstPrompt } from './prompt-capture'
import { readSessionStarts, type SessionStartSighting } from '#store/worktrees'
import path from 'node:path'
import { acpLogDir } from '@yaac/shared/project-paths'
import { testEnv } from '@yaac/shared/env'
import { serverLog } from '#log'
import type { DiscoveredSession } from '#records'
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
 * For `tui`, history comes from the in-pod hook's session-starts log
 * (`#store/worktrees`), folded into the worktree's rows and read back from
 * them; neither source can answer alone: a recorded handle outlives the pane
 * that wrote it (a `/clear` leaves the previous session's handle in place
 * only until the pane is rewritten, and a pane that simply exited leaves a
 * live-looking one behind), and the pane list knows nothing about which
 * session is loaded.
 *
 * For `acp` there is no hook and no log to read, because there is nothing to
 * discover: the server IS the ACP client, so `session/new` hands it the
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
  // A warming spare's conversations are not a worktree's: its agent is
  // pinned to its own id and belongs to nobody until the pod is claimed.
  // `reconcileAgentSessions` already skips prewarmed pods; this is the same
  // refusal for the create path, which calls in directly.
  const row = await getWorktreeRow(projectSlug, worktreeId)
  if (row?.spare === true) return

  // Fold whatever the in-pod hook has appended into rows. The hook is the
  // only witness of a user-started session — `/clear`, a hand-typed
  // `claude --resume` — and the rows are where the server remembers it.
  //
  // Only what the fold actually saw is reported: a session it did not sight
  // this tick has simply not moved, and naming it here would clear the pane
  // a previous fold recorded for it.
  //
  // The offset is read here and applied below, and a restart's
  // `recordWorktreeLife` can commit in between — in which case handles
  // computed against the previous life's boundary are written back after the
  // transaction that nulled them. The pane heals itself within a tick: the
  // next fold re-reads the row, those lines now fall below the new boundary,
  // and the conflict-set nulls the pane again.
  //
  // The residual is not quite zero, though, and it is why this is a comment
  // rather than a lock. `recordWorktreeLife` clears `paneId`, not `active`,
  // and `active` is what a restart resumes — so a worktree that stops inside
  // the window freezes one conversation too many and comes back with an extra
  // window. That conversation is real history rather than a phantom, so the
  // cost is an unasked-for window, not a wrong one.
  const boundary = row?.lifeLogBytes ?? 0
  const { sightings, sizeBytes } = await readSessionStarts(projectSlug, worktreeId)
  // A log SHORTER than the boundary recorded into it. Nothing yaac does can
  // produce that — the log is only ever appended to — so it means something
  // outside replaced or rotated it, and the failure is otherwise silent:
  // every line falls below the boundary, loses its handle, and the worktree
  // reports no live agents until its next restart. Strictly `<`: a boundary
  // equal to the size is the ordinary state of a pod that has not appended
  // yet, which is every restarted worktree until its hook first fires.
  if (sizeBytes < boundary) {
    serverLog(
      `[agent-sessions] ${projectSlug}/${worktreeId}: session-starts log is ${sizeBytes} `
      + `bytes, shorter than the recorded life boundary (${boundary}); handles will be `
      + 'dropped until the next restart',
    )
  }
  const sighted = foldSightings(sightings, boundary)
  if (sighted.length > 0) {
    await applyWorktreeEvent({
      type: 'sessions-discovered', projectSlug, worktreeId, sessions: sighted,
    })
  }

  // The worktree's whole history, as records now holds it — the hook's
  // sightings plus whatever create recorded for a conversation no hook ever
  // fires for.
  const links = await listWorktreeAgentSessions(projectSlug, worktreeId)
  if (links.length === 0) {
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
    await applyWorktreeEvent({
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
    await applyWorktreeEvent({
      type: 'sessions-active',
      projectSlug,
      worktreeId,
      active: legacy.map((c) => ({ tool: c.tool, agentSessionId: c.agentSessionId })),
    })
    return
  }

  // Opening messages are read once per conversation per server life — the row
  // remembers the answer — so a settled worktree costs one file read a tick.
  // Written straight to the conversation rather than reported as a discovery:
  // this adds a fact to a row that already exists, and a whole re-report would
  // have to carry every conversation's pane back with it just to avoid
  // clearing them.
  await Promise.all(links.map(async (l) => {
    if (l.firstPrompt !== undefined) return
    const firstPrompt = await captureFirstPrompt(
      projectSlug, l.tool, l.agentSessionId, l.transcriptPath, jobName,
    )
    if (firstPrompt === undefined) return
    await setAgentSessionCapture(projectSlug, l.tool, l.agentSessionId, { firstPrompt })
  }))

  // Intersect the recorded handles with what the status watcher can see. When
  // the watcher has no live set yet (a pod whose connection hasn't attached),
  // leave the active set alone rather than blanking it — a transient stream
  // gap must never look like "every agent exited".
  const observed = liveAgents(projectSlug, worktreeId)
  if (observed === undefined) return
  const handles = new Set(observed.map((a) => a.handle))
  // Every recorded handle belongs to the current life: the life that started
  // this pod cleared the previous one's in the same transaction that stamped
  // it, so a pane id still on a row was seen by this pod. tmux pane ids
  // restart at %0, which is what makes that necessary. The one gap is a life
  // stamped between this tick's offset read and its fold — see above; it
  // costs a tick, not a wrong freeze.
  const live = links
    .filter((l) => l.paneId !== undefined && handles.has(l.paneId))
    .map((l) => ({ tool: l.tool, agentSessionId: l.agentSessionId, paneId: l.paneId as string }))
  await applyWorktreeEvent({ type: 'sessions-active', projectSlug, worktreeId, active: live })
}

/**
 * Collapse the log's lines into one sighting per conversation, in first-seen
 * order — which is the order `recordAgentSessions` assigns ordinals in, and
 * so the order a restart brings windows back up in.
 *
 * A line below `lifeLogBytes` was appended by a previous pod. It still proves
 * the conversation exists and still names its transcript, but its pane
 * belongs to a pod that is gone — and tmux pane ids restart at `%0`, so
 * carrying that handle forward would attribute a dead conversation to
 * whichever live pane inherited its number. Drop the handle, keep the
 * conversation.
 *
 * Later lines fill and overwrite in the one direction that makes sense: a
 * transcript path and a pane say where the conversation is *now*, and a line
 * that mentions neither leaves both alone.
 */
function foldSightings(
  sightings: SessionStartSighting[],
  lifeLogBytes: number,
): DiscoveredSession[] {
  const byConversation = new Map<string, DiscoveredSession>()
  for (const s of sightings) {
    const key = `${s.tool}/${s.agentSessionId}`
    const prev = byConversation.get(key)
    const handle = s.atByte >= lifeLogBytes ? s.handle : undefined
    byConversation.set(key, {
      tool: s.tool,
      agentSessionId: s.agentSessionId,
      ...prev,
      ...(s.transcriptPath !== undefined ? { transcriptPath: s.transcriptPath } : {}),
      ...(handle !== undefined ? { paneId: handle } : {}),
    })
  }
  return [...byConversation.values()]
}

/**
 * The form a session crosses the boundary in: its transcript path made
 * project-relative.
 *
 * The sweep works in absolute paths — it stats transcripts and hands them to
 * parsers — but it must not report one. An absolute path names a place on the
 * data dir that wrote it, which a restored backup or a moved data dir
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
 * Add the session's opening message, when this server has not read it yet.
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
  // convention — it names one machine's layout and re-pins the row to
  // this data dir.
  const reported = live.map((c) => toReported(projectSlug, c))
  if (reported.length > 0) {
    await applyWorktreeEvent({
      type: 'sessions-discovered', projectSlug, worktreeId, sessions: reported,
    })
  }
  await applyWorktreeEvent({
    type: 'sessions-active',
    projectSlug,
    worktreeId,
    active: live.map((c) => ({
      tool: c.tool, agentSessionId: c.agentSessionId, paneId: c.paneId,
    })),
  })
}
