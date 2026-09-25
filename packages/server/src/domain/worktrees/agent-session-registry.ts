import { worktreeDriver } from '#drivers/driver'
import type { RuntimeSnapshot } from '#drivers/contract'
import { classifyWorkspaces, liveAgents, probeTmuxLiveness } from '#runtime/status'
import {
  findCodexRollouts,
  getCodexPermissionMode,
  readAcpFirstPrompt,
  resolveAgentPermissionMode,
  sessionTranscriptPath,
  toProjectRelative,
  transcriptLastActiveMs,
} from '#runtime/agents'
import {
  applyWorktreeEvent,
  getWorktreeRow,
  listWorktreeAgentSessions,
  setAgentSessionCapture,
} from '#db'
import { absoluteTranscriptPath } from './agent-session-paths'
import { captureFirstPrompt } from './prompt-capture'
import { readSessionStarts, type SessionStartSighting } from './session-starts'
import path from 'node:path'
import { acpLogDir, codexDir, worktreeDir } from '@yaac/shared/project-paths'
import { testEnv } from '@yaac/shared/env'
import { serverLog } from '#log'
import type { AgentSessionLinkRow, DiscoveredSession, WorktreeRow } from '#db'
import type { LiveAgent } from '#runtime/agents'
import type { AgentMode, AgentTool, PermissionMode } from '@yaac/shared/types'

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
 * (`./session-starts`), folded into the worktree's rows and read back from
 * them; neither source can answer alone: a recorded handle outlives the pane
 * that wrote it (a `/clear` leaves the previous session's handle in place
 * only until the pane is rewritten, and a pane that simply exited leaves a
 * live-looking one behind), and the pane list knows nothing about which
 * session is loaded. codex under containerless runs no hook, so its history
 * is read off its rollouts instead (`discoverCodexSessions`).
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
export async function reconcileAgentSessions(snapshot?: RuntimeSnapshot): Promise<void> {
  let pods
  try {
    pods = await (snapshot ?? worktreeDriver().snapshot()).workspaces()
  } catch {
    return
  }
  const { running } = await classifyWorkspaces(
    pods, Date.now(), probeTmuxLiveness, testEnv.startingGraceMs,
  )

  await Promise.all(running.map(async (pod) => {
    if (!pod.workspaceId || !pod.projectSlug) return
    // A prewarmed spare is not a worktree until claimed, and its warm-time
    // agent is not one of the claimant's conversations. Recording it would
    // leave permanently-active links (the status watcher skips spares, so
    // `liveAgentPanes` never corrects them) that a later restart resumes
    // instead of the real conversation — and outlive the reaped spare.
    if (pod.prewarmed) return
    try {
      await reconcileWorktreeAgentSessions(
        pod.projectSlug,
        pod.workspaceId,
        pod.tool,
        pod.mode,
        pod.jobName,
      )
    } catch {
      // best-effort — next tick retries
    }
  }))
}

/**
 * One last pass over a worktree about to be torn down, while its agents are
 * still live. A pass runs on a change to the live set or on the resync, and
 * neither follows what an agent writes: a codex turn opening a rollout, a
 * hook's sighting of a `/clear`. A teardown freezes the active set the rows
 * hold at that moment, so without this a conversation begun within a resync
 * of a stop is not the one a restart resumes — and a codex one found by its
 * rollout, which then predates the next life, is never found again.
 * Best-effort: a stop must not fail on it.
 */
