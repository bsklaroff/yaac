/**
 * Runs in-workspace `yaac-mama` commands. Both ways in (the k8s proxy relay
 * and the containerless route) end here, so `MAMA_COMMANDS` is enforced for
 * both.
 *
 * An agent may list the project's workspaces, create or queue one, edit what
 * it queued, send a running one a message, retitle, group, stop one (its own
 * included), fetch another's branches and read another's conversation
 * history, and change its own reference branch. Stopping is allowed because
 * it is reversible: the checkout, row and conversations are kept. Deleting, restarting and reconfiguring stay
 * the user's.
 *
 * The caller's identity comes from the transport (pod IP under k8s, a
 * per-workspace token under containerless), never the request, and every
 * command is scoped to the caller's project.
 */
import { decideSpawn, type SpawnRequest } from './spawn-policy'
import { listActiveWorkspaces } from './list'
import { listWorkspaceGroups, resolveGroup } from './groups'
import {
  getProjectRow,
  getProjectWorkspaceRows,
  applyWorkspaceEvent,
  getWorkspaceRow,
  listActiveAgentSessions,
  listQueuedWorkspaceRows,
  listWorkspaceAgentSessions,
  setWorkspaceGroup,
  setWorkspaceTitle,
  type QueuedWorkspaceRow,
} from '#db'
import { resolveWorkspace, resolveWorkspaceContainer } from './resolve'
import { stopWorkspace } from './stop'
import { queueWorkspace, updateQueuedWorkspace, type QueueRequest } from './queued-workspaces'
import { ServerError } from '@yaac/shared/errors'
import { stripControlChars } from '@yaac/shared/ansi'
import { MAX_TITLE_LENGTH, normalizeTitle } from '@yaac/shared/titles'
import {
  AGENT_MODES,
  AGENT_TOOLS,
  MAMA_COMMANDS,
  EFFORT_RE,
  MODEL_RE,
  PERMISSION_MODES,
  isRankedPermissionMode,
  morePermissive,
  type AgentMode,
  type AgentTool,
  type PermissionMode,
  type MamaCommand,
  type WorkspaceListEntry,
} from '@yaac/shared/types'
import { loadToolAuthEntry, modelsForTool } from '#domain/auth'
import { agentDriver, resolveAgentPermissionMode } from '#runtime/agents'
import { liveAgents } from '#runtime/status'
import { bundleCheckout, listRemoteBranches } from '#domain/git'
import { fetchProjectOrigin } from '#domain/projects'
import { testEnv } from '@yaac/shared/env'
import { repoDir, workspaceDir } from '@yaac/shared/project-paths'
import {
  formatSize,
  historyFiles,
  historyTranscripts,
  MAX_HISTORY_FILE_BYTES,
  oversized,
  withFiles,
  type HistoryConversation,
} from './history-export'
import type { Actor } from '#domain/access'

/** Who is asking — resolved by the transport, never taken from the request. */
export interface MamaCaller {
  /** The calling workspace. */
  workspaceId: string
  /** Who its writes act for (`workspacePrincipal`). */
  principal: Actor
  /** Its project. Every command is scoped to this and nothing else. */
  projectId: string
  /** The tool it runs, if known; used in the spawned workspace's tool
   *  precedence. */
  tool?: AgentTool
}

/** One command as received, not yet validated. */
export interface MamaRequestInput {
  command: string
  args: Record<string, string>
  body: string
}

export type MamaOutcome =
  | { ok: true; output: string }
  /** A file about `workspaceId` (and one of its conversations): `fetch`'s
   *  git bundle, or `history`'s transcripts, database or one file. */
  | {
    ok: true
    body: Buffer<ArrayBuffer> | ReadableStream<Uint8Array>
    contentType: string
    workspaceId: string
    conversationId?: string
  }
  | { ok: false; error: string }

/**
 * Longest group name, the store's cap. Longer names are refused rather than
 * truncated, which could merge two distinct names into one group.
 */
const MAX_GROUP_NAME_CHARS = MAX_TITLE_LENGTH

/** The options every command that makes a workspace takes. */
const CREATE_ARGS = ['tool', 'model', 'effort', 'permission-mode', 'ui-mode', 'branch', 'group', 'title'] as const

/**
 * Options each command accepts. Others are refused rather than ignored, so a
 * request never silently does less than it said. Checked here so both
 * transports behave the same.
 */
const COMMAND_ARGS: Record<MamaCommand, readonly string[]> = {
  list: [],
  create: CREATE_ARGS,
  rename: ['workspace'],
  'set-base': [],
  stop: ['workspace'],
  'group-create': [],
  'group-move': ['workspace'],
  models: [],
  queue: ['parent-workspace', ...CREATE_ARGS],
  'edit-queued': ['queued', 'parent-workspace', ...CREATE_ARGS],
  fetch: ['workspace'],
  history: ['workspace', 'conversation', 'files', 'file'],
  send: ['workspace', 'conversation'],
}

