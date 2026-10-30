import { catalogModel, modelEfforts } from '#domain/auth'
import type { RuntimeSnapshot } from '#drivers/contract'
import { isWorkspaceTerminating, liveAgents } from '#runtime/status'
import {
  acpConversation,
  acpRecord,
  agentWindowName,
  getConversationFirstMessage,
  PromptNotRunError,
  getCodexRolloutSettings,
  locateTranscript,
  readAcpFirstPrompt,
  resolveAgentPermissionMode,
  resolveProjectPath,
  sessionTranscriptPath,
  setAcpPermissionMode,
  transcriptLastActiveMs,
} from '#runtime/agents'
import {
  applyWorkspaceEvent,
  getWorkspaceRow,
  listUncapturedStoppedConversations,
  holdPendingPrompt,
  listWorkspaceConversations,
  takePendingPrompt,
} from '#db'
import { captureFirstPrompt } from './prompt-capture'
import { captureTitle } from './title-capture'
import { claiming } from './prewarm'
import { recordedTranscript } from './conversation-paths'
import { serverLog } from '#lib/log'
import type { ConversationLinkRow, CapturedConversation, DiscoveredConversation, WorkspaceRow } from '#db'
import type { AcpConversation, LiveAgent } from '#runtime/agents'
import { EFFORT_RE, type AgentMode } from '@yaac/shared/types'

/**
 * Record agent conversations from what running workspaces report.
 *
 * The source, for both modes, is the status watcher's live agent set
 * (`#runtime/status`), where each agent names its conversation. Under `acp`
 * the id comes from `session/new`; under `tui` the tool's reporter sets it on
 * its tmux pane (`PANE_SESSION_FORMAT`) on every start, `/clear`, `/new` or
 * resume. The conversations live agents name are exactly the active ones. A
 * new pod's tmux starts with no pane options, so an old pod's conversation
 * cannot look live.
 *
 * Runs on the reconciler tick so `workspace list` and restart see the record
 * even with no client watching. Stopped and stopping workspaces are skipped:
 * their active set is frozen, and it is what restart resumes. So are spares,
 * and spares mid-claim: a spare's warm-time agent is not the claimant's
 * conversation, and recording it would make a later restart resume the wrong
 * one. A claim that respawns the agent ends that conversation, which stays
 * registered until its stream is seen closing, so under acp the claim's
 * hand-over runs the first pass itself once the new conversation is named.
 */
export async function reconcileConversations(view: RuntimeSnapshot): Promise<void> {
  const running = (await view.workspaces()).filter((p) => p.running && !p.prewarmed
    && !claiming.has(p.jobName) && !p.terminating && p.projectId && p.workspaceId
    && !isWorkspaceTerminating(p.workspaceId))
  await Promise.all(running.map(async (pod) => {
    try {
      await reconcileWorkspaceConversations(pod.projectId, pod.workspaceId, pod.mode, pod.jobName)
    } catch (err) {
      serverLog(`[server] conversations ${pod.workspaceId}: ${String(err)}`)
    }
  }))
}

/**
 * One workspace's pass of `reconcileConversations`. Also run by an acp
 * claim's hand-over as soon as its conversation is named, since the sweep
 * skips a spare mid-claim.
 */