export async function reconcileBeforeTeardown(worktreeId: string): Promise<void> {
  try {
    const live = await worktreeDriver().find(worktreeId)
    if (live === undefined || live.prewarmed) return
    await reconcileWorktreeAgentSessions(live.projectSlug, live.workspaceId, live.tool, live.mode, live.jobName)
  } catch (err) {
    serverLog(`[agent-sessions] ${worktreeId}: sweep before teardown failed: ${String(err)}`)
  }
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
  // Ahead of the history, because a pane reports its posture whether or not
  // any conversation on it has been recorded yet.
  await followReportedModes(projectSlug, worktreeId, 'tui', row, liveAgents(projectSlug, worktreeId))

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

  // Where no hook runs for codex, its conversations are found on disk instead
  // and reported the same way.
  if (row !== undefined && worktreeDriver().kind === 'containerless') {
    await discoverCodexSessions(projectSlug, worktreeId, row)
  }

  // The worktree's whole history, as db now holds it — the hook's
  // sightings plus whatever create recorded for a conversation no hook ever
  // fires for.
  const links = await listWorktreeAgentSessions(projectSlug, worktreeId)
  if (row !== undefined) await followRolloutModes(projectSlug, worktreeId, row, links)
  if (links.length === 0) {
    // Nothing recorded yet. That is ambiguous: either the agent is running
    // its one pinned session and no hook has reported it (the pin is the
    // worktree id, via `--session-id`), or the agent simply has not started
    // — a pod lists as running as soon as its keepalive tmux is up, minutes
    // before the agent window is respawned, so this branch is hit on nearly
    // every fresh create.
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
    // The pin is the only conversation there is, so the pane of its tool is
    // its pane, and that pane's model is its model.
    const model = liveAgents(projectSlug, worktreeId)?.find((a) => a.tool === tool)?.model
    const pinnedOnly = [await withFirstPrompt(
      {
        tool,
        agentSessionId: worktreeId,
        ...(pinned !== undefined ? { transcriptPath: pinned } : {}),
        ...(model !== undefined ? { model } : {}),
      },
      projectSlug,
      jobName,
    )]
    await applyWorktreeEvent({
      type: 'sessions-discovered',
      projectSlug,
      worktreeId,
      sessions: pinnedOnly.map((c) => toReported(projectSlug, c)),
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
      active: pinnedOnly.map((c) => ({ tool: c.tool, agentSessionId: c.agentSessionId })),
    })
    return
  }

  // Opening messages are read once per conversation per server life — the row
  // remembers the answer — so a settled worktree costs one file read a tick.
  // Written straight to the conversation rather than reported as a discovery:
  // this adds a fact to a row that already exists, and a whole re-report would
  // have to carry every conversation's pane back with it just to avoid
  // clearing them.
  //
  // The model is not read at all: each live pane carries the one its tool
  // last reported (see `LiveAgent.model`), and a switch arrives as a change to
  // the live set, which is what triggers this pass. It belongs to whichever
  // conversation owns the pane now. Written only when it differs from the row,
  // which keeps a settled worktree at zero writes a pass.
  const observed = liveAgents(projectSlug, worktreeId)
  const models = paneModels(observed ?? [], links, sightings, boundary)
  await Promise.all(links.map(async (l) => {
    const firstPrompt = l.firstPrompt === undefined
      ? await captureFirstPrompt(projectSlug, l.tool, l.agentSessionId, absoluteTranscriptPath(l), jobName)
      : undefined
    const model = models.get(`${l.tool}/${l.agentSessionId}`)
    const capture = {
      ...(firstPrompt !== undefined ? { firstPrompt } : {}),
      ...(model !== undefined && model !== l.model ? { model } : {}),
    }
    if (Object.keys(capture).length === 0) return
    await setAgentSessionCapture(projectSlug, l.tool, l.agentSessionId, capture)
  }))

  // Intersect the recorded handles with what the status watcher can see. When
  // the watcher has no live set yet (a pod whose connection hasn't attached),
  // leave the active set alone rather than blanking it — a transient stream
  // gap must never look like "every agent exited".
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
 * What each live agent last reported, per worktree, for the pod life it was
 * reported in — handles restart at `%0` (or the tool's name) in a new pod, so
 * a report is only ever compared with its own life's.
 */
const reportedModes = new Map<string, { life: number; byHandle: Map<string, string> }>()

/** What each codex rollout was last read to say. */
const transcriptModes = new Map<string, PermissionMode>()

/** Test helper: forget every mode seen so far. */
export function _resetReportedModesForTests(): void {
  reportedModes.clear()
  transcriptModes.clear()
}

/**
 * Record the posture moves the live agents report — a Shift+Tab, an agent
 * entering plan mode, a plan-exit answer taking effect.
 *
 * Only a CHANGE in what an agent reports is recorded, never a mere difference
 * from the row: the row also follows the worktree's other agents, and a report
 * that has not moved is not news about any of them. A first report is a
 * change, since a pane or conversation says nothing until it has something to
 * say — which is also what carries a move made while no server was watching
 * onto the row once one is.
 */
async function followReportedModes(
  projectSlug: string,
  worktreeId: string,
  mode: AgentMode,
  row: WorktreeRow | undefined,
  observed: LiveAgent[] | undefined,
): Promise<void> {
  if (row === undefined || observed === undefined) return
  const key = `${projectSlug}/${worktreeId}`
  const life = row.lifeStartedAt?.getTime() ?? 0
  let seen = reportedModes.get(key)
  if (seen?.life !== life) {
    seen = { life, byHandle: new Map() }
    reportedModes.set(key, seen)
  }
  for (const a of observed) {
    if (a.reportedMode === undefined || seen.byHandle.get(a.handle) === a.reportedMode) continue
    seen.byHandle.set(a.handle, a.reportedMode)
    const posture = resolveAgentPermissionMode(mode, a.tool, a.reportedMode, row.permissionMode)
    if (posture === undefined || posture === row.permissionMode) continue
    await applyWorktreeEvent({ type: 'permission-mode-changed', projectSlug, worktreeId, permissionMode: posture })
  }
}

/**
 * The same for the tool whose posture is read rather than pushed: codex,
 * whose rollout records every settings change (`getCodexPermissionMode`).
 * Its rollouts are the ones recorded on its conversations — by its hook, or
 * where none runs by `discoverCodexSessions` — so a conversation resumed any
 * number of days after it began is still read where it is written.
 *
 * A reading is news when it changed since the last one — or, on the first,
 * when it was written during the current pod life. A restart resumes the same
 * rollout, whose newest entry is the OLD process's until codex records the
 * settings it resumed under, and reading that as news would drag the row off
 * the posture the restart just relaunched in; an entry written since is this
 * process's own, even on a first reading (a Shift+Tab before the first prompt).
 */
async function followRolloutModes(
  projectSlug: string,
  worktreeId: string,
  row: WorktreeRow,
  links: AgentSessionLinkRow[],
): Promise<void> {
  const life = row.lifeStartedAt?.getTime() ?? 0
  const rollouts = links.flatMap((l) => {
    const rollout = l.tool === 'codex' ? absoluteTranscriptPath(l) : undefined
    return rollout === undefined ? [] : [rollout]
  })
  for (const rollout of rollouts) {
    const read = await getCodexPermissionMode(rollout)
    // Nothing read is no news — a rollout not written yet, or settings no
    // posture stands for — and must not make the next reading look like one.
    if (read === undefined) continue
    const previous = transcriptModes.get(rollout)
    transcriptModes.set(rollout, read.permissionMode)
    const news = previous === undefined ? read.atMs >= life : read.permissionMode !== previous
    if (!news || read.permissionMode === row.permissionMode) continue
    await applyWorktreeEvent({
      type: 'permission-mode-changed',
      projectSlug,
      worktreeId,
      permissionMode: read.permissionMode,
    })
  }
}

/**
 * Record the codex conversations a worktree ran, where no hook does: under
 * containerless codex reaches `yaac-agent-links` only through a managed hook
 * that needs an image to carry it (docs/containerless-driver.md).
 *
 * They are the TUI rollouts codex wrote from this checkout during the current
 * life (`findCodexRollouts`), which covers a `/new` and a codex started by
 * hand, each reported with its own session id and rollout — what a restart
 * resumes and what the posture is followed by. A conversation that never took
 * a turn has no rollout, and is not recorded: `codex resume` refuses an id
 * with none.
 *
 * The pane is the one whose title names the conversation (`sessionIdPrefix`,
 * codex's `thread-id`), which is exact however many codex panes there are.
 * That also carries a conversation found in an earlier life: a restart
 * resumes it into the rollout it began, however many days back, and the
 * recorded one takes the pane its title names. A recorded conversation still
 * holding a pane that now names another is reported without it, which is
 * what marks one a `/new` left behind inactive. With no live set yet nothing
 * is reported, since a report without a pane clears one.
 */
async function discoverCodexSessions(
  projectSlug: string,
  worktreeId: string,
  row: WorktreeRow,
): Promise<void> {
  const observed = liveAgents(projectSlug, worktreeId)
  if (observed === undefined || row.lifeStartedAt === undefined) return
  const paneOf = (sessionId: string): string | undefined => observed.find((a) =>
    a.tool === 'codex' && a.sessionIdPrefix !== undefined && sessionId.startsWith(a.sessionIdPrefix))?.handle
  // Keyed by conversation, holding the rollout only where it is newly found:
  // a recorded conversation keeps the transcript it has.
  const conversations = new Map<string, string | undefined>()
  for (const l of await listWorktreeAgentSessions(projectSlug, worktreeId)) {
    if (l.tool === 'codex' && (l.paneId !== undefined || paneOf(l.agentSessionId) !== undefined)) {
      conversations.set(l.agentSessionId, undefined)
    }
  }
  for (const { rollout, sessionId } of await findCodexRollouts(
    codexDir(projectSlug), worktreeDir(projectSlug, worktreeId), row.lifeStartedAt.getTime(),
  )) conversations.set(sessionId, rollout)
  if (conversations.size === 0) return
  const sessions = [...conversations].map(([sessionId, rollout]) => {
    const paneId = paneOf(sessionId)
    return toReported(projectSlug, {
      tool: 'codex',
      agentSessionId: sessionId,
      ...(rollout !== undefined ? { transcriptPath: rollout } : {}),
      ...(paneId !== undefined ? { paneId } : {}),
    })
  })
  await applyWorktreeEvent({ type: 'sessions-discovered', projectSlug, worktreeId, sessions })
}

/**
 * Each live pane's reported model, keyed by the conversation it belongs to
 * (`<tool>/<id>`).
 *
 * The model is a fact about the pane — the option stays put across a
 * `/clear` — so it belongs to the conversation running there NOW: the last
 * one this life's log saw start on the pane. A link's recorded pane cannot
 * answer that alone, since the conversation a `/clear` left behind still names
 * the pane it last ran in. With no sighting on the pane, the recorded pane
 * decides, and failing that a tool with a single conversation here (opencode,
 * which no hook reports, so its links carry no pane) takes it.
 */
function paneModels(
  observed: LiveAgent[],
  links: AgentSessionLinkRow[],
  sightings: SessionStartSighting[],
  lifeLogBytes: number,
): Map<string, string> {
  // Keyed by tool as well as pane: a pane's model is only ever its own tool's,
  // and a pane can carry another tool's sighting — a prewarmed spare retooled
  // at claim keeps its warm-time agent's start line on the pane the new tool
  // now runs in.
  const owner = new Map<string, string>()
  for (const s of sightings) {
    if (s.handle === undefined || s.atByte < lifeLogBytes) continue
    owner.set(`${s.tool}/${s.handle}`, `${s.tool}/${s.agentSessionId}`)
  }
  const models = new Map<string, string>()
  for (const a of observed) {
    if (a.model === undefined) continue
    const ofTool = links.filter((l) => l.tool === a.tool)
    const recorded = ofTool.filter((l) => l.paneId === a.handle).at(-1)
      ?? (ofTool.length === 1 ? ofTool[0] : undefined)
    const key = owner.get(`${a.tool}/${a.handle}`)
      ?? (recorded !== undefined ? `${recorded.tool}/${recorded.agentSessionId}` : undefined)
    if (key !== undefined) models.set(key, a.model)
  }
  return models
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
  await followReportedModes(
    projectSlug, worktreeId, 'acp', await getWorktreeRow(projectSlug, worktreeId), observed,
  )
  const live = await Promise.all(
    observed
      .filter((a) => a.agentSessionId !== undefined)
      .map(async (a) => {
        const agentSessionId = a.agentSessionId as string
        const record = path.join(acpLogDir(projectSlug, worktreeId), `${agentSessionId}.jsonl`)
        // Everything below comes from the record, and that is the point: it is
        // the one source that answers for every tool. A TUI conversation is
        // read from the transcript its tool writes, but under ACP three of the
        // four leave nothing yaac can find — codex names its rollouts by a
        // thread id we never see, opencode keeps its history in a
        // container-side database, and pi's log is named for an id its adapter
        // minted rather than the one we asked for. The record is on disk
        // whether or not anything is attached, and it outlives the pod, which
        // is what lets a stopped worktree still be labelled and ordered.
        //
        // The model is the exception: the adapter pushes it, so it rides the
        // live set rather than being read back out of the record.
        const firstPrompt = await readAcpFirstPrompt(record)
        const lastActiveMs = await transcriptLastActiveMs(record)
        return {
          tool: a.tool,
          agentSessionId,
          paneId: a.handle,
          mode: 'acp' as const,
          ...(firstPrompt !== undefined ? { firstPrompt } : {}),
          ...(lastActiveMs !== undefined ? { lastActiveMs } : {}),
          ...(a.model !== undefined ? { model: a.model } : {}),
        }
      }),
  )
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