/**
 * Run one `yaac-mama` command for a workspace and return the text for its
 * stdout (plain text, since the reader is an agent via a shell script).
 * Errors are returned, never thrown, so the transport always has an answer.
 */
export async function runMamaCommand(
  caller: MamaCaller,
  request: MamaRequestInput,
): Promise<MamaOutcome> {
  if (!(MAMA_COMMANDS as readonly string[]).includes(request.command)) {
    return {
      ok: false,
      error: `unknown command '${request.command}' (expected one of: ${MAMA_COMMANDS.join(', ')})`,
    }
  }
  const command = request.command as MamaCommand
  const accepted = COMMAND_ARGS[command]
  for (const name of Object.keys(request.args)) {
    if (!accepted.includes(name)) {
      return {
        ok: false,
        error: accepted.length === 0
          ? `${command} takes no options (got '--${name}')`
          : `${command} does not take '--${name}' (expected: ${accepted.map((a) => `--${a}`).join(', ')})`,
      }
    }
  }
  try {
    switch (command) {
      case 'list': return await runList(caller, request)
      case 'create': return await runCreate(caller, request)
      case 'rename': return await runRename(caller, request)
      case 'set-base': return await runSetBase(caller, request)
      case 'stop': return await runStop(caller, request)
      case 'group-create': return await runGroupCreate(caller, request)
      case 'group-move': return await runGroupMove(caller, request)
      case 'models': return await runModels(caller)
      case 'queue': return await runQueue(caller, request)
      case 'edit-queued': return await runEditQueued(caller, request)
      case 'fetch': return await runFetch(caller, request)
      case 'history': return await runHistory(caller, request)
      case 'send': return await runSend(caller, request)
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * The caller's project, as it would look in the sidebar. Ids (or unique
 * prefixes) in the body, whitespace-separated, narrow it to those running or
 * queued workspaces and add each one's full prompt, which the table cuts
 * short, indented under a header.
 */
async function runList(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const [active, groups, allQueued] = await Promise.all([
    listActiveWorkspaces(caller.projectId),
    listWorkspaceGroups(caller.projectId),
    listQueuedWorkspaceRows(caller.projectId),
  ])
  let workspaces = active.workspaces
  let queued = allQueued
  const names = new Map(groups.map((g) => [g.groupId, g.name]))

  const wanted = request.body.split(/\s+/).filter((t) => t !== '')
  const prompts: Array<{ id: string; prompt: string }> = []
  if (wanted.length > 0) {
    const entries = [
      ...workspaces.map((w) => ({ id: w.workspaceId, prompt: w.prompt ?? '' })),
      ...queued.map((r) => ({ id: r.id, prompt: r.prompt })),
    ]
    for (const token of wanted) {
      const picked = pickOne(entries, token, 'running or queued workspace')
      if (!picked.ok) return picked
      if (!prompts.some((p) => p.id === picked.entry.id)) prompts.push(picked.entry)
    }
    const ids = new Set(prompts.map((p) => p.id))
    workspaces = workspaces.filter((w) => ids.has(w.workspaceId))
    queued = queued.filter((r) => ids.has(r.id))
  }

  const lines: string[] = []
  if (workspaces.length === 0) {
    if (wanted.length === 0) lines.push('No running workspaces in this project.')
  } else {
    lines.push('Running workspaces in this project:', '')
    lines.push(...renderWorkspaces(workspaces, names, caller.workspaceId))
  }
  if (queued.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('Queued workspaces (each starts when what it is under is stopped):', '')
    lines.push(...renderQueued(queued, caller.workspaceId))
  }
  lines.push('')
  lines.push(groups.length === 0
    ? 'No groups yet. Make one with: yaac-mama group create "<name>"'
    : `Groups: ${groups.map((g) => g.name).join(', ')}`)
  // Every prompt line is indented, so a prompt cannot fake another's header.
  for (const p of prompts) {
    const body = p.prompt === '' ? ['(none yet)'] : p.prompt.split('\n')
    lines.push('', `Prompt of ${p.id.slice(0, 8)}:`, ...body.map((l) => `  ${l}`))
  }
  return { ok: true, output: lines.join('\n') }
}

function renderWorkspaces(
  workspaces: WorkspaceListEntry[],
  groupNames: Map<string, string>,
  callerId: string,
): string[] {
  const rows = [...workspaces]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((w) => ({
      id: `${w.workspaceId.slice(0, 8)}${w.workspaceId === callerId ? ' (you)' : ''}`,
      tool: w.tool,
      status: w.status,
      group: w.groupId !== undefined ? groupNames.get(w.groupId) ?? '' : '',
      title: flatten(w.title ?? '', 40),
      prompt: flatten(w.prompt ?? '', 60),
    }))

  const width = (header: string, pick: (r: typeof rows[number]) => string): number =>
    Math.max(header.length, ...rows.map((r) => pick(r).length))
  const idW = width('WORKSPACE', (r) => r.id)
  const toolW = width('TOOL', (r) => r.tool)
  const statusW = width('STATUS', (r) => r.status)
  const groupW = width('GROUP', (r) => r.group)
  // Titles let an agent see its `rename` results; the column is shown only
  // when some workspace has one.
  const hasTitles = rows.some((r) => r.title !== '')
  const titleW = hasTitles ? width('TITLE', (r) => r.title) : 0
  const titleCell = (v: string): string => hasTitles ? `${v.padEnd(titleW)}  ` : ''

  return [
    `${'WORKSPACE'.padEnd(idW)}  ${'TOOL'.padEnd(toolW)}  ${'STATUS'.padEnd(statusW)}  ${'GROUP'.padEnd(groupW)}  ${titleCell('TITLE')}PROMPT`,
    ...rows.map((r) =>
      `${r.id.padEnd(idW)}  ${r.tool.padEnd(toolW)}  ${r.status.padEnd(statusW)}  ${r.group.padEnd(groupW)}  ${titleCell(r.title)}${r.prompt}`),
  ]
}

/** Queued entries as a tree under the workspace each waits on. */
function renderQueued(rows: QueuedWorkspaceRow[], callerId: string): string[] {
  const children = new Map<string, QueuedWorkspaceRow[]>()
  for (const r of rows) {
    const parent = r.parentQueuedId ?? r.parentWorkspaceId ?? ''
    children.set(parent, [...(children.get(parent) ?? []), r])
  }
  const ids = new Set(rows.map((r) => r.id))
  const lines: string[] = []
  const walk = (parent: string, depth: number): void => {
    for (const r of children.get(parent) ?? []) {
      const status = r.launchWorkspaceId !== undefined ? `launching as ${r.launchWorkspaceId.slice(0, 8)}`
        : r.launchError !== undefined ? `failed: ${flatten(r.launchError, 60)}`
        : 'queued'
      lines.push(`${'  '.repeat(depth + 1)}${r.id.slice(0, 8)}  ${r.tool}  ${status}  ${flatten(r.prompt, 60)}`)
      walk(r.id, depth + 1)
    }
  }
  for (const parent of children.keys()) {
    if (ids.has(parent)) continue
    lines.push(`after ${parent.slice(0, 8)}${parent === callerId ? ' (you)' : ''}:`)
    walk(parent, 0)
  }
  return lines
}

/** The one entry whose id is `token`, or else the only one it prefixes. */
function pickOne<T extends { id: string }>(
  entries: T[],
  token: string,
  what: string,
): { ok: true; entry: T } | { ok: false; error: string } {
  const exact = entries.find((e) => e.id === token)
  const matches = exact !== undefined ? [exact] : entries.filter((e) => e.id.startsWith(token))
  if (matches.length === 1) return { ok: true, entry: matches[0] }
  return {
    ok: false,
    error: matches.length === 0
      ? `no ${what} '${token}' in this project`
      : `'${token}' matches more than one ${what} in this project — use a longer prefix`,
  }
}

function flatten(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`
}

/**
 * Start a sibling workspace in the caller's project. `decideSpawn` makes the
 * decisions; this supplies the caller's permission mode from its row.
 */
async function runCreate(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const callerRow = await getWorkspaceRow(caller.projectId, caller.workspaceId)
  // Without a row there is no permission mode to cap the spawn at.
  if (!callerRow) return { ok: false, error: 'this workspace has no recorded permission mode' }
  const settings = createSettings(request.args)
  if (!settings.ok) return settings

  const decision = await decideSpawn({
    requestId: `mama:${caller.workspaceId}`,
    principal: caller.principal,
    callerWorkspaceId: caller.workspaceId,
    callerProjectId: caller.projectId,
    ...(caller.tool !== undefined ? { callerTool: caller.tool } : {}),
    callerPermissionMode: callerRow.permissionMode,
    ...(callerRow.mode !== undefined ? { callerMode: callerRow.mode } : {}),
    prompt: request.body,
    ...settings.settings,
  })
  return decision.ok
    // The id alone, so `id=$(yaac-mama create "…")` works.
    ? { ok: true, output: decision.workspaceId }
    : { ok: false, error: decision.error }
}

/**
 * Queue a workspace to start when its parent (a workspace in this project,
 * often the caller itself, or another queued entry) stops. Settings default
 * from the parent; the permission mode is capped at the caller's own.
 */
async function runQueue(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const callerRow = await getWorkspaceRow(caller.projectId, caller.workspaceId)
  if (!callerRow) return { ok: false, error: 'this workspace has no recorded permission mode' }
  const parent = request.args['parent-workspace']?.trim() ?? ''
  if (parent === '') return { ok: false, error: 'queue needs --parent-workspace' }
  const settings = createSettings(request.args)
  if (!settings.ok) return settings
  const entry = await queueWorkspace(caller.principal, caller.projectId, {
    parent,
    prompt: request.body,
    ...queueFields(settings.settings),
  }, { ceiling: callerRow.permissionMode })
  // The id alone, so `a=$(yaac-mama queue …)` can chain the next one after it.
  return { ok: true, output: entry.id }
}

/**
 * Edit a queued workspace in the caller's project: prompt (an empty body
 * keeps it), settings or parent. The permission mode is capped at the
 * caller's own, as in `queue`, so an agent cannot reuse a higher grant the
 * user gave an entry.
 */
async function runEditQueued(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const callerRow = await getWorkspaceRow(caller.projectId, caller.workspaceId)
  if (!callerRow) return { ok: false, error: 'this workspace has no recorded permission mode' }
  const target = request.args.queued?.trim() ?? ''
  if (target === '') return { ok: false, error: 'edit-queued needs a queued workspace id' }
  const picked = pickOne(await listQueuedWorkspaceRows(caller.projectId), target, 'queued workspace')
  if (!picked.ok) return picked
  const settings = createSettings(request.args)
  if (!settings.ok) return settings
  const parent = request.args['parent-workspace']?.trim()
  const patch: Partial<QueueRequest> = {
    ...(request.body !== '' ? { prompt: request.body } : {}),
    ...(parent !== undefined && parent !== '' ? { parent } : {}),
    ...queueFields(settings.settings),
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: 'edit-queued needs a new prompt or an option to change' }
  }
  const entry = await updateQueuedWorkspace(caller.principal, picked.entry.id, patch, { ceiling: callerRow.permissionMode })
  return {
    ok: true,
    output: `Updated queued workspace ${entry.id.slice(0, 8)}: ${entry.tool} ${entry.model}, `
      + `${entry.permissionMode} — ${flatten(entry.prompt, 60)}`,
  }
}

/** Deliveries under way, by sender and by target conversation. */
const sending = new Set<string>()

/**
 * Send a message to a running sibling's agent, as if the user typed it: its
 * first live conversation, or the one `--conversation` names. The message is
 * headed with the caller's id, so the agent can tell a peer's words from its
 * user's and knows where to answer. Only that first line is the server's:
 * the body may claim anything. A busy acp agent takes it mid-turn or queues
 * it. A tui agent gets it submitted on its own, around any draft its user
 * left in the input box, and its own UI queues it if a turn is running
 * (`buildMessageCmd`); the reply waits until it is.
 *
 * Neither the target's row nor the conversation's own reported mode may be
 * more permissive than the caller, or a message would let the caller act
 * through a grant it was never given. The caller itself is refused, since
 * the paste would land in its own running turn. One delivery at a time per
 * caller and per target conversation, so pastes never interleave and a pair
 * of agents cannot pile deliveries onto one pane.
 */
async function runSend(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const workspace = request.args.workspace?.trim() ?? ''
  if (workspace === '') return { ok: false, error: 'send needs a workspace id' }
  // Bound for a terminal whatever the agent's mode, so stripped here once.
  const body = stripControlChars(request.body)
  if (body.trim() === '') return { ok: false, error: 'send needs a message' }
  const found = await resolveWorkspace(workspace, { projectId: caller.projectId })
  if (!found.ok) return { ok: false, error: workspaceError(workspace, found.reason) }
  const { workspaceId } = found
  const short = workspaceId.slice(0, 8)
  if (workspaceId === caller.workspaceId) return { ok: false, error: 'send cannot message this workspace itself' }

  const [callerRow, targetRow] = await Promise.all([
    getWorkspaceRow(caller.projectId, caller.workspaceId),
    getWorkspaceRow(caller.projectId, workspaceId),
  ])
  const ceiling = callerRow?.permissionMode
  if (ceiling === undefined || !isRankedPermissionMode(ceiling)) {
    return { ok: false, error: 'this workspace has no recorded permission mode' }
  }

  const running = await resolveWorkspaceContainer(workspaceId, { requireRunning: true, exact: true })
    .catch((err: unknown) => {
      if (err instanceof ServerError && (err.code === 'NOT_FOUND' || err.code === 'CONFLICT')) return undefined
      throw err
    })
  if (!running) return { ok: false, error: `workspace ${short} is not running` }

  const live = (await listActiveAgentSessions(caller.projectId, workspaceId))
    .flatMap((r) => r.paneId === undefined ? [] : [{ ...r, handle: r.paneId }])
  const wanted = request.args.conversation?.trim() ?? ''
  const exact = live.find((r) => r.agentSessionId === wanted)
  const matches = wanted === '' ? live.slice(0, 1)
    : exact !== undefined ? [exact]
    : live.filter((r) => r.agentSessionId.startsWith(wanted))
  if (matches.length !== 1) {
    return {
      ok: false,
      error: wanted === '' ? `${short} has no running conversation yet`
        : matches.length === 0 ? `no running conversation '${wanted}' in ${short} (see: yaac-mama history ${short})`
        : `'${wanted}' matches more than one running conversation in ${short} — use a longer prefix`,
    }
  }
  const [conversation] = matches
  const label = `${short}'s ${conversation.tool} conversation ${conversation.agentSessionId.slice(0, 8)}`

  // A conversation that never reported a mode runs in the one it launched
  // in, which the row recorded.
  const recorded = targetRow?.permissionMode
  const reported = liveAgents(caller.projectId, workspaceId)
    ?.find((a) => a.handle === conversation.handle)?.reportedMode
  const postures = [
    recorded,
    reported === undefined || recorded === undefined
      ? recorded
      : resolveAgentPermissionMode(conversation.mode, conversation.tool, reported, recorded),
  ]
  for (const posture of postures) {
    if (posture === undefined || !isRankedPermissionMode(posture)) {
      return { ok: false, error: `cannot tell which permission mode ${label} runs in, so it cannot be sent a message` }
    }
    if (morePermissive(posture, ceiling)) {
      return {
        ok: false,
        error: `${label} runs in permission mode '${posture}', more than this workspace's own `
          + `('${ceiling}'); only one at or below it can be sent a message`,
      }
    }
  }

  const from = `from:${caller.workspaceId}`
  const to = `to:${workspaceId}/${conversation.handle}`
  if (sending.has(from)) return { ok: false, error: 'your previous send is still being delivered; send again once it returns' }
  if (sending.has(to)) return { ok: false, error: `another message to ${label} is still being delivered; try again shortly` }
  sending.add(from).add(to)
  try {
    await agentDriver(conversation.mode).deliverPrompt(
      { projectId: caller.projectId, workspaceId, jobName: running.jobName, tool: conversation.tool },
      conversation.handle,
      `Sent from ${caller.workspaceId} via yaac-mama:\n\n${body}`,
      { running: { agentSessionId: conversation.agentSessionId } },
    )
  } catch (err) {
    return { ok: false, error: `not delivered to ${label}: ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    sending.delete(from)
    sending.delete(to)
  }
  return {
    ok: true,
    output: `Sent to ${label}. A busy agent takes it once its current turn allows; `
      + 'read its reply with yaac-mama history.',
  }
}

/** Settings shared by `create`, `queue` and `edit-queued`. */
type CreateSettings = Pick<
  SpawnRequest,
  'tool' | 'model' | 'permissionMode' | 'effort' | 'uiMode' | 'branch' | 'group' | 'title'
>

/**
 * Validate the shared create options. The group stays a name, resolved
 * (and created) only after the command's own checks pass, so a refused
 * request creates no group.
 */
function createSettings(
  args: Record<string, string>,
): { ok: true; settings: CreateSettings } | { ok: false; error: string } {
  const { tool, model, effort, branch, group } = args
  const permissionMode = args['permission-mode']
  const uiMode = args['ui-mode']
  if (tool !== undefined && !(AGENT_TOOLS as readonly string[]).includes(tool)) {
    return { ok: false, error: `invalid tool '${tool}' (expected one of: ${AGENT_TOOLS.join(', ')})` }
  }
  if (model !== undefined && !MODEL_RE.test(model)) {
    return { ok: false, error: `invalid model '${model}'` }
  }
  if (permissionMode !== undefined && !(PERMISSION_MODES as readonly string[]).includes(permissionMode)) {
    return {
      ok: false,
      error: `invalid permission mode '${permissionMode}' (expected one of: ${PERMISSION_MODES.join(', ')})`,
    }
  }
  // Checked against the model by the create itself; here only its shape.
  if (effort !== undefined && !EFFORT_RE.test(effort)) {
    return { ok: false, error: `invalid effort '${effort}' (see \`yaac-mama models\`)` }
  }
  if (uiMode !== undefined && !(AGENT_MODES as readonly string[]).includes(uiMode)) {
    return { ok: false, error: `invalid ui mode '${uiMode}' (expected one of: ${AGENT_MODES.join(', ')})` }
  }
  if (branch !== undefined && branch.trim() === '') return { ok: false, error: 'branch must not be empty' }
  const title = args.title !== undefined ? normalizeTitle(args.title) : undefined
  if (title === '') return { ok: false, error: 'title must not be empty' }
  return {
    ok: true,
    settings: {
      ...(tool !== undefined ? { tool: tool as AgentTool } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(permissionMode !== undefined ? { permissionMode: permissionMode as PermissionMode } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(uiMode !== undefined ? { uiMode: uiMode as AgentMode } : {}),
      ...(branch !== undefined ? { branch: branch.trim() } : {}),
      ...(group !== undefined ? { group } : {}),
      ...(title !== undefined ? { title } : {}),
    },
  }
}

/** The same settings in the shape a queue write takes. */
function queueFields({ uiMode, ...rest }: CreateSettings): Partial<QueueRequest> {
  return { ...rest, ...(uiMode !== undefined ? { mode: uiMode } : {}) }
}

/** Retitle a workspace, by default the caller itself. */
async function runRename(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const target = await resolveTargetWorkspace(caller, request.args.workspace)
  if (!target.ok) return target
  const workspaceId = target.workspaceId

  const title = request.body.trim()
  if (title === '') return { ok: false, error: 'rename needs a title' }
  await setWorkspaceTitle(caller.projectId, workspaceId, title)
  // Read back the stored (normalized) title.
  const stored = (await getProjectWorkspaceRows(caller.projectId)).get(workspaceId)?.title
  return { ok: true, output: `Renamed ${workspaceId.slice(0, 8)} to "${stored ?? title}".` }
}

/** How long after one fetch of origin `set-base` may start another. */
const SET_BASE_FETCH_INTERVAL_MS = 10_000

/**
 * Whether `name` could name a branch under `git check-ref-format --branch`'s
 * rules, so `set-base` refuses one that never could without fetching.
 */
function isBranchName(name: string): boolean {
  return /^(?![-./])[^\p{Cc} ~^:?*[\\]+$/u.test(name)
    && !/\.\.|@\{|\/[./]|\.lock(?:\/|$)|[/.]$/.test(name)
    && name !== '@'
}

/**
 * Point the caller's reference branch (`workspaces.baseBranch`) at another
 * branch on origin, as when its work is stacked on another PR's. That is the
 * webapp's default diff base and what a workspace queued after it forks
 * from; the checkout itself is the agent's to rebase. A branch the main
 * clone lacks may have just been pushed, so origin is fetched before it is
 * refused, at most once per `SET_BASE_FETCH_INTERVAL_MS`. Only branch names
 * are taken, never revisions like `main~1`.
 */
async function runSetBase(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const branch = request.body.trim()
  if (branch === '') return { ok: false, error: 'set-base needs a branch' }
  if (!isBranchName(branch)) return { ok: false, error: `"${branch}" is not a branch name` }
  const repo = repoDir(caller.projectId)
  const onOrigin = async (): Promise<boolean> => (await listRemoteBranches(repo)).includes(branch)
  if (!await onOrigin()) {
    if (!testEnv.e2eSkipFetch) {
      await fetchProjectOrigin(caller.projectId, { unlessWithinMs: SET_BASE_FETCH_INTERVAL_MS })
    }
    if (!await onOrigin()) {
      return {
        ok: false,
        error: `branch "${branch}" not found on origin (pushed just now? retry in ${SET_BASE_FETCH_INTERVAL_MS / 1000}s)`,
      }
    }
  }
  await applyWorkspaceEvent({
    type: 'base-branch-resolved',
    projectId: caller.projectId,
    workspaceId: caller.workspaceId,
    baseBranch: branch,
  })
  return {
    ok: true,
    output: `${caller.workspaceId.slice(0, 8)} is now based on ${branch}: the webapp diffs it `
      + `against origin/${branch}, and what is queued under it from now on forks from there. `
      + `Your commits have not moved; rebase onto origin/${branch} yourself if they should.`,
  }
}

/**
 * Resolve a `--workspace` argument within the caller's project; omitted
 * means the caller. An ambiguous prefix fails.
 */
async function resolveTargetWorkspace(
  caller: MamaCaller,
  workspace: string | undefined,
  opts: { provisioning?: boolean } = {},
): Promise<{ ok: true; workspaceId: string } | { ok: false; error: string }> {
  const target = workspace === undefined || workspace.trim() === ''
    ? caller.workspaceId
    : workspace.trim()
  const resolved = await resolveWorkspace(target, { projectId: caller.projectId, ...opts })
  return resolved.ok
    ? resolved
    : { ok: false, error: workspaceError(target, resolved.reason) }
}

/** Distinct messages for an unknown id and an ambiguous prefix, since
 *  they need different fixes. */
function workspaceError(target: string, reason: 'not-found' | 'ambiguous'): string {
  return reason === 'ambiguous'
    ? `'${target}' matches more than one workspace in this project — use a longer prefix`
    : `no workspace '${target}' in this project`
}

/**
 * Stop a workspace, by default the caller (an agent winding itself down
 * after its work). The checkout is kept for restart. A self-stop's reply is
 * best-effort, since the teardown removes the transport it travels on.
 */
async function runStop(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  // A sibling still being created may have no row yet.
  const target = await resolveTargetWorkspace(caller, request.args.workspace, { provisioning: true })
  if (!target.ok) return target

  let stopped: { provisioning?: true }
  try {
    stopped = await stopWorkspace(caller.principal, target.workspaceId)
  } catch (err) {
    // The id resolved against rows, so NOT_FOUND here means not running.
    if (err instanceof ServerError && err.code === 'NOT_FOUND') {
      return { ok: false, error: `workspace ${target.workspaceId.slice(0, 8)} is not running` }
    }
    throw err
  }
  return {
    ok: true,
    output: stopped.provisioning === true
      ? `Stopped ${target.workspaceId.slice(0, 8)} while it was starting.`
      : `Stopped ${target.workspaceId.slice(0, 8)}. Its checkout is kept — `
        + 'the user can restart it from the yaac webapp.',
  }
}

async function runGroupCreate(
  caller: MamaCaller,
  request: MamaRequestInput,
): Promise<MamaOutcome> {
  const name = request.body.trim()
  if (name === '') return { ok: false, error: 'group name must not be empty' }
  if (name.length > MAX_GROUP_NAME_CHARS) {
    return { ok: false, error: `group name exceeds ${MAX_GROUP_NAME_CHARS} characters` }
  }
  // Idempotent: an existing group of that name is reused.
  const group = await resolveGroup(caller.projectId, name, { create: true })
  return { ok: true, output: `Group "${group.name}" is ready (${group.groupId}).` }
}

async function runGroupMove(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const workspace = request.args.workspace
  if (workspace === undefined || workspace.trim() === '') {
    return { ok: false, error: 'group move needs a workspace id' }
  }
  const found = await resolveWorkspace(workspace, { projectId: caller.projectId })
  if (!found.ok) {
    return { ok: false, error: workspaceError(workspace.trim(), found.reason) }
  }
  const workspaceId = found.workspaceId

  const target = request.body.trim()
  // No group (or `--`) means ungrouped.
  const resolved = target === '--' || target === ''
    ? null
    : await resolveGroup(caller.projectId, target, { create: true })
  await setWorkspaceGroup(caller.projectId, workspaceId, resolved?.groupId ?? null)
  return {
    ok: true,
    output: resolved === null
      ? `Moved ${workspaceId.slice(0, 8)} out of its group.`
      : `Moved ${workspaceId.slice(0, 8)} into "${resolved.name}".`,
  }
}

/**
 * A git bundle of another workspace's branches and HEAD, running or stopped,
 * for the caller to fetch into its own checkout. Its git dir is read as
 * data, never run (`bundleCheckout`), and nothing is written to it.
 */
async function runFetch(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const workspace = request.args.workspace?.trim() ?? ''
  if (workspace === '') return { ok: false, error: 'fetch needs a workspace id' }
  const found = await resolveWorkspace(workspace, { projectId: caller.projectId })
  if (!found.ok) return { ok: false, error: workspaceError(workspace, found.reason) }
  const { workspaceId } = found
  try {
    const bundle = await bundleCheckout(workspaceDir(caller.projectId, workspaceId), repoDir(caller.projectId))
    return { ok: true, body: bundle, contentType: 'application/x-git-bundle', workspaceId }
  } catch (err) {
    return { ok: false, error: `cannot read ${workspaceId.slice(0, 8)}'s git: ${(err as Error).message}` }
  }
}

/**
 * Another workspace's conversations, running or stopped: a listing; one
 * conversation's transcripts as JSONL (an opencode one's database, which the
 * script converts); with `files`, the names of every file of one
 * conversation or all of them, one `<conversation>/<name>` per line; or with
 * `file`, one of those files. Only reads, like `fetch`.
 *
 * Saving files is a file at a time rather than one archive because a
 * workspace on a standalone image may not be able to unpack one: GNU tar
 * extracts through `openat2`, which gVisor does not implement. The server
 * never queries an opencode database, which a sandboxed workspace wrote; the
 * caller's script does, in its own sandbox.
 */
async function runHistory(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const workspace = request.args.workspace?.trim() ?? ''
  if (workspace === '') return { ok: false, error: 'history needs a workspace id' }
  const found = await resolveWorkspace(workspace, { projectId: caller.projectId })
  if (!found.ok) return { ok: false, error: workspaceError(workspace, found.reason) }
  const { workspaceId } = found
  // Pick the conversation before gathering files, which reads every one's.
  let rows = await listWorkspaceAgentSessions(caller.projectId, workspaceId)

  const wanted = request.args.conversation?.trim() ?? ''
  if (wanted !== '') {
    const exact = rows.find((r) => r.agentSessionId === wanted)
    const matches = exact !== undefined ? [exact] : rows.filter((r) => r.agentSessionId.startsWith(wanted))
    if (matches.length !== 1) {
      return {
        ok: false,
        error: matches.length === 0
          ? `no conversation '${wanted}' in ${workspaceId.slice(0, 8)} (see: yaac-mama history ${workspaceId.slice(0, 8)})`
          : `'${wanted}' matches more than one conversation in ${workspaceId.slice(0, 8)} — use a longer prefix`,
      }
    }
    rows = matches
  }
  const conversations = await withFiles(caller.projectId, workspaceId, rows)

  // A file over the cap is named on a `# ` line, which the script reports
  // and skips.
  if (request.args.files !== undefined) {
    return {
      ok: true,
      output: conversations.flatMap((c) => c.files.map((f) => oversized(f)
        ? `# skipped ${c.row.agentSessionId}/${f.name}: ${formatSize(f.size)}, past the `
          + `${formatSize(MAX_HISTORY_FILE_BYTES)} a file is handed out at`
        : `${c.row.agentSessionId}/${f.name}`)).join('\n'),
    }
  }
  if (wanted === '') return { ok: true, output: renderHistory(workspaceId, conversations) }
  const [{ row, files }] = conversations
  const name = request.args.file
  if (name !== undefined) {
    const file = files.find((f) => f.name === name)
    return file === undefined
      ? { ok: false, error: `${row.agentSessionId} has no file '${name}'` }
      : { ok: true, body: historyFiles([file]), contentType: 'application/octet-stream', workspaceId }
  }
  // opencode's history is its database, which the script turns into JSONL.
  const database = files.find((f) => f.sqlite === true)
  if (database !== undefined) {
    return {
      ok: true,
      body: historyFiles([database]),
      contentType: 'application/vnd.sqlite3',
      workspaceId,
      conversationId: row.agentSessionId,
    }
  }
  if (!files.some((f) => f.name.endsWith('.jsonl'))) {
    return { ok: false, error: `${row.agentSessionId} has no transcript on the host yet` }
  }
  return { ok: true, body: historyTranscripts(files), contentType: 'application/x-ndjson', workspaceId }
}

function renderHistory(workspaceId: string, conversations: HistoryConversation[]): string {
  const short = workspaceId.slice(0, 8)
  if (conversations.length === 0) return `${short} has no recorded conversations.`
  const rows = conversations.map(({ row, files }) => {
    const last = Math.max(0, row.lastActiveAt?.getTime() ?? 0, ...files.map((f) => f.mtimeMs))
    return [
      row.agentSessionId,
      row.tool,
      row.mode,
      row.active ? 'yes' : 'no',
      row.model ?? '',
      last > 0 ? new Date(last).toISOString().slice(0, 16).replace('T', ' ') : '',
      String(files.length),
      formatSize(files.reduce((n, f) => n + f.size, 0)),
      flatten(row.firstPrompt ?? '', 50),
    ]
  })
  const header = ['CONVERSATION', 'TOOL', 'MODE', 'ACTIVE', 'MODEL', 'LAST ACTIVE (UTC)', 'FILES', 'SIZE', 'OPENING']
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const line = (cells: string[]): string =>
    cells.map((c, i) => i === cells.length - 1 ? c : c.padEnd(widths[i])).join('  ').trimEnd()
  return [
    `Conversations of ${short}, first held first:`,
    '',
    line(header),
    ...rows.map(line),
    '',
    `Print one's transcripts: yaac-mama history ${short} <conversation>`,
    `Save every file:         yaac-mama history ${short} [<conversation>] -o <dir>`,
    ...(conversations.some((c) => c.files.some(oversized))
      ? [`Files over ${formatSize(MAX_HISTORY_FILE_BYTES)} are not handed out; -o names those it skips.`]
      : []),
  ].join('\n')
}

/**
 * Which agent tools the project's owner has signed in to, and each one's
 * models. A workspace cannot tell this itself.
 */
async function runModels(caller: MamaCaller): Promise<MamaOutcome> {
  const owner = (await getProjectRow(caller.projectId))?.owner
  const entries = await Promise.all(AGENT_TOOLS.map(async (tool) => ({
    tool,
    auth: owner === undefined ? null : await loadToolAuthEntry(owner, tool),
  })))

  const lines = [`Agent tools signed in for this project (this workspace runs: ${caller.tool ?? 'unknown'})`, '']
  for (const { tool, auth } of entries) {
    if (!auth) {
      lines.push(`${tool.padEnd(9)} not configured — its agent cannot authenticate`)
      continue
    }
    const provider = 'opencodeProvider' in auth ? auth.opencodeProvider
      : 'piProvider' in auth ? auth.piProvider
      : undefined
    // Each model's effort levels follow it, its default starred.
    const models = modelsForTool(tool, provider).map((m) => {
      const efforts = m.efforts !== undefined
        ? ` [effort ${m.efforts.levels.map((l) => (l === m.efforts?.default ? `${l}*` : l)).join(' ')}]`
        : ''
      return `${m.id}${m.name !== undefined ? ` (${m.name})` : ''}${efforts}`
    })
    lines.push(`${tool.padEnd(9)} ${auth.kind}${provider ? ` (${provider})` : ''}`)
    if (models.length > 0) lines.push(`          models: ${models.join(', ')}`)
  }
  lines.push('', 'Pass one with: yaac-mama create --tool <tool> --model <model> [--effort <level>] "<prompt>"')
  return { ok: true, output: lines.join('\n') }
}
