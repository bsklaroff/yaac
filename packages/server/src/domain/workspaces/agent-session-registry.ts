import { workspaceDriver } from '#drivers/driver'
import { catalogModel } from '#domain/auth'
import type { RuntimeSnapshot } from '#drivers/contract'
import { classifyWorkspaces, liveAgents, probeTmuxLiveness } from '#runtime/status'
import {
  acpRecord,
  getCodexPermissionMode,
  locateTranscript,
  readAcpFirstPrompt,
  resolveAgentPermissionMode,
  resolveProjectPath,
  transcriptLastActiveMs,
} from '#runtime/agents'
import { applyWorkspaceEvent, getWorkspaceRow, listWorkspaceAgentSessions } from '#db'
import { captureFirstPrompt } from './prompt-capture'
import { testEnv } from '@yaac/shared/env'
import type { AgentSessionLinkRow, DiscoveredSession, WorkspaceRow } from '#db'
import type { LiveAgent } from '#runtime/agents'
import type { AgentMode } from '@yaac/shared/types'

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
 * even with no client watching. Stopped workspaces are skipped: their active
 * set is frozen, and it is what restart resumes.
 */
export async function reconcileAgentSessions(snapshot?: RuntimeSnapshot): Promise<void> {
  let pods
  try {
    pods = await (snapshot ?? workspaceDriver().snapshot()).workspaces()
  } catch {
    return
  }
  const { running } = await classifyWorkspaces(
    pods, Date.now(), probeTmuxLiveness, testEnv.startingGraceMs,
  )

  await Promise.all(running.map(async (pod) => {
    if (!pod.workspaceId || !pod.projectSlug) return
    // A spare's warm-time agent is not the claimant's conversation; recording
    // it would make a later restart resume the wrong one.
    if (pod.prewarmed) return
    try {
      await reconcileWorkspaceAgentSessions(pod.projectSlug, pod.workspaceId, pod.mode, pod.jobName)
    } catch {
      // best-effort — next tick retries
    }
  }))
}

async function reconcileWorkspaceAgentSessions(
  projectSlug: string,
  workspaceId: string,
  mode: AgentMode,
  jobName: string,
): Promise<void> {
  // No live set yet (stream not attached): leave the rows alone so a gap
  // does not look like every agent exited.
  const reported = liveAgents(projectSlug, workspaceId)
  if (reported === undefined) return
  // Map each reported transcript path to where the file really is, or drop it.
  const observed = await Promise.all(reported.map(async (a): Promise<LiveAgent> => {
    const { transcriptPath, ...rest } = a
    const located = a.agentSessionId === undefined
      ? undefined
      : await locateTranscript(projectSlug, workspaceId, a.tool, a.agentSessionId, transcriptPath)
    return located === undefined ? rest : { ...rest, transcriptPath: located }
  }))
  const row = await getWorkspaceRow(projectSlug, workspaceId)
  const links = await listWorkspaceAgentSessions(projectSlug, workspaceId)
  if (row !== undefined) {
    await followReportedModes(projectSlug, workspaceId, mode, row, await withRolloutModes(row, observed, links))
  }

  // Skip agents that have not named their conversation yet (ACP handshake in
  // flight, codex/opencode before the first turn); recording them by handle
  // would create a phantom row the real one could never replace.
  const live = await Promise.all(observed.flatMap((a) => {
    const agentSessionId = a.agentSessionId
    if (agentSessionId === undefined) return []
    const recorded = links.find((l) => l.tool === a.tool && l.agentSessionId === agentSessionId)
    return [describe(projectSlug, workspaceId, mode, jobName, a, agentSessionId, recorded)]
  }))
  if (live.length > 0) {
    await applyWorkspaceEvent({ type: 'sessions-discovered', projectSlug, workspaceId, sessions: live })
  }
  await applyWorkspaceEvent({
    type: 'sessions-active',
    projectSlug,
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
  projectSlug: string,
  workspaceId: string,
  mode: AgentMode,
  jobName: string,
  agent: LiveAgent,
  agentSessionId: string,
  recorded: AgentSessionLinkRow | undefined,
): Promise<DiscoveredSession & { paneId: string }> {
  const { tool, transcriptPath } = agent
  const record = { slug: projectSlug, workspaceId, agentSessionId }
  const transcript = transcriptPath ?? recorded?.transcriptPath
  const firstPrompt = recorded?.firstPrompt !== undefined ? undefined
    : mode === 'acp' ? await readAcpFirstPrompt(record)
    : await captureFirstPrompt(
      projectSlug, tool, agentSessionId,
      transcript !== undefined ? resolveProjectPath(projectSlug, workspaceId, tool, transcript) : undefined, jobName,
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
 * Each live agent's last reported mode, per workspace, keyed to the pod life.
 * Handles (`%0`, or the tool's name) repeat in a new pod, so reports are
 * only compared within one life.
 */
const reportedModes = new Map<string, { life: number; byHandle: Map<string, string> }>()

/** Test helper: forget every mode seen so far. */
export function _resetReportedModesForTests(): void {
  reportedModes.clear()
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
  projectSlug: string,
  workspaceId: string,
  mode: AgentMode,
  row: WorkspaceRow,
  observed: LiveAgent[],
): Promise<void> {
  const key = `${projectSlug}/${workspaceId}`
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
    await applyWorkspaceEvent({ type: 'permission-mode-changed', projectSlug, workspaceId, permissionMode: posture })
  }
}

/**
 * Adds codex's permission mode, read from its rollout file
 * (`getCodexPermissionMode`), since codex's pane title cannot show it. A
 * resumed conversation's pane names no rollout until its next turn, so the
 * row's recorded path is used then.
 *
 * Only entries written during the current pod life count. After a restart the
 * rollout's newest entry belongs to the old process until codex writes again,
 * and reporting it would undo the mode the restart launched with.
 */
async function withRolloutModes(
  row: WorkspaceRow,
  observed: LiveAgent[],
  links: AgentSessionLinkRow[],
): Promise<LiveAgent[]> {
  const life = row.lifeStartedAt?.getTime() ?? 0
  return Promise.all(observed.map(async (a) => {
    const recorded = links.find((l) => l.tool === a.tool && l.agentSessionId === a.agentSessionId)
    const transcript = a.transcriptPath ?? recorded?.transcriptPath
    const rollout = a.tool === 'codex' && transcript !== undefined
      ? resolveProjectPath(row.projectSlug, row.workspaceId, 'codex', transcript)
      : undefined
    const read = rollout !== undefined ? await getCodexPermissionMode(rollout) : undefined
    return read !== undefined && read.atMs >= life ? { ...a, reportedMode: read.permissionMode } : a
  }))
}