export async function reconcileWorkspaceConversations(
  projectId: string,
  workspaceId: string,
  mode: AgentMode,
  jobName: string,
): Promise<void> {
  // No live set yet (stream not attached): leave the rows alone so a gap
  // does not look like every agent exited.
  const reported = liveAgents(projectId, workspaceId)
  if (reported === undefined) return
  // Map each reported transcript path to where the file really is, or drop it.
  const observed = await Promise.all(reported.map(async (a): Promise<LiveAgent> => {
    const { transcriptPath, ...rest } = a
    const located = a.conversationId === undefined
      ? undefined
      : await locateTranscript(projectId, workspaceId, a.tool, a.conversationId, transcriptPath)
    return located === undefined ? rest : { ...rest, transcriptPath: located }
  }))
  const row = await getWorkspaceRow(projectId, workspaceId)
  const links = await listWorkspaceConversations(projectId, workspaceId)
  if (row !== undefined) {
    const reports = await withRolloutReports(row, observed, links)
    await followReportedModes(projectId, workspaceId, mode, row, reports)
    await followReportedEfforts(projectId, workspaceId, row, reports)
  }

  // Skip agents that have not named their conversation yet (ACP handshake in
  // flight, codex/opencode before the first turn); recording them by handle
  // would create a phantom row the real one could never replace.
  //
  // Also skip an unrecorded acp conversation whose stream is gone, until it
  // reattaches. The live set keeps naming an ended one until the window's
  // next agent attaches, so without this a claimed spare's warm-time
  // conversation, ended by the claim's respawn, could be recorded as the
  // workspace's first if the hand-over gave up waiting.
  const live = await Promise.all(observed.flatMap((a) => {
    const conversationId = a.conversationId
    if (conversationId === undefined) return []
    const recorded = links.find((l) => l.tool === a.tool && l.conversationId === conversationId)
    if (recorded === undefined && mode === 'acp'
      && acpConversation(projectId, workspaceId, conversationId) === undefined) return []
    return [describe(projectId, workspaceId, mode, jobName, a, conversationId, recorded)]
  }))
  if (live.length > 0) {
    await applyWorkspaceEvent({ type: 'conversations-discovered', projectId, workspaceId, sessions: live })
  }
  await applyWorkspaceEvent({
    type: 'conversations-active',
    projectId,
    workspaceId,
    active: live.map((c) => ({ tool: c.tool, conversationId: c.conversationId, paneId: c.paneId })),
  })

  // No user message can reach the conversation before the first delivery:
  // the chat pane and `yaac-mama send` both need its row, recorded just
  // above. A prompt is held again only after a send no pane saw fail
  // (`deliverPendingPrompt`), so the user has had no failure to retry.
  if (row?.pendingPrompt !== undefined) {
    const first = observed.find((a) => a.handle === agentWindowName(a.tool, 0))
    const conversation = first?.conversationId === undefined
      ? undefined
      : acpConversation(projectId, workspaceId, first.conversationId)
    if (conversation !== undefined) void deliverPendingPrompt(projectId, workspaceId, conversation)
  }
}

/** Conversations that refused the held prompt, which are not asked again. */
const refusedPrompt = new WeakSet<AcpConversation>()

/**
 * Send the workspace's held create prompt (`takePendingPrompt`) to
 * `conversation` once its handshake is done: from the create's hand-over,
 * or from a later pass when that hand-over found no conversation. One that
 * never finishes its handshake leaves the prompt held for the next.
 *
 * The prompt is taken before it is sent, so a crash between the two loses
 * it rather than running the task twice. Only a send that was never made
 * and never shown failing (`PromptNotRunError`) puts it back, for another
 * conversation. A refusal the agent replies with is shown in the chat pane,
 * where the user may already have retried, so it is left for them.
 */
export async function deliverPendingPrompt(
  projectId: string,
  workspaceId: string,
  conversation: AcpConversation,
): Promise<void> {
  if (refusedPrompt.has(conversation)) return
  let prompt: string | undefined
  try {
    await conversation.whenReady(PENDING_PROMPT_READY_MS)
    prompt = await takePendingPrompt(projectId, workspaceId)
  } catch (err) {
    serverLog(`[server] ${workspaceId}: initial prompt still held: ${String(err)}`)
    return
  }
  if (prompt === undefined) return
  // Resolves when the turn ends, which nothing here waits for.
  void conversation.prompt(prompt).catch(async (err: unknown) => {
    serverLog(`[server] ${workspaceId}: initial prompt failed: ${String(err)}`)
    if (!(err instanceof PromptNotRunError)) return
    refusedPrompt.add(conversation)
    await holdPendingPrompt(projectId, workspaceId, prompt).catch((holdErr: unknown) => {
      serverLog(`[server] ${workspaceId}: initial prompt lost: ${String(holdErr)}`)
    })
  })
}

/** How long a launch's watch and a claim's hand-over wait for an acp
 *  conversation to be named, and the hand-over for its handshake. */
export const ACP_CONVERSATION_WAIT_MS = 60_000

/** How long `deliverPendingPrompt` waits on a handshake, as a pane's send
 *  does (`AcpConversation.prompt`). */
const PENDING_PROMPT_READY_MS = 120_000

/**
 * How long after its agent comes up a held prompt still counts as on its
 * way: the hand-over's wait for a conversation plus `deliverPendingPrompt`'s
 * wait for its handshake. Past it the start is stuck (an adapter that stays
 * up but fails every handshake), and the workspace lists by its real status.
 */
export const HELD_PROMPT_GRACE_MS = ACP_CONVERSATION_WAIT_MS + PENDING_PROMPT_READY_MS

/** How many conversations `reconcileStoppedConversations` reads at a time,
 *  and for how long one pass keeps reading. A backlog (an upgraded install's
 *  stopped history) drains quickly without stalling the pass. */
const STOPPED_CAPTURE_BATCH = 20
const STOPPED_CAPTURE_BUDGET_MS = 500

