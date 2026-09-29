import { worktreeDriver } from '#drivers/driver'
import { catalogModel } from '#domain/auth'
import type { RuntimeSnapshot } from '#drivers/contract'
import { classifyWorkspaces, liveAgents, probeTmuxLiveness } from '#runtime/status'
import {
  getCodexPermissionMode,
  readAcpFirstPrompt,
  resolveAgentPermissionMode,
  resolveProjectPath,
  transcriptLastActiveMs,
} from '#runtime/agents'
import { applyWorktreeEvent, getWorktreeRow, listWorktreeAgentSessions } from '#db'
import { captureFirstPrompt } from './prompt-capture'
import path from 'node:path'
import { acpLogDir } from '@yaac/shared/project-paths'
import { testEnv } from '@yaac/shared/env'
import type { AgentSessionLinkRow, DiscoveredSession, WorktreeRow } from '#db'
import type { LiveAgent } from '#runtime/agents'
import type { AgentMode } from '@yaac/shared/types'

/**
 * Reconcile the agent-session model from what the pods report.
 *
 * One source, for both modes: the status watcher's live agent set
 * (`status-store.ts`), in which each agent names the conversation it is
 * running. Under `acp` the id comes back from `session/new`; under `tui` the
 * tool's own reporter puts it on its tmux pane (`PANE_SESSION_FORMAT`) — on
 * every start, `/clear`, `/new` or resume, in an agent window or a shell the
 * user opened — and tmux pushes it. So every conversation a live agent names
 * is recorded, and those are exactly the active ones.
 *
 * A pane option dies with its pane and a new pod's tmux starts with none, so
 * nothing here can mistake a previous pod's conversation for a live one.
 *
 * Runs on the reconciler tick, like prompt capture, so the record exists for
 * `worktree list` and restart even when no client is watching; a new
 * conversation is a change to the live set, which dirties the tick. Only
 * running worktrees are visited: a stopped worktree's active set is frozen,
 * and it is exactly what its restart reads back.
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
    // leave permanently-active links that a later restart resumes instead of
    // the real conversation — and outlive the reaped spare.
    if (pod.prewarmed) return
    try {
      await reconcileWorktreeAgentSessions(pod.projectSlug, pod.workspaceId, pod.mode, pod.jobName)
    } catch {
      // best-effort — next tick retries
    }
  }))
}

async function reconcileWorktreeAgentSessions(
  projectSlug: string,
  worktreeId: string,
  mode: AgentMode,
  jobName: string,
): Promise<void> {
  // No live set yet (a pod whose connection hasn't attached): leave the rows
  // alone rather than blanking them — a transient stream gap must never look
  // like "every agent exited".
  const observed = liveAgents(projectSlug, worktreeId)
  if (observed === undefined) return
  const row = await getWorktreeRow(projectSlug, worktreeId)
  const links = await listWorktreeAgentSessions(projectSlug, worktreeId)
  if (row !== undefined) {
    await followReportedModes(projectSlug, worktreeId, mode, row, await withRolloutModes(row, observed, links))
  }

  // An agent that has not named its conversation yet — an ACP handshake still
  // in flight, a codex or opencode pane before its first turn — is skipped:
  // recording it under its handle would mint a phantom the real one could
  // never displace.
  const live = await Promise.all(observed.flatMap((a) => {
    const agentSessionId = a.agentSessionId
    if (agentSessionId === undefined) return []
    const recorded = links.find((l) => l.tool === a.tool && l.agentSessionId === agentSessionId)
    return [describe(projectSlug, worktreeId, mode, jobName, a, agentSessionId, recorded)]
  }))
  if (live.length > 0) {
    await applyWorktreeEvent({ type: 'sessions-discovered', projectSlug, worktreeId, sessions: live })
  }
  await applyWorktreeEvent({
    type: 'sessions-active',
    projectSlug,
    worktreeId,
    active: live.map((c) => ({ tool: c.tool, agentSessionId: c.agentSessionId, paneId: c.paneId })),
  })
}

/**
 * One live conversation as it is reported, with its opening message while the
 * row still lacks one. What differs by mode is where that message is read:
 * a `tui` conversation's tool writes a transcript (opencode's is probed out
 * of the pod instead), but under `acp` three of the four leave nothing yaac
 * can find — codex names its rollouts by a thread id we never see, opencode
 * keeps its history in a container-side database, and pi's log is named for
 * an id its adapter minted — so acpd's record of the conversation is read,
 * which also outlives the pod and gives a stopped worktree its last activity.
 *
 * The model rides the live set, as the catalog's id for it: an ACP adapter
 * may answer in a vocabulary of its own.
 */
async function describe(
  projectSlug: string,
  worktreeId: string,
  mode: AgentMode,
  jobName: string,
  agent: LiveAgent,
  agentSessionId: string,
  recorded: AgentSessionLinkRow | undefined,
): Promise<DiscoveredSession & { paneId: string }> {
  const { tool, transcriptPath } = agent
  const record = path.join(acpLogDir(projectSlug, worktreeId), `${agentSessionId}.jsonl`)
  const transcript = transcriptPath ?? recorded?.transcriptPath
  const firstPrompt = recorded?.firstPrompt !== undefined ? undefined
    : mode === 'acp' ? await readAcpFirstPrompt(record)
    : await captureFirstPrompt(
      projectSlug, tool, agentSessionId,
      transcript !== undefined ? resolveProjectPath(projectSlug, transcript) : undefined, jobName,
    )
  const lastActiveMs = mode === 'acp' ? await transcriptLastActiveMs(record) : undefined
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
 * What each live agent last reported, per worktree, for the pod life it was
 * reported in — handles restart at `%0` (or the tool's name) in a new pod, so
 * a report is only ever compared with its own life's.
 */
const reportedModes = new Map<string, { life: number; byHandle: Map<string, string> }>()

/** Test helper: forget every mode seen so far. */
export function _resetReportedModesForTests(): void {
  reportedModes.clear()
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
  row: WorktreeRow,
  observed: LiveAgent[],
): Promise<void> {
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
 * A codex pane's report, with the posture its rollout records: codex's title
 * cannot carry one (neither the `permissions` nor the `approval-mode` item
 * renders there in 0.156.1), so the rollout its pane names is read instead
 * (`getCodexPermissionMode`) — or, for a resumed conversation whose pane
 * names none until its next turn, the one its row recorded.
 *
 * Only an entry written during the current pod life counts. A restart resumes
 * the same rollout, whose newest entry is the OLD process's until codex writes
 * its first turn, and reporting that would drag the row off the posture the
 * restart just relaunched in; an entry written since is this process's own,
 * even before the first prompt (a Shift+Tab).
 */
async function withRolloutModes(
  row: WorktreeRow,
  observed: LiveAgent[],
  links: AgentSessionLinkRow[],
): Promise<LiveAgent[]> {
  const life = row.lifeStartedAt?.getTime() ?? 0
  return Promise.all(observed.map(async (a) => {
    const recorded = links.find((l) => l.tool === a.tool && l.agentSessionId === a.agentSessionId)
    const transcript = a.transcriptPath ?? recorded?.transcriptPath
    const rollout = a.tool === 'codex' && transcript !== undefined
      ? resolveProjectPath(row.projectSlug, transcript)
      : undefined
    const read = rollout !== undefined ? await getCodexPermissionMode(rollout) : undefined
    return read !== undefined && read.atMs >= life ? { ...a, reportedMode: read.permissionMode } : a
  }))
}
