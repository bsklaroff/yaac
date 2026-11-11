import { api } from './api'
import { consumeNdjsonStream } from '@yaac/shared/ndjson'
import { rememberOpening } from '#lib/opening'
import { throwingFetch } from '@yaac/shared/api-core'
import type { LaunchPane } from '#lib/store'
import { randomUUID } from '#lib/uuid'
import type { AgentMode, AgentOptions, AgentTool, PermissionMode, RepoStart } from '@yaac/shared/types'

export interface CreateWorkspaceResult {
  workspaceId: string
  jobName: string
  /** The session it opened; absent for a workspace with none. */
  sessionId?: string
}

/**
 * POST a workspace create or restart and read its NDJSON progress stream.
 * Calls `onProgress` per step, then resolves with the result or throws the
 * server's error as a `ServerError`, whether it refused before streaming or
 * failed in the stream.
 */
async function streamWorkspaceOp(
  path: string,
  body: unknown,
  onProgress: (message: string) => void,
): Promise<unknown> {
  const res = await throwingFetch(fetch)(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return await consumeNdjsonStream<unknown>(res, onProgress)
}

/**
 * A create from the webapp: its settings, every one sent so all become the
 * project's next defaults for that agent, plus what its provisioning row
 * shows until the workspace is listed. A workspace with no session sends
 * no agent settings.
 */
export interface WorkspaceCreate {
  projectId: string
  /** Absent with `noSession`. */
  tool?: AgentTool
  mode?: AgentMode
  permissionMode?: PermissionMode
  /** Start it with no session. */
  noSession?: true
  /** Absent or empty when the provider lists no models: it launches without one. */
  model?: string
  modelName?: string
  /** Effort level, in the tool's words. */
  effort?: string
  agentOptions?: AgentOptions
  /** The agent's opening message, typed into it once it is up. */
  prompt?: string
  /** The workspace's title, which turns off auto-titling it. */
  title?: string
  /** The row's label while it provisions, when `title` is unset. */
  shownTitle?: string
  /** The repos it starts with, each at a branch or a full commit (neither
   *  forks from origin's default branch), whether a lone one sits in a
   *  folder of its own, and where its agent starts: a repo or `.`. Unset,
   *  each takes what the project last used (docs/project-repos.md). */
  repos?: RepoStart[]
  nested?: boolean
  cwd?: string
  /** The sidebar group to file it under, by id. */
  groupId?: string
  /** A group to create and file it under, by name. */
  newGroup?: string
  /** The draft this create is made from, deleted once it has succeeded. */
  draftId?: string
  /** Minutes until the server stops it. */
  timeout?: number
  /** A pane to open once the workspace is up. */
  pane?: LaunchPane
  /** The project volume to attach, by name. */
  volume?: string
}

export async function createWorkspace(
  workspaceId: string,
  c: WorkspaceCreate,
  onProgress: (message: string) => void,
): Promise<CreateWorkspaceResult> {
  const group = c.groupId ?? c.newGroup
  // Minted here, like the workspace's, so the panes standing in for the
  // session's chat show the whole message this tab sent (`useOpening`).
  const sessionId = c.noSession === true ? undefined : randomUUID()
  if (sessionId !== undefined && c.prompt) rememberOpening(sessionId, c.prompt)
  const body = {
    project: c.projectId,
    workspaceId,
    ...(sessionId === undefined
      ? { noSession: true }
      : { sessionId, tool: c.tool, mode: c.mode, permissionMode: c.permissionMode }),
    ...(c.model ? { model: c.model } : {}),
    ...(c.effort !== undefined ? { effort: c.effort } : {}),
    ...(c.agentOptions !== undefined ? { agentOptions: c.agentOptions } : {}),
    ...(c.prompt ? { prompt: c.prompt } : {}),
    ...(c.title ? { title: c.title } : {}),
    ...(c.repos !== undefined ? { repos: c.repos } : {}),
    ...(c.nested !== undefined ? { nested: c.nested } : {}),
    ...(c.cwd !== undefined ? { cwd: c.cwd } : {}),
    ...(group !== undefined ? { group } : {}),
    ...(c.draftId !== undefined ? { draftId: c.draftId } : {}),
    ...(c.timeout !== undefined ? { timeout: c.timeout } : {}),
    ...(c.volume !== undefined ? { volume: c.volume } : {}),
    // A failed create's prompt lands in the sidebar as a draft to retry from.
    draftOnFailure: true,
  }
  return await streamWorkspaceOp('/api/workspace/create', body, onProgress) as CreateWorkspaceResult
}

/** Restart a stopped workspace. `volume` names a volume to attach, null
 *  starts it without one, and absent attaches the one it last held. */
export async function restartWorkspace(
  workspaceId: string,
  onProgress: (message: string) => void,
  volume?: string | null,
): Promise<{ workspaceId: string }> {
  const body = { workspaceId, ...(volume !== undefined ? { volume } : {}) }
  return await streamWorkspaceOp('/api/workspace/restart', body, onProgress) as { workspaceId: string }
}

/** Rerun a non-interactive workspace (docs/workspace-steps.md): a new one,
 *  under `rerunId`, with its steps at the commit it ran at, or with
 *  `interactive` an interactive one there. */
export async function rerunWorkspace(
  workspaceId: string,
  rerunId: string,
  interactive: boolean,
  onProgress: (message: string) => void,
): Promise<{ workspaceId: string }> {
  const body = { workspaceId, rerunId, ...(interactive ? { interactive: true } : {}) }
  return await streamWorkspaceOp('/api/workspace/rerun', body, onProgress) as { workspaceId: string }
}

/** Dismiss a failed create/restart's provisioning row. Idempotent. */
export async function dismissProvisioning(workspaceId: string): Promise<void> {
  await api.workspace.provisioning[':id'].dismiss.$post({ param: { id: workspaceId } })
}

export async function stopWorkspace(workspaceId: string): Promise<void> {
  await api.workspace.stop.$post({ json: { workspaceId } })
}

/** What a session is opened with in a running workspace; unset fields
 *  resolve as a create's. */
export interface SessionOpen {
  tool?: AgentTool
  mode?: AgentMode
  permissionMode?: PermissionMode
  model?: string
  effort?: string
  agentOptions?: AgentOptions
  prompt?: string
  /** One of the workspace's earlier conversations to resume. */
  resume?: string
  /** Where its agent runs: `.` for the workspace root or a checkout's
   *  path. Unset is the workspace's own cwd. */
  cwd?: string
}

/** Open a session in a running workspace; resolves with its id once its
 *  window is launched. */
export async function openSession(workspaceId: string, s: SessionOpen): Promise<string> {
  const { sessionId } = await api.workspace[':id'].sessions.$post({ param: { id: workspaceId }, json: s })
  return sessionId
}

/** Change some of a running session's agent options. */
export async function setSessionAgentOptions(workspaceId: string, sessionId: string, options: AgentOptions): Promise<void> {
  await api.workspace[':id'].sessions[':sessionId']['agent-options'].$post({ param: { id: workspaceId, sessionId }, json: options })
}

/** Close a session: its agent stops, its conversations stay as history. */
export async function closeSession(workspaceId: string, sessionId: string): Promise<void> {
  await api.workspace[':id'].sessions[':sessionId'].close.$post({ param: { id: workspaceId, sessionId } })
}

/** Relaunch a session whose agent exited. */
export async function resumeSession(workspaceId: string, sessionId: string): Promise<void> {
  await api.workspace[':id'].sessions[':sessionId'].resume.$post({ param: { id: workspaceId, sessionId } })
}

/** Set a workspace's display title; blank clears it. */
export async function renameWorkspace(workspaceId: string, title: string): Promise<void> {
  await api.workspace[':id'].title.$post({ param: { id: workspaceId }, json: { title } })
}