/**
 * Record what each stopped workspace's conversations left on disk, once:
 * the last activity, and the first message if none was captured. A running
 * workspace's pass records both, so this covers conversations no pass
 * finished with: a workspace that stopped before one ran, and rows from an
 * install whose passes did not record `tui` activity. A conversation with no
 * readable file gets its creation time, which marks it read. The stopped
 * listing reads only rows, so this is where those files are read for it.
 */
export async function reconcileStoppedConversations(): Promise<void> {
  const deadline = Date.now() + STOPPED_CAPTURE_BUDGET_MS
  for (;;) {
    const pending = await listUncapturedStoppedConversations(STOPPED_CAPTURE_BATCH)
    await captureStoppedBatch(pending)
    if (pending.length < STOPPED_CAPTURE_BATCH || Date.now() >= deadline) return
  }
}

/** Read one batch, recording each workspace's conversations in one event. */
async function captureStoppedBatch(pending: ConversationLinkRow[]): Promise<void> {
  const byWorkspace = new Map<string, ConversationLinkRow[]>()
  for (const l of pending) {
    const key = `${l.projectId}/${l.workspaceId}`
    byWorkspace.set(key, [...byWorkspace.get(key) ?? [], l])
  }
  for (const links of byWorkspace.values()) {
    const { projectId, workspaceId } = links[0]
    await applyWorkspaceEvent({
      type: 'conversations-captured',
      projectId,
      workspaceId,
      // A file that cannot be read still marks the conversation read, so it
      // is not retried every pass.
      sessions: await Promise.all(links.map((l) => captureStopped(l).catch((): CapturedConversation =>
        ({ tool: l.tool, conversationId: l.conversationId, lastActiveMs: l.createdAt.getTime() })))),
    })
  }
}

/** One stopped conversation's files, read as `describe` reads a live one's.
 *  Without a recorded path the transcript is looked for where the tool
 *  writes it, since a conversation that died early never had one recorded. */
async function captureStopped(l: ConversationLinkRow): Promise<CapturedConversation> {
  const record = { projectId: l.projectId, workspaceId: l.workspaceId, conversationId: l.conversationId }
  const activity = l.mode === 'acp' ? acpRecord(record)
    : recordedTranscript(l) ?? await sessionTranscriptPath(l.projectId, l.workspaceId, l.tool, l.conversationId)
  const firstPrompt = l.firstPrompt !== undefined ? undefined
    : l.mode === 'acp' ? await readAcpFirstPrompt(record)
    : await getConversationFirstMessage(l.tool, activity)
  const lastActiveMs = activity !== undefined ? await transcriptLastActiveMs(activity) : undefined
  return {
    tool: l.tool,
    conversationId: l.conversationId,
    lastActiveMs: lastActiveMs ?? l.createdAt.getTime(),
    ...(firstPrompt !== undefined ? { firstPrompt } : {}),
  }
}

/**
 * One live conversation, plus its first message if the row lacks one, its
 * own title (`captureTitle`), and its last activity: the mtime of the file
 * the agent appends to, recorded every pass so the stopped listing can show
 * it without a read. Under `tui` that file is the tool's transcript. Under
 * `acp` most tools leave no transcript yaac can find, so acpd's record is
 * read instead.
 *
 * The model is mapped to its catalog id, since an ACP adapter may report its
 * own naming.
 */
