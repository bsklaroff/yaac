import { catalogModel, modelEfforts } from '#domain/auth'
import type { RuntimeSnapshot } from '#drivers/contract'
import { isWorkspaceTerminating, liveAgents } from '#runtime/status'
import {
  acpRecord,
  getCodexRolloutSettings,
  locateTranscript,
  readAcpFirstPrompt,
  resolveAgentPermissionMode,
  resolveProjectPath,
  setAcpPermissionMode,
  transcriptLastActiveMs,
} from '#runtime/agents'
import { applyWorkspaceEvent, getWorkspaceRow, listWorkspaceAgentSessions } from '#db'
import { captureFirstPrompt } from './prompt-capture'
import { serverLog } from '#log'
import type { AgentSessionLinkRow, DiscoveredSession, WorkspaceRow } from '#db'
import type { LiveAgent } from '#runtime/agents'
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
 * their active set is frozen, and it is what restart resumes. So are spares:
 * a spare's warm-time agent is not the claimant's conversation, and
 * recording it would make a later restart resume the wrong one.
 */
export async function reconcileAgentSessions(view: RuntimeSnapshot): Promise<void> {
  const running = (await view.workspaces()).filter((p) => p.running && !p.prewarmed
    && !p.terminating && p.projectId && p.workspaceId && !isWorkspaceTerminating(p.workspaceId))
  await Promise.all(running.map(async (pod) => {
    try {
      await reconcileWorkspaceAgentSessions(pod.projectId, pod.workspaceId, pod.mode, pod.jobName)
    } catch (err) {
      serverLog(`[server] agent-sessions ${pod.workspaceId}: ${String(err)}`)
    }
  }))
}

/**
 * One workspace's pass of `reconcileAgentSessions`. Also run by an acp
 * create as soon as its conversation is named, so the row (and with it the
 * chat pane) exists when the create returns.
 */
export async function reconcileWorkspaceAgentSessions(
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
    const located = a.agentSessionId === undefined
      ? undefined
      : await locateTranscript(projectId, workspaceId, a.tool, a.agentSessionId, transcriptPath)
    return located === undefined ? rest : { ...rest, transcriptPath: located }
  }))
  const row = await getWorkspaceRow(projectId, workspaceId)
  const links = await listWorkspaceAgentSessions(projectId, workspaceId)
  if (row !== undefined) {
    const reports = await withRolloutReports(row, observed, links)
    await followReportedModes(projectId, workspaceId, mode, row, reports)
    await followReportedEfforts(projectId, workspaceId, row, reports)
  }

  // Skip agents that have not named their conversation yet (ACP handshake in
  // flight, codex/opencode before the first turn); recording them by handle
  // would create a phantom row the real one could never replace.
  const live = await Promise.all(observed.flatMap((a) => {
    const agentSessionId = a.agentSessionId
    if (agentSessionId === undefined) return []
    const recorded = links.find((l) => l.tool === a.tool && l.agentSessionId === agentSessionId)
    return [describe(projectId, workspaceId, mode, jobName, a, agentSessionId, recorded)]
  }))
  if (live.length > 0) {
    await applyWorkspaceEvent({ type: 'sessions-discovered', projectId, workspaceId, sessions: live })
  }
  await applyWorkspaceEvent({
    type: 'sessions-active',
    projectId,
    workspaceId,
    active: live.map((c) => ({ tool: c.tool, agentSessionId: c.agentSessionId, paneId: c.paneId })),
  })
}

/**
 * One live conversation, plus its first message if the row lacks one. Under
 * `tui` the message comes from the tool's transcript. Under `acp` most tools
 * leave no transcript yaac can find, so acpd's record is read instead; it
 * also outlives the pod and gives a stopped workspace its last activity.
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
  agentSessionId: string,
  recorded: AgentSessionLinkRow | undefined,
): Promise<DiscoveredSession & { paneId: string }> {
  const { tool, transcriptPath } = agent
  const record = { projectId, workspaceId, agentSessionId }
  const transcript = transcriptPath ?? recorded?.transcriptPath
  const firstPrompt = recorded?.firstPrompt !== undefined ? undefined
    : mode === 'acp' ? await readAcpFirstPrompt(record)
    : await captureFirstPrompt(
      projectId, tool, agentSessionId,
      transcript !== undefined ? resolveProjectPath(projectId, workspaceId, tool, transcript) : undefined, jobName,
    )
  const recordFile = mode === 'acp' ? acpRecord(record) : undefined
  const lastActiveMs = recordFile !== undefined ? await transcriptLastActiveMs(recordFile) : undefined
  return {
    tool,
    agentSessionId,
    paneId: agent.handle,
    mode,
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
    ...(firstPrompt !== undefined ? { firstPrompt } : {}),
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
  links: AgentSessionLinkRow[],
): Promise<LiveAgent[]> {
  const life = row.lifeStartedAt?.getTime() ?? 0
  return Promise.all(observed.map(async (a) => {
    const recorded = links.find((l) => l.tool === a.tool && l.agentSessionId === a.agentSessionId)
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