async function describe(
  projectId: string,
  workspaceId: string,
  mode: AgentMode,
  jobName: string,
  agent: LiveAgent,
  conversationId: string,
  recorded: ConversationLinkRow | undefined,
): Promise<DiscoveredConversation & { paneId: string }> {
  const { tool, transcriptPath } = agent
  const record = { projectId, workspaceId, conversationId }
  const stored = transcriptPath ?? recorded?.transcriptPath
  const transcript = stored !== undefined ? resolveProjectPath(projectId, workspaceId, tool, stored) : undefined
  const firstPrompt = recorded?.firstPrompt !== undefined ? undefined
    : mode === 'acp' ? await readAcpFirstPrompt(record)
    : await captureFirstPrompt(projectId, tool, conversationId, transcript)
  const activity = mode === 'acp' ? acpRecord(record) : transcript
  const lastActiveMs = activity !== undefined ? await transcriptLastActiveMs(activity) : undefined
  const title = await captureTitle(
    projectId, workspaceId, tool, conversationId, transcript, jobName, lastActiveMs, recorded?.title,
  )
  return {
    tool,
    conversationId,
    paneId: agent.handle,
    mode,
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
    ...(firstPrompt !== undefined ? { firstPrompt } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(lastActiveMs !== undefined ? { lastActiveMs } : {}),
    ...(agent.model !== undefined ? { model: catalogModel(tool, agent.model, agent.modelName) } : {}),
  }
}

/**
 * Each live agent's last reported mode and effort, per workspace, keyed to
 * the pod life. Handles (`%0`, or the tool's name) repeat in a new pod, so
 * reports are only compared within one life.
 */
type SeenReports = Map<string, { life: number; byHandle: Map<string, string> }>
const reportedModes: SeenReports = new Map()
const reportedEfforts: SeenReports = new Map()

/** Test helper: forget every mode and effort seen so far. */
export function _resetReportedModesForTests(): void {
  reportedModes.clear()
  reportedEfforts.clear()
}

/** This life's reports seen for a workspace, reset when a new life starts. */
function seenThisLife(reports: SeenReports, key: string, row: WorkspaceRow): Map<string, string> {
  const life = row.lifeStartedAt?.getTime() ?? 0
  let seen = reports.get(key)
  if (seen?.life !== life) {
    seen = { life, byHandle: new Map() }
    reports.set(key, seen)
  }
  return seen.byHandle
}

/**
 * Record permission-mode changes the live agents report (Shift+Tab, entering
 * plan mode, answering a plan exit).
 *
 * Only a change in an agent's report is recorded, not a mere difference from
 * the row, because the row also follows the workspace's other agents. An
 * agent's first report counts as a change, which also picks up moves made
 * while no server was watching.
 */
async function followReportedModes(
  projectId: string,
  workspaceId: string,
  mode: AgentMode,
  row: WorkspaceRow,
  observed: LiveAgent[],
): Promise<void> {
  const seen = seenThisLife(reportedModes, `${projectId}/${workspaceId}`, row)
  for (const a of observed) {
    if (a.reportedMode === undefined || seen.get(a.handle) === a.reportedMode) continue
    seen.set(a.handle, a.reportedMode)
    const posture = resolveAgentPermissionMode(mode, a.tool, a.reportedMode, row.permissionMode)
    if (posture === undefined || posture === row.permissionMode) continue
    await applyWorkspaceEvent({ type: 'permission-mode-changed', projectId, workspaceId, permissionMode: posture })
    setAcpPermissionMode(projectId, workspaceId, posture)
  }
}

/**
 * Record effort changes the live agents report (`/effort`, a model switch
 * that re-seeds it, the chat pane's menu), as `followReportedModes` does
 * modes. Anything in the workspace can set a pane option, so a report that
 * is not one word, or not a level the agent's model has, is ignored.
 * `default` is kept: claude's ACP adapter offers it beside the model's
 * levels, and a restart maps it to the model's default.
 */
async function followReportedEfforts(
  projectId: string,
  workspaceId: string,
  row: WorkspaceRow,
  observed: LiveAgent[],
): Promise<void> {
  const seen = seenThisLife(reportedEfforts, `${projectId}/${workspaceId}`, row)
  for (const a of observed) {
    const effort = a.reportedEffort
    if (effort === undefined || !EFFORT_RE.test(effort) || seen.get(a.handle) === effort) continue
    seen.set(a.handle, effort)
    const model = a.model !== undefined ? catalogModel(a.tool, a.model, a.modelName) : row.model
    const levels = model !== undefined ? modelEfforts(a.tool, model)?.levels : undefined
    if (levels !== undefined && effort !== 'default' && !levels.includes(effort)) continue
    if (effort === row.effort) continue
    await applyWorkspaceEvent({ type: 'effort-changed', projectId, workspaceId, effort })
  }
}

/**
 * Adds codex's permission mode and effort, read from its rollout file
 * (`getCodexRolloutSettings`), since codex's pane title cannot show them. A
 * resumed conversation's pane names no rollout until its next turn, so the
 * row's recorded path is used then.
 *
 * Only entries written during the current pod life count. After a restart the
 * rollout's newest entry belongs to the old process until codex writes again,
 * and reporting it would undo the mode the restart launched with.
 */
async function withRolloutReports(
  row: WorkspaceRow,
  observed: LiveAgent[],
  links: ConversationLinkRow[],
): Promise<LiveAgent[]> {
  const life = row.lifeStartedAt?.getTime() ?? 0
  return Promise.all(observed.map(async (a) => {
    const recorded = links.find((l) => l.tool === a.tool && l.conversationId === a.conversationId)
    const transcript = a.transcriptPath ?? recorded?.transcriptPath
    const rollout = a.tool === 'codex' && transcript !== undefined
      ? resolveProjectPath(row.projectId, row.workspaceId, 'codex', transcript)
      : undefined
    const read = rollout !== undefined ? await getCodexRolloutSettings(rollout) : undefined
    if (read === undefined || read.atMs < life) return a
    return {
      ...a,
      ...(read.permissionMode !== undefined ? { reportedMode: read.permissionMode } : {}),
      ...(read.effort !== undefined ? { reportedEffort: read.effort } : {}),
    }
  }))
}
