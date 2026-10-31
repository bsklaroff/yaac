/**
 * Runs in-workspace `yaac-mama` commands. Both ways in (the k8s proxy relay
 * and the containerless route) end here, so `MAMA_COMMANDS` is enforced for
 * both.
 *
 * An agent may list the project's workspaces (running, queued or stopped),
 * create or queue one, edit, run or discard a queued one, manage routines,
 * send a running one a message, retitle, group, stop one (its own
 * included), restart a stopped one, fetch another's branches and read
 * another's conversation history, and change its own reference branch.
 * Stopping is allowed because it is reversible: the checkout, row and
 * conversations are kept. Restarting a stopped workspace only undoes a
 * stop, and is held to the caller's own permission mode, as is everything a
 * routine launches. Discarding a queued workspace loses only a prompt and
 * settings that never ran; deleting a routine loses its schedule and the
 * run history it lists, but no run's workspace. Deleting a workspace and
 * reconfiguring stay the user's.
 *
 * The caller's workspace comes from the transport (pod IP under k8s, a
 * per-workspace token under containerless), never the request, and every
 * command is scoped to the caller's project. Which of its sessions is asking
 * is the agent's word (`mamaCaller`).
 */
import { decideRestart, decideSpawn, type SpawnRequest } from './spawn-policy'
import { listStoppedWorkspaces, toStoppedEntries } from './stopped-list'
import { listActiveWorkspaces } from './list'
import { inFlightWorkspaceIds } from './provisioning'
import { listWorkspaceGroups, resolveGroup } from './groups'
import { moveWorkspaceToGroup, setGroupWorkspaceLimit } from './group-edits'
import {
  discardQueuedWorkspace,
  queueWorkspace,
  runQueuedWorkspace,
  updateQueuedWorkspace,
  type QueueRequest,
  type QueueStart,
} from './queued-workspaces'
import { resolveProjectWorkspace, resolveWorkspaceContainer } from './resolve'
import {
  createRoutine,
  deleteRoutine,
  listRoutines,
  runRoutineNow,
  setRoutinePaused,
  updateRoutine,
} from './routines'
import { stopWorkspace } from './stop'
import { closeSession } from './sessions'
import {
  getProjectRow,
  getProjectWorkspaceRows,
  getTimeZone,
  applyWorkspaceEvent,
  getWorkspaceRow,
  listQueuedWorkspaceRows,
  listWorkspaceConversations,
  listWorkspaceSessions,
  setWorkspaceTitle,
  type QueuedWorkspaceRow,
} from '#db'
import { ServerError } from '@yaac/shared/errors'
import { stripControlChars } from '@yaac/shared/ansi'
import { MAX_TITLE_LENGTH, normalizeTitle } from '@yaac/shared/titles'
import { formatDuration, formatInZone, minutesUntil, parseDuration } from '@yaac/shared/schedule'
import {
  AGENT_MODES,
  AGENT_TOOLS,
  MAMA_COMMANDS,
  EFFORT_RE,
  MODEL_RE,
  PERMISSION_MODES,
  isRankedPermissionMode,
  morePermissive,
  routineSettingsSchema,
  timeoutMinutesSchema,
  type AgentMode,
  type AgentTool,
  type PermissionMode,
  type MamaCommand,
  type RoutineEntry,
  type RoutineSettings,
  type StoppedWorkspaceEntry,
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
import { workspacePrincipal, type Actor } from '#domain/access'
import type { SessionRow } from '#db'
import { resolveCreate } from './create'

/** Who is asking — resolved by the transport and `mamaCaller`. */
export interface MamaCaller {
  /** The calling workspace. */
  workspaceId: string
  /** The calling session, when the call came from one's agent. */
  sessionId?: string
  /** Who its writes act for (`workspacePrincipal`). */
  principal: Actor
  /** Its project. Every command is scoped to this and nothing else. */
  projectId: string
  /** The tool it runs, if known; used in the spawned workspace's tool
   *  precedence. */
  tool?: AgentTool
  /** Its permission mode, the most anything it starts or messages may run
   *  in. */
  permissionMode: PermissionMode
  /** Its agent mode, the default for a workspace it starts. */
  mode: AgentMode
}

/**
 * The caller of a `yaac-mama` command, from the workspace the transport
 * identified and the session its agent says it runs in (`YAAC_SESSION_ID`,
 * which every session's launch sets). The session counts only as one of that
 * workspace's open sessions, and then the ceiling is its own posture. A call
 * from outside any session, such as a user's shell, gets the strictest
 * posture among the workspace's open sessions; with none open, among those
 * closed during its current life, since an agent's detached child can
 * outlive its session; and with neither, the one a create would resolve.
 * Anything in the workspace could claim any of its sessions, so this is a
 * guardrail, not a boundary (docs/permission-modes.md).
 */
export async function mamaCaller(
  workspace: { workspaceId: string; projectId: string },
  claimedSessionId: string | undefined,
): Promise<MamaCaller> {
  const { workspaceId, projectId } = workspace
  const sessions = await listWorkspaceSessions(workspaceId, { all: true })
  const open = sessions.filter((s) => s.closedAt === undefined)
  const own = open.find((s) => s.id === claimedSessionId)
  const lifeStarted = (await getWorkspaceRow(projectId, workspaceId))?.lifeStartedAt
  const closedThisLife = sessions.filter((s) =>
    s.closedAt !== undefined && lifeStarted !== undefined && s.closedAt >= lifeStarted)
  const lead = own ?? strictest(open) ?? strictest(closedThisLife) ?? await resolveCreate(projectId, {})
  return {
    workspaceId,
    projectId,
    principal: await workspacePrincipal(workspaceId, projectId),
    ...(own !== undefined ? { sessionId: own.id } : {}),
    tool: lead.tool,
    permissionMode: lead.permissionMode,
    mode: lead.mode,
  }
}

/** The session in the strictest posture; a posture this build does not
 *  rank counts as stricter than any it does. */
function strictest(sessions: SessionRow[]): SessionRow | undefined {
  const stricter = (a: PermissionMode, b: PermissionMode): boolean =>
    !isRankedPermissionMode(a) || (isRankedPermissionMode(b) && morePermissive(b, a))
  return sessions.reduce<SessionRow | undefined>(
    (best, s) => (best === undefined || stricter(s.permissionMode, best.permissionMode) ? s : best), undefined)
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

/** The options `list` takes only with `--stopped`. */
const STOPPED_ARGS = ['search', 'group', 'limit', 'cursor'] as const

/** Stopped workspaces `list --stopped` shows per page, as `yaac workspace
 *  list -s` does, and the most one page may ask for. */
const STOPPED_PAGE_DEFAULT = 25
const STOPPED_PAGE_MAX = 200

/** The options every command that makes a workspace takes. */
const CREATE_ARGS = ['tool', 'model', 'effort', 'permission-mode', 'ui-mode', 'branch', 'group', 'title', 'timeout'] as const

/** The options a routine write takes. Its runs are titled from its name. */
const ROUTINE_ARGS = ['name', 'cron', 'tz', ...CREATE_ARGS.filter((a) => a !== 'title')]

/**
 * Options each command accepts. Others are refused rather than ignored, so a
 * request never silently does less than it said. Checked here so both
 * transports behave the same.
 */
const COMMAND_ARGS: Record<MamaCommand, readonly string[]> = {
  list: ['stopped', ...STOPPED_ARGS],
  create: [...CREATE_ARGS, 'workspace', 'no-session', 'resume'],
  rename: ['workspace'],
  'set-base': [],
  stop: ['workspace', 'session'],
  restart: ['workspace', 'timeout'],
  'group-create': [],
  'group-move': ['workspace'],
  'group-set-limit': ['limit'],
  models: [],
  queue: ['parent-workspace', 'start-at', 'start-in', ...CREATE_ARGS],
  'edit-queued': ['queued', 'parent-workspace', 'no-parent', 'start-at', 'start-in', ...CREATE_ARGS],
  'run-queued': ['queued'],
  'delete-queued': ['queued'],
  'routine-create': ROUTINE_ARGS,
  'routine-edit': ['routine', ...ROUTINE_ARGS],
  'routine-pause': ['routine'],
  'routine-resume': ['routine'],
  'routine-run': ['routine'],
  'routine-delete': ['routine'],
  fetch: ['workspace'],
  history: ['workspace', 'conversation', 'files', 'file'],
  send: ['workspace', 'session', 'conversation'],
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
      case 'restart': return await runRestart(caller, request)
      case 'group-create': return await runGroupCreate(caller, request)
      case 'group-move': return await runGroupMove(caller, request)
      case 'group-set-limit': return await runGroupSetLimit(caller, request)
      case 'models': return await runModels(caller)
      case 'queue': return await runQueue(caller, request)
      case 'edit-queued': return await runEditQueued(caller, request)
      case 'run-queued': return await runRunQueued(caller, request)
      case 'delete-queued': return await runDeleteQueued(caller, request)
      case 'routine-create': return await runRoutineCreate(caller, request)
      case 'routine-edit': return await runRoutineEdit(caller, request)
      case 'routine-pause': return await runRoutinePause(caller, request, true)
      case 'routine-resume': return await runRoutinePause(caller, request, false)
      case 'routine-run': return await runRoutineRun(caller, request)
      case 'routine-delete': return await runRoutineDelete(caller, request)
      case 'fetch': return await runFetch(caller, request)
      case 'history': return await runHistory(caller, request)
      case 'send': return await runSend(caller, request)
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * The caller's project, as it would look in the sidebar: what runs, what is
 * queued, its routines, and how many are stopped. Ids (or unique prefixes)
 * in the body, whitespace-separated, narrow it to those workspaces (running,
 * queued or stopped) and routines, and add each one's full prompt, which
 * the table cuts short, indented under a header. `--stopped` lists the
 * stopped ones instead.
 */
async function runList(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  if (request.args.stopped !== undefined) return await runListStopped(caller, request)
  const stray = STOPPED_ARGS.find((a) => request.args[a] !== undefined)
  if (stray !== undefined) return { ok: false, error: `list takes '--${stray}' only with --stopped` }

  const [active, groups, allQueued, rows, zone, allRoutines] = await Promise.all([
    listActiveWorkspaces(caller.projectId),
    listWorkspaceGroups(caller.projectId),
    listQueuedWorkspaceRows(caller.projectId),
    getProjectWorkspaceRows(caller.projectId),
    ownerTimeZone(caller.projectId),
    projectRoutines(caller.projectId),
  ])
  const clock = { zone, now: new Date() }
  let workspaces = active.workspaces
  let queued = allQueued
  let routines = allRoutines
  // A restart keeps its stop until it succeeds, so one under way is left
  // out as the webapp's sidebar leaves it out.
  const notStopped = new Set([...workspaces.map((w) => w.workspaceId), ...inFlightWorkspaceIds(Date.now())])
  const allStopped = [...rows.values()].filter((r) => r.stoppedAt !== undefined && !notStopped.has(r.workspaceId))
  let stopped: StoppedWorkspaceEntry[] = []
  const names = new Map(groups.map((g) => [g.groupId, g.name]))

  const wanted = request.body.split(/\s+/).filter((t) => t !== '')
  const prompts: Array<{ id: string; prompt: string }> = []
  if (wanted.length > 0) {
    // Stopped prompts are read only for the ones asked about.
    const entries: Array<{ id: string; prompt?: string }> = [
      ...workspaces.map((w) => ({ id: w.workspaceId, prompt: w.prompt ?? '' })),
      ...queued.map((r) => ({ id: r.id, prompt: r.prompt })),
      ...routines.map((r) => ({ id: r.id, prompt: r.prompt })),
      ...allStopped.map((r) => ({ id: r.workspaceId })),
    ]
    const picked: Array<{ id: string; prompt?: string }> = []
    for (const token of wanted) {
      const one = pickOne(entries, token, 'workspace')
      if (!one.ok) return one
      if (!picked.some((p) => p.id === one.entry.id)) picked.push(one.entry)
    }
    const ids = new Set(picked.map((p) => p.id))
    workspaces = workspaces.filter((w) => ids.has(w.workspaceId))
    queued = queued.filter((r) => ids.has(r.id))
    routines = routines.filter((r) => ids.has(r.id))
    stopped = await toStoppedEntries(allStopped.filter((r) => ids.has(r.workspaceId)))
    for (const p of picked) {
      prompts.push({ id: p.id, prompt: p.prompt ?? stopped.find((e) => e.workspaceId === p.id)?.prompt ?? '' })
    }
  }

  const lines: string[] = []
  if (workspaces.length === 0) {
    if (wanted.length === 0) lines.push('No running workspaces in this project.')
  } else {
    lines.push('Running workspaces in this project:', '')
    lines.push(...renderWorkspaces(workspaces, names, caller.workspaceId, clock))
    if (workspaces.some((w) => w.sessions.length > 0)) {
      lines.push('', ...renderSessions(workspaces, caller.sessionId))
    }
  }
  if (stopped.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('Stopped workspaces:', '', ...renderStopped(stopped, names))
  }
  if (queued.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('Queued workspaces (each starts when what it is under is stopped, at its time, or when its group has room):', '')
    lines.push(...renderQueued(queued, names, caller.workspaceId, clock))
  }
  if (routines.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('Routines (each starts a fresh workspace on its cron schedule):', '', ...renderRoutines(routines, clock))
  }
  lines.push('')
  if (wanted.length === 0 && allStopped.length > 0) {
    lines.push(`${allStopped.length} stopped ${allStopped.length === 1 ? 'workspace' : 'workspaces'}: `
      + 'yaac-mama list --stopped')
  }
  lines.push(groups.length === 0
    ? 'No groups yet. Make one with: yaac-mama group create "<name>"'
    : `Groups: ${groups.map((g) => g.workspaceLimit !== undefined ? `${g.name} (limit ${g.workspaceLimit})` : g.name).join(', ')}`)
  // Every prompt line is indented, so a prompt cannot fake another's header.
  for (const p of prompts) {
    const body = p.prompt === '' ? ['(none yet)'] : p.prompt.split('\n')
    lines.push('', `Prompt of ${p.id.slice(0, 8)}:`, ...body.map((l) => `  ${l}`))
  }
  return { ok: true, output: lines.join('\n') }
}

/**
 * The caller's project's stopped workspaces, newest stop first, a page at a
 * time: `--search` matches titles, first prompts and tools, `--group` keeps
 * one group's, and `--cursor` continues where the last page ended.
 */
async function runListStopped(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  if (request.body.trim() !== '') {
    return { ok: false, error: 'list --stopped takes no workspace ids (list <workspace> shows a stopped one)' }
  }
  const { search, group, cursor } = request.args
  const limit = request.args.limit ?? String(STOPPED_PAGE_DEFAULT)
  if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > STOPPED_PAGE_MAX) {
    return { ok: false, error: `--limit must be a whole number from 1 to ${STOPPED_PAGE_MAX}` }
  }
  const [groups, groupId] = await Promise.all([
    listWorkspaceGroups(caller.projectId),
    group === undefined ? undefined : resolveGroup(caller.projectId, group).then((g) => g.groupId),
  ])
  const page = await listStoppedWorkspaces({
    project: caller.projectId,
    ...(search !== undefined ? { q: search } : {}),
    ...(groupId !== undefined ? { group: groupId } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    exclude: inFlightWorkspaceIds(Date.now()),
    limit: Number(limit),
  })
  const matching = search !== undefined ? ` matching "${flatten(search, 40)}"` : ''
  if (page.entries.length === 0) {
    return {
      ok: true,
      output: cursor !== undefined ? `No more stopped workspaces${matching}.` : `No stopped workspaces in this project${matching}.`,
    }
  }
  const lines = [
    `Stopped workspaces in this project${matching} (${page.entries.length} of ${page.total}, newest stop first):`,
    '',
    ...renderStopped(page.entries, new Map(groups.map((g) => [g.groupId, g.name]))),
    '',
  ]
  if (page.nextCursor !== undefined) {
    const kept = (['search', 'group', 'limit'] as const).flatMap((a) =>
      request.args[a] === undefined ? [] : [`--${a} ${shellQuote(request.args[a])}`])
    lines.push(`More: yaac-mama list --stopped ${[...kept, `--cursor ${page.nextCursor}`].join(' ')}`)
  }
  lines.push(
    'Show one with its full prompt: yaac-mama list <workspace>',
    'Restart one:                   yaac-mama restart <workspace>',
  )
  return { ok: true, output: lines.join('\n') }
}

/** A value as one single-quoted shell word, for a command line to copy. */
function shellQuote(value: string): string {
  return /^[\w./:@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/** The zone times are shown in: the project owner's, else UTC
 *  (docs/routines.md "Times and zones"). */
async function ownerTimeZone(projectId: string): Promise<string> {
  const owner = (await getProjectRow(projectId))?.owner
  return (owner !== undefined ? (await getTimeZone(owner)).timeZone : null) ?? 'UTC'
}

/** The zone and instant a listing renders times against. */
interface ListClock { zone: string; now: Date }

/** `Fri Oct 24 14:30 (in 38m)`, in the listing's zone. */
function when(iso: string | Date, { zone, now }: ListClock): string {
  const at = new Date(iso)
  return `${formatInZone(at, zone)} (in ${formatDuration(minutesUntil(at, now))})`
}

function renderWorkspaces(
  workspaces: WorkspaceListEntry[],
  groupNames: Map<string, string>,
  callerId: string,
  clock: ListClock,
): string[] {
  const rows = [...workspaces]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((w) => ({
      id: `${w.workspaceId.slice(0, 8)}${w.workspaceId === callerId ? ' (you)' : ''}`,
      tool: [...new Set(w.sessions.map((s) => s.tool))].join(',') || '-',
      status: w.status,
      group: w.groupId !== undefined ? groupNames.get(w.groupId) ?? '' : '',
      stops: w.deadline !== undefined ? when(w.deadline, clock) : '',
      title: flatten(w.title ?? '', 40),
      prompt: flatten(w.prompt ?? '', 60),
    }))
  // Titles let an agent see its `rename` results, and STOPS its deadline;
  // each column is shown only when some workspace has a value.
  const hasTitles = rows.some((r) => r.title !== '')
  const hasStops = rows.some((r) => r.stops !== '')
  return table(
    ['WORKSPACE', 'TOOL', 'STATUS', 'GROUP', ...(hasStops ? [`STOPS (${clock.zone})`] : []), ...(hasTitles ? ['TITLE'] : []), 'PROMPT'],
    rows.map((r) => [r.id, r.tool, r.status, r.group, ...(hasStops ? [r.stops] : []), ...(hasTitles ? [r.title] : []), r.prompt]),
  )
}

/**
 * Each running workspace's open sessions, for `send --session` and
 * `stop --session` to name.
 */
function renderSessions(workspaces: WorkspaceListEntry[], callerSessionId: string | undefined): string[] {
  const rows = [...workspaces]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .flatMap((w) => w.sessions.map((s) => [
      w.workspaceId.slice(0, 8),
      `${s.sessionId.slice(0, 8)}${s.sessionId === callerSessionId ? ' (you)' : ''}`,
      s.modelName !== undefined ? `${s.tool} · ${s.modelName}` : s.tool,
      s.exited === true ? 'exited' : s.status ?? 'starting',
      flatten(s.title ?? s.prompt ?? '', 60),
    ]))
  return table(['WORKSPACE', 'SESSION', 'AGENT', 'STATUS', 'TITLE'], rows)
}

/**
 * Stopped workspaces as listed: HOW is `stopped` for a stop, or the cause
 * the reaper recorded for a death (`oom`, `crashed`, …), which tells a
 * restart that resumes from one that recovers.
 */
function renderStopped(entries: StoppedWorkspaceEntry[], groupNames: Map<string, string>): string[] {
  const rows = entries.map((e) => ({
    id: e.workspaceId.slice(0, 8),
    tool: [...new Set(e.sessions.map((s) => s.tool))].join(',') || '-',
    stopped: e.stoppedAt.slice(0, 16),
    how: e.endedAtNextRun === true ? 'ended at next run'
      : e.timedOut === true ? 'timed out'
      : e.deathReason === undefined ? 'stopped'
      : e.deathDetail !== undefined ? `${e.deathReason}: ${flatten(e.deathDetail, 40)}`
      : e.deathReason,
    group: e.groupId !== undefined ? groupNames.get(e.groupId) ?? '' : '',
    title: flatten(e.title ?? '', 40),
    prompt: flatten(e.prompt ?? '', 60),
  }))
  const hasTitles = rows.some((r) => r.title !== '')
  return table(
    ['WORKSPACE', 'TOOL', 'STOPPED (UTC)', 'HOW', 'GROUP', ...(hasTitles ? ['TITLE'] : []), 'PROMPT'],
    rows.map((r) => [r.id, r.tool, r.stopped, r.how, r.group, ...(hasTitles ? [r.title] : []), r.prompt]),
  )
}

/** Rows under a header, every column but the last padded to its widest
 *  cell. */
function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const line = (cells: string[]): string =>
    cells.map((c, i) => i === cells.length - 1 ? c : c.padEnd(widths[i])).join('  ').trimEnd()
  return [line(header), ...rows.map(line)]
}

/** Routines as listed: STOPS is when each run stops, ERROR why the newest
 *  run failed to start, shown only when one did. */
function renderRoutines(routines: RoutineEntry[], clock: ListClock): string[] {
  const hasErrors = routines.some((r) => r.lastError !== undefined)
  return table(
    ['ROUTINE', 'TOOL', 'NAME', 'CRON', `NEXT RUN (${clock.zone})`, 'STOPS', ...(hasErrors ? ['ERROR'] : []), 'PROMPT'],
    routines.map((r) => [
      r.id.slice(0, 8),
      r.tool,
      flatten(r.name, 30),
      `${r.cron} (${r.timeZone})`,
      r.paused ? 'paused' : r.nextRuns[0] !== undefined ? when(r.nextRuns[0], clock) : 'never',
      r.timeoutMinutes !== undefined ? `after ${formatDuration(r.timeoutMinutes)}` : 'at next run',
      ...(hasErrors ? [flatten(r.lastError ?? '', 40)] : []),
      flatten(r.prompt, 60),
    ]),
  )
}

/** Queued entries as a tree under the workspace each waits on, or under
 *  the group one with no parent waits for room in, with a scheduled entry
 *  heading its own tree. */
function renderQueued(
  rows: QueuedWorkspaceRow[],
  groupNames: Map<string, string>,
  callerId: string,
  clock: ListClock,
): string[] {
  const children = new Map<string, QueuedWorkspaceRow[]>()
  const rooms = new Map<string, string>()
  for (const r of rows) {
    if (r.startAt !== undefined) continue
    let parent = r.parentQueuedId ?? r.parentWorkspaceId
    if (parent === undefined) {
      parent = `room:${r.groupId ?? ''}`
      rooms.set(parent, `waiting for room in "${groupNames.get(r.groupId ?? '') ?? 'no group'}":`)
    }
    children.set(parent, [...(children.get(parent) ?? []), r])
  }
  const ids = new Set(rows.map((r) => r.id))
  const lines: string[] = []
  const line = (r: QueuedWorkspaceRow): string => {
    const status = r.launchWorkspaceId !== undefined ? `launching as ${r.launchWorkspaceId.slice(0, 8)}`
      : r.launchError !== undefined ? `failed: ${flatten(r.launchError, 60)}`
      : r.releasedAt !== undefined || (r.parentWorkspaceId ?? r.parentQueuedId ?? r.startAt) === undefined
        ? 'waiting for room'
        : 'queued'
    const stops = r.timeoutMinutes !== undefined ? `  stops after ${formatDuration(r.timeoutMinutes)}` : ''
    return `${r.id.slice(0, 8)}  ${r.tool}  ${status}${stops}  ${flatten(r.prompt, 60)}`
  }
  const walk = (parent: string, depth: number): void => {
    for (const r of children.get(parent) ?? []) {
      lines.push(`${'  '.repeat(depth + 1)}${line(r)}`)
      walk(r.id, depth + 1)
    }
  }
  for (const r of rows.filter((e) => e.startAt !== undefined)
    .sort((a, b) => (a.startAt?.getTime() ?? 0) - (b.startAt?.getTime() ?? 0))) {
    lines.push(`at ${when(r.startAt ?? clock.now, clock)}:`, `  ${line(r)}`)
    walk(r.id, 1)
  }
  for (const parent of children.keys()) {
    if (ids.has(parent)) continue
    lines.push(rooms.get(parent) ?? `after ${parent.slice(0, 8)}${parent === callerId ? ' (you)' : ''}:`)
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
 * Start an agent (`decideSpawn`): a session in a new workspace of the
 * caller's project, or with `--workspace` in that running one (the caller's
 * own included). `--no-session` starts a workspace with no agent.
 */
async function runCreate(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const settings = createSettings(request.args)
  if (!settings.ok) return settings
  const { workspace, resume } = request.args
  const noSession = request.args['no-session'] !== undefined
  const sessionArgs = ['tool', 'model', 'effort', 'permission-mode', 'ui-mode', 'resume']
  if (noSession) {
    const stray = [...sessionArgs, 'workspace'].find((a) => request.args[a] !== undefined)
    if (stray !== undefined) return { ok: false, error: `--no-session does not take --${stray}` }
    if (request.body.trim() !== '') return { ok: false, error: '--no-session takes no prompt: a workspace with no session runs no agent' }
  }
  if (workspace !== undefined) {
    const stray = ['branch', 'group', 'timeout'].find((a) => request.args[a] !== undefined)
    if (stray !== undefined) {
      return { ok: false, error: `--${stray} is a workspace's setting, which --workspace (a session in a running one) does not take` }
    }
  }

  const decision = await decideSpawn({
    principal: caller.principal,
    callerWorkspaceId: caller.workspaceId,
    callerProjectId: caller.projectId,
    ...(caller.tool !== undefined ? { callerTool: caller.tool } : {}),
    callerPermissionMode: caller.permissionMode,
    callerMode: caller.mode,
    prompt: request.body,
    ...(workspace !== undefined ? { workspace } : {}),
    ...(resume !== undefined ? { resume } : {}),
    ...(noSession ? { noSession: true } : {}),
    ...settings.settings,
  })
  return decision.ok
    // The id alone, so `id=$(yaac-mama create "…")` works: the session's for
    // one opened in a running workspace, else the new workspace's.
    ? { ok: true, output: decision.sessionId ?? decision.workspaceId }
    : { ok: false, error: decision.error }
}

/**
 * Queue a workspace to start when its parent (a workspace in this project,
 * often the caller itself, or another queued entry) stops, or with no
 * parent when `--group` names a group with a workspace limit, to start once
 * that group has room (docs/workspace-groups.md). Settings default from the
 * parent, or with none as `create`'s do; the permission mode is capped at
 * the caller's own.
 */
async function runQueue(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const parent = request.args['parent-workspace']?.trim() ?? ''
  const start = startArgs(request.args)
  if (!start.ok) return start
  if (parent !== '' && start.start !== undefined) {
    return { ok: false, error: 'queue takes one of --parent-workspace, --start-at and --start-in' }
  }
  const settings = createSettings(request.args)
  if (!settings.ok) return settings
  const entry = await queueWorkspace(caller.principal, caller.projectId, {
    ...(start.start !== undefined ? { start: start.start } : {}),
    prompt: request.body,
    ...(parent !== ''
      ? { parent }
      : { ...(caller.tool !== undefined ? { tool: caller.tool } : {}), mode: caller.mode }),
    ...queueFields(settings.settings),
  }, { ceiling: caller.permissionMode })
  if (entry.startAt !== undefined) {
    const zone = await ownerTimeZone(caller.projectId)
    return { ok: true, output: `${entry.id}\nnote: starts at about ${when(entry.startAt, { zone, now: new Date() })} ${zone}` }
  }
  // The id alone on the first line, so `a=$(yaac-mama queue …)` can chain
  // the next one after it; the script prints any note after it to stderr.
  const parentId = entry.parentWorkspaceId
  const stopped = parentId !== undefined
    && (await getWorkspaceRow(caller.projectId, parentId))?.stoppedAt !== undefined
  return {
    ok: true,
    output: stopped
      ? `${entry.id}\nnote: ${parentId.slice(0, 8)} is stopped, so this starts only after it is restarted and stopped again`
      : entry.id,
  }
}

/**
 * Edit a queued workspace in the caller's project: prompt (an empty body
 * keeps it), settings or parent, or `--no-parent` to have it wait for room
 * in a group with a workspace limit instead; `--timeout none` clears its
 * timeout. The permission mode is capped at the caller's own, as in
 * `queue`, so an agent cannot reuse a higher grant the user gave an entry.
 */
async function runEditQueued(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const target = request.args.queued?.trim() ?? ''
  if (target === '') return { ok: false, error: 'edit-queued needs a queued workspace id' }
  const picked = pickOne(await listQueuedWorkspaceRows(caller.projectId), target, 'queued workspace')
  if (!picked.ok) return picked
  const { args, cleared } = takeCleared(request.args, 'none')
  const settings = createSettings(args, 'none')
  if (!settings.ok) return settings
  const parent = request.args['parent-workspace']?.trim()
  const noParent = request.args['no-parent'] !== undefined
  const start = startArgs(request.args)
  if (!start.ok) return start
  if ([noParent, parent !== undefined && parent !== '', start.start !== undefined].filter(Boolean).length > 1) {
    return { ok: false, error: 'edit-queued takes one of --parent-workspace, --no-parent, --start-at and --start-in' }
  }
  const patch: Partial<QueueRequest> = {
    ...(request.body !== '' ? { prompt: request.body } : {}),
    ...(parent !== undefined && parent !== '' ? { parent } : {}),
    ...(noParent ? { parent: null } : {}),
    ...(start.start !== undefined ? { start: start.start } : {}),
    ...queueFields(settings.settings),
    ...(cleared ? { timeout: null } : {}),
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: 'edit-queued needs a new prompt or an option to change' }
  }
  const entry = await updateQueuedWorkspace(caller.principal, picked.entry.id, patch, { ceiling: caller.permissionMode })
  return {
    ok: true,
    output: `Updated queued workspace ${entry.id.slice(0, 8)}: ${entry.tool} ${entry.model}, `
      + `${entry.permissionMode} — ${flatten(entry.prompt, 60)}`,
  }
}

/**
 * Start a queued workspace in the caller's project now, as the webapp's Run
 * now does: refused while its group is at its workspace limit, and for one
 * whose permission mode is above the caller's own, as `restart` is.
 */
async function runRunQueued(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const target = request.args.queued?.trim() ?? ''
  if (target === '') return { ok: false, error: 'run-queued needs a queued workspace id' }
  const picked = pickOne(await listQueuedWorkspaceRows(caller.projectId), target, 'queued workspace')
  if (!picked.ok) return picked
  const { id, permissionMode } = picked.entry
  const short = id.slice(0, 8)
  const above = aboveCaller(caller, short, permissionMode, 'edit-queued')
  if (above !== undefined) return above
  const { workspaceId } = await runQueuedWorkspace(caller.principal, id)
  return { ok: true, output: `Started queued workspace ${short} as ${workspaceId.slice(0, 8)}.` }
}

/**
 * Discard a queued workspace in the caller's project, as the webapp's
 * Discard does: its children move up to its own parent. No permission
 * ceiling applies. The children of a live entry move onto what it waited
 * on, which an agent could already set off by stopping a workspace or
 * raising a group's limit, and those of a failed one keep waiting for the
 * user (`deleteQueuedWorkspace`).
 */
async function runDeleteQueued(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const target = request.args.queued?.trim() ?? ''
  if (target === '') return { ok: false, error: 'delete-queued needs a queued workspace id' }
  const picked = pickOne(await listQueuedWorkspaceRows(caller.projectId), target, 'queued workspace')
  if (!picked.ok) return picked
  await discardQueuedWorkspace(caller.principal, picked.entry.id)
  return { ok: true, output: `Discarded queued workspace ${picked.entry.id.slice(0, 8)}.` }
}

/**
 * A refusal for starting `short`, which runs in `permissionMode`, if that is
 * more than the caller's own; `edit` names the command that lowers it.
 */
function aboveCaller(
  caller: MamaCaller,
  short: string,
  permissionMode: PermissionMode,
  edit: string,
): { ok: false; error: string } | undefined {
  if (isRankedPermissionMode(permissionMode) && isRankedPermissionMode(caller.permissionMode)
    && !morePermissive(permissionMode, caller.permissionMode)) return undefined
  return {
    ok: false,
    error: `${short} runs in permission mode '${permissionMode}', more than the caller's ceiling `
      + `('${caller.permissionMode}'); lower it with ${edit} --permission-mode first`,
  }
}

/** The caller's project's routines. */
async function projectRoutines(projectId: string): Promise<RoutineEntry[]> {
  return (await listRoutines()).filter((r) => r.projectId === projectId)
}

/** The routine `--routine` names in the caller's project. */
async function pickRoutine(
  caller: MamaCaller,
  request: MamaRequestInput,
): Promise<{ ok: true; entry: RoutineEntry } | { ok: false; error: string }> {
  const target = request.args.routine?.trim() ?? ''
  if (target === '') return { ok: false, error: `${request.command} needs a routine id` }
  return pickOne(await projectRoutines(caller.projectId), target, 'routine')
}

/**
 * The routine fields a request gives: create's options (but the title), its
 * name, cron and zone, and its body as the prompt. `--timeout next` clears
 * the timeout, so each run stops at the next tick. Bounded as the routine
 * routes bound them.
 */
function routineFields(
  request: MamaRequestInput,
): { ok: true; fields: Partial<RoutineSettings> } | { ok: false; error: string } {
  const { name, cron, tz } = request.args
  const { args, cleared } = takeCleared(request.args, 'next')
  const settings = createSettings(args, 'next')
  if (!settings.ok) return settings
  const parsed = routineSettingsSchema.partial().safeParse({
    ...queueFields(settings.settings),
    ...(cleared ? { timeout: null } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(cron !== undefined ? { cron } : {}),
    ...(tz !== undefined ? { timeZone: tz } : {}),
    ...(request.body !== '' ? { prompt: request.body } : {}),
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, error: `invalid ${String(issue.path[0] ?? 'routine')}: ${issue.message}` }
  }
  return { ok: true, fields: parsed.data }
}

/** When a routine runs next, in its own zone. */
function nextRuns(routine: RoutineEntry): string {
  if (routine.paused) return 'paused'
  const runs = routine.nextRuns.map((r) => formatInZone(new Date(r), routine.timeZone))
  return runs.length > 0 ? `next runs at about ${runs.join(', ')} (${routine.timeZone})` : 'its cron never fires again'
}

/**
 * Make a routine in the caller's project (docs/routines.md). Settings it
 * omits default as `queue --start-at`'s do, and what it launches is held
 * to the caller's permission mode. Prints the id, then a note.
 */
async function runRoutineCreate(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const parsed = routineFields(request)
  if (!parsed.ok) return parsed
  const { name, cron, prompt } = parsed.fields
  if (name === undefined || cron === undefined || prompt === undefined) {
    return { ok: false, error: 'routine-create needs --name, --cron and a prompt' }
  }
  const routine = await createRoutine(caller.principal, caller.projectId, {
    ...(caller.tool !== undefined ? { tool: caller.tool } : {}),
    mode: caller.mode,
    ...parsed.fields,
    name,
    cron,
    prompt,
  }, { ceiling: caller.permissionMode })
  return { ok: true, output: `${routine.id}
note: ${nextRuns(routine)}` }
}

/**
 * Edit a routine in the caller's project. As in `edit-queued`, its stored
 * permission mode counts as requested, so one above the caller's is refused
 * until the edit lowers it.
 */
async function runRoutineEdit(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const picked = await pickRoutine(caller, request)
  if (!picked.ok) return picked
  const parsed = routineFields(request)
  if (!parsed.ok) return parsed
  if (Object.keys(parsed.fields).length === 0) {
    return { ok: false, error: 'routine-edit needs a new prompt or an option to change' }
  }
  const r = await updateRoutine(caller.principal, picked.entry.id, parsed.fields, { ceiling: caller.permissionMode })
  return {
    ok: true,
    output: `Updated routine ${r.id.slice(0, 8)} ("${r.name}"): ${r.cron}, ${r.tool} ${r.model}, `
      + `${r.permissionMode}; ${nextRuns(r)}`,
  }
}

/** Pause a routine, or resume one no more permissive than the caller. */
async function runRoutinePause(
  caller: MamaCaller,
  request: MamaRequestInput,
  paused: boolean,
): Promise<MamaOutcome> {
  const picked = await pickRoutine(caller, request)
  if (!picked.ok) return picked
  const short = picked.entry.id.slice(0, 8)
  if (!paused) {
    const above = aboveCaller(caller, short, picked.entry.permissionMode, 'routine edit')
    if (above !== undefined) return above
  }
  const r = await setRoutinePaused(caller.principal, picked.entry.id, paused)
  return { ok: true, output: `${paused ? 'Paused' : 'Resumed'} routine ${short} ("${r.name}")${paused ? '' : `; ${nextRuns(r)}`}.` }
}

/** Start a run of a routine now, as the webapp's Run now does, refused
 *  above the caller's permission mode as `run-queued` is. */
async function runRoutineRun(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const picked = await pickRoutine(caller, request)
  if (!picked.ok) return picked
  const short = picked.entry.id.slice(0, 8)
  const above = aboveCaller(caller, short, picked.entry.permissionMode, 'routine edit')
  if (above !== undefined) return above
  const { workspaceId } = await runRoutineNow(caller.principal, picked.entry.id)
  return { ok: true, output: `Started routine ${short} ("${picked.entry.name}") as ${workspaceId.slice(0, 8)}.` }
}

/** Delete a routine and its runs that never started. */
async function runRoutineDelete(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const picked = await pickRoutine(caller, request)
  if (!picked.ok) return picked
  await deleteRoutine(caller.principal, picked.entry.id)
  return {
    ok: true,
    output: `Deleted routine ${picked.entry.id.slice(0, 8)} ("${picked.entry.name}"). `
      + 'Runs already started keep going until they stop.',
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
  const workspaceId = await resolveProjectWorkspace(workspace, caller.projectId)
  const short = workspaceId.slice(0, 8)

  const ceiling = caller.permissionMode
  if (!isRankedPermissionMode(ceiling)) {
    return { ok: false, error: `this caller's permission mode '${ceiling}' is not one this server knows` }
  }
  const targetRow = await getWorkspaceRow(caller.projectId, workspaceId)

  const running = await resolveWorkspaceContainer(workspaceId, { requireRunning: true, exact: true })
    .catch((err: unknown) => {
      if (err instanceof ServerError && (err.code === 'NOT_FOUND' || err.code === 'CONFLICT')) return undefined
      throw err
    })
  if (!running) {
    return {
      ok: false,
      error: targetRow?.stoppedAt !== undefined
        ? `workspace ${short} is stopped; restart it with yaac-mama restart ${short}, then send once it is running`
        : `workspace ${short} is not running`,
    }
  }

  // The caller's own session is never a target: the paste would land in its
  // own running turn.
  const sessions = (await listWorkspaceSessions(workspaceId)).filter((s) => s.id !== caller.sessionId)
  const bySession = request.args.session?.trim() ?? ''
  const byConversation = request.args.conversation?.trim() ?? ''
  const pick = (wanted: string, key: (s: SessionRow) => string | undefined): SessionRow[] => {
    const exact = sessions.find((s) => key(s) === wanted)
    return exact !== undefined ? [exact] : sessions.filter((s) => key(s)?.startsWith(wanted) === true)
  }
  const matches = bySession !== '' ? pick(bySession, (s) => s.id)
    : byConversation !== '' ? pick(byConversation, (s) => s.conversationId)
    : sessions.slice(0, 1)
  if (matches.length !== 1) {
    const named = bySession !== '' ? `session '${bySession}'` : `conversation '${byConversation}'`
    return {
      ok: false,
      error: bySession === '' && byConversation === '' ? `${short} has no other session to send to`
        : matches.length === 0 ? `no open ${named} in ${short} (see: yaac-mama list)`
        : `${named} matches more than one session in ${short} — use a longer prefix`,
    }
  }
  const [session] = matches
  const conversationId = session.conversationId
  const label = `${short}'s ${session.tool} session ${session.id.slice(0, 8)}`
  if (conversationId === undefined) return { ok: false, error: `${label} has no conversation yet; try again once its agent is up` }

  // The row follows what the agent reports; its latest report is checked
  // too, in case it moved since the last pass recorded it.
  const reported = liveAgents(caller.projectId, workspaceId)?.find((a) => a.handle === session.window)?.reportedMode
  const postures = [
    session.permissionMode,
    reported === undefined
      ? session.permissionMode
      : resolveAgentPermissionMode(session.mode, session.tool, reported, session.permissionMode),
  ]
  for (const posture of postures) {
    if (posture === undefined || !isRankedPermissionMode(posture)) {
      return { ok: false, error: `cannot tell which permission mode ${label} runs in, so it cannot be sent a message` }
    }
    if (morePermissive(posture, ceiling)) {
      return {
        ok: false,
        error: `${label} runs in permission mode '${posture}', more than the caller's own `
          + `('${ceiling}'); only one at or below it can be sent a message`,
      }
    }
  }

  const from = `from:${caller.sessionId ?? caller.workspaceId}`
  const to = `to:${session.id}`
  if (sending.has(from)) return { ok: false, error: 'your previous send is still being delivered; send again once it returns' }
  if (sending.has(to)) return { ok: false, error: `another message to ${label} is still being delivered; try again shortly` }
  sending.add(from).add(to)
  try {
    await agentDriver(session.mode).deliverPrompt(
      { projectId: caller.projectId, workspaceId, jobName: running.jobName },
      session.window,
      `Sent from ${caller.workspaceId} via yaac-mama:\n\n${body}`,
      { running: { tool: session.tool, conversationId } },
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
  'tool' | 'model' | 'permissionMode' | 'effort' | 'uiMode' | 'branch' | 'group' | 'title' | 'timeout'
>

/**
 * Validate the shared create options. The group stays a name, resolved
 * (and created) only after the command's own checks pass, so a refused
 * request creates no group.
 */
function createSettings(
  args: Record<string, string>,
  clear?: ClearWord,
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
  const timeout = parseTimeout(args.timeout)
  if (timeout === null) return timeoutRefusal(args.timeout, clear)
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
      ...(timeout !== undefined ? { timeout } : {}),
    },
  }
}

/** `--start-at` (read by the queue in the owner's zone) or `--start-in`;
 *  at most one. */
function startArgs(args: Record<string, string>): { ok: true; start?: QueueStart } | { ok: false; error: string } {
  const at = args['start-at']?.trim()
  const inText = args['start-in']
  if (at !== undefined && inText !== undefined) return { ok: false, error: 'give --start-at or --start-in, not both' }
  if (at !== undefined) return at === '' ? { ok: false, error: '--start-at must not be empty' } : { ok: true, start: { at } }
  if (inText === undefined) return { ok: true }
  const minutes = parseTimeout(inText)
  return minutes == null
    ? { ok: false, error: `invalid --start-in '${inText}' (${DURATION_HINT})` }
    : { ok: true, start: { inMinutes: minutes } }
}

/** How a duration is written, for refusals. */
const DURATION_HINT = 'whole minutes or more, like 45m, 2h or 1h30m'

/** The `--timeout` words that clear a timeout, by what each clears it to. */
const CLEAR_WORDS = {
  none: 'none for no timeout',
  next: 'next to stop each run at the next tick',
} as const
type ClearWord = keyof typeof CLEAR_WORDS

/** A refusal of a `--timeout`, naming the word that clears one where the
 *  command takes one, since it differs between commands. */
function timeoutRefusal(text: string | undefined, clear?: ClearWord): { ok: false; error: string } {
  const hint = clear !== undefined ? `, or ${CLEAR_WORDS[clear]}` : ''
  return { ok: false, error: `invalid timeout '${text}' (${DURATION_HINT}${hint})` }
}

/** A `--timeout` in minutes: undefined when absent, null when invalid. */
function parseTimeout(text: string | undefined): number | undefined | null {
  if (text === undefined) return undefined
  const minutes = parseDuration(text)
  return minutes !== undefined && timeoutMinutesSchema.safeParse(minutes).success ? minutes : null
}

/**
 * `args` without a `--timeout` of `word` (`none`, or a routine's `next`),
 * which clears a timeout rather than giving one, and whether it had one.
 */
function takeCleared(
  args: Record<string, string>,
  word: ClearWord,
): { args: Record<string, string>; cleared: boolean } {
  const { timeout, ...rest } = args
  return timeout?.trim().toLowerCase() === word ? { args: rest, cleared: true } : { args, cleared: false }
}

/** The same settings in the shape a queue write takes. */
function queueFields({ uiMode, ...rest }: CreateSettings): Partial<QueueRequest> {
  return { ...rest, ...(uiMode !== undefined ? { mode: uiMode } : {}) }
}

/** Retitle a workspace, by default the caller itself. */
async function runRename(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const workspaceId = await resolveTargetWorkspace(caller, request.args.workspace)

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
): Promise<string> {
  const target = workspace === undefined || workspace.trim() === '' ? caller.workspaceId : workspace
  return await resolveProjectWorkspace(target, caller.projectId, opts)
}

/**
 * Stop a workspace, by default the caller (an agent winding itself down
 * after its work). The checkout is kept for restart. A self-stop's reply is
 * best-effort, since the teardown removes the transport it travels on.
 *
 * With `--session` only that session closes, by default the caller's own,
 * and its workspace keeps running.
 */
async function runStop(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  if (request.args.session !== undefined) return await closeOneSession(caller, request.args.session.trim())
  // A sibling still being created may have no row yet.
  const workspaceId = await resolveTargetWorkspace(caller, request.args.workspace, { provisioning: true })

  let stopped: { provisioning?: true }
  try {
    stopped = await stopWorkspace(caller.principal, workspaceId)
  } catch (err) {
    // The id resolved against rows, so NOT_FOUND here means not running.
    if (err instanceof ServerError && err.code === 'NOT_FOUND') {
      const already = (await getWorkspaceRow(caller.projectId, workspaceId))?.stoppedAt !== undefined
      return { ok: false, error: `workspace ${workspaceId.slice(0, 8)} is ${already ? 'already stopped' : 'not running'}` }
    }
    throw err
  }
  const short = workspaceId.slice(0, 8)
  return {
    ok: true,
    output: stopped.provisioning === true
      ? `Stopped ${short} while it was starting.`
      : `Stopped ${short}. Its checkout is kept, with its conversations, so it can be `
        + `restarted: yaac-mama restart ${short}. Files its .gitignore matches are deleted, `
        + 'except the project\'s kept paths.',
  }
}

/** `stop --session`: close one session of the caller's project. */
async function closeOneSession(caller: MamaCaller, wanted: string): Promise<MamaOutcome> {
  if (wanted === '' && caller.sessionId === undefined) {
    return { ok: false, error: 'stop --session needs a session id when not run by a session\'s agent (see: yaac-mama list)' }
  }
  const target = wanted === '' ? caller.sessionId! : wanted
  const open = (await listActiveWorkspaces(caller.projectId)).workspaces.flatMap((w) => w.sessions)
  const exact = open.find((s) => s.sessionId === target)
  const matches = exact !== undefined ? [exact] : open.filter((s) => s.sessionId.startsWith(target))
  if (matches.length !== 1) {
    return {
      ok: false,
      error: matches.length === 0 ? `no open session '${target}' in this project (see: yaac-mama list)`
        : `'${target}' matches more than one session — use a longer prefix`,
    }
  }
  const closed = await closeSession(caller.principal, matches[0].sessionId)
  const rest = (await listWorkspaceSessions(closed.workspaceId)).length
  const short = closed.workspaceId.slice(0, 8)
  return {
    ok: true,
    output: `Closed session ${closed.id.slice(0, 8)}; its conversations stay in ${short}'s history. `
      + (rest === 0
        ? `${short} keeps running with no agent; stop it with yaac-mama stop ${short}.`
        : `${short} keeps running.`),
  }
}

/**
 * Restart a stopped sibling, resuming the conversations it had, as the
 * webapp's Restart does (`decideRestart`). It runs detached, so the reply
 * comes before the workspace is up.
 */
async function runRestart(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const workspace = request.args.workspace?.trim() ?? ''
  if (workspace === '') return { ok: false, error: 'restart needs a workspace id' }
  const { cleared } = takeCleared(request.args, 'none')
  const timeout = cleared ? null : parseTimeout(request.args.timeout)
  if (timeout === null && !cleared) return timeoutRefusal(request.args.timeout, 'none')
  const workspaceId = await resolveProjectWorkspace(workspace, caller.projectId)
  const decision = await decideRestart({
    principal: caller.principal,
    callerWorkspaceId: caller.workspaceId,
    callerProjectId: caller.projectId,
    callerPermissionMode: caller.permissionMode,
    workspaceId,
    ...(timeout !== undefined ? { timeout } : {}),
  })
  if (!decision.ok) return decision
  const short = workspaceId.slice(0, 8)
  const n = decision.sessions
  return {
    ok: true,
    output: `Restarting ${short}, resuming ${n === 0 ? 'with no session' : n === 1 ? 'its session' : `its ${n} sessions`}. `
      + 'It shows as running in yaac-mama list once it is up; if the launch fails after this, '
      + 'the user sees why in the yaac webapp.',
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
  const workspaceId = await resolveProjectWorkspace(workspace, caller.projectId)

  const target = request.body.trim()
  // No group (or `--`) means ungrouped.
  const resolved = target === '--' || target === ''
    ? null
    : await resolveGroup(caller.projectId, target, { create: true })
  await moveWorkspaceToGroup(caller.projectId, workspaceId, resolved?.groupId ?? null)
  return {
    ok: true,
    output: resolved === null
      ? `Moved ${workspaceId.slice(0, 8)} out of its group.`
      : `Moved ${workspaceId.slice(0, 8)} into "${resolved.name}".`,
  }
}

/** Set or clear (`none`) how many of a group's workspaces may run at once.
 *  The group must exist; this creates none. */
async function runGroupSetLimit(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const name = request.body.trim()
  const limit = request.args.limit?.trim() ?? ''
  if (name === '') return { ok: false, error: 'group set-limit needs a group' }
  if (limit !== 'none' && !/^[1-9]\d{0,5}$/.test(limit)) {
    return { ok: false, error: 'the limit must be a whole number of workspaces from 1, or none' }
  }
  const group = await resolveGroup(caller.projectId, name)
  await setGroupWorkspaceLimit(caller.projectId, group.groupId, limit === 'none' ? null : Number(limit))
  return {
    ok: true,
    output: limit === 'none'
      ? `Group "${group.name}" has no workspace limit now.`
      : `Group "${group.name}" now runs at most ${limit} ${limit === '1' ? 'workspace' : 'workspaces'} at once.`,
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
  const workspaceId = await resolveProjectWorkspace(workspace, caller.projectId)
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
  const workspaceId = await resolveProjectWorkspace(workspace, caller.projectId)
  // Pick the conversation before gathering files, which reads every one's.
  let rows = await listWorkspaceConversations(caller.projectId, workspaceId)

  const wanted = request.args.conversation?.trim() ?? ''
  if (wanted !== '') {
    const exact = rows.find((r) => r.conversationId === wanted)
    const matches = exact !== undefined ? [exact] : rows.filter((r) => r.conversationId.startsWith(wanted))
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
        ? `# skipped ${c.row.conversationId}/${f.name}: ${formatSize(f.size)}, past the `
          + `${formatSize(MAX_HISTORY_FILE_BYTES)} a file is handed out at`
        : `${c.row.conversationId}/${f.name}`)).join('\n'),
    }
  }
  if (wanted === '') return { ok: true, output: renderHistory(workspaceId, conversations) }
  const [{ row, files }] = conversations
  const name = request.args.file
  if (name !== undefined) {
    const file = files.find((f) => f.name === name)
    return file === undefined
      ? { ok: false, error: `${row.conversationId} has no file '${name}'` }
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
      conversationId: row.conversationId,
    }
  }
  if (!files.some((f) => f.name.endsWith('.jsonl'))) {
    return { ok: false, error: `${row.conversationId} has no transcript on the host yet` }
  }
  return { ok: true, body: historyTranscripts(files), contentType: 'application/x-ndjson', workspaceId }
}

function renderHistory(workspaceId: string, conversations: HistoryConversation[]): string {
  const short = workspaceId.slice(0, 8)
  if (conversations.length === 0) return `${short} has no recorded conversations.`
  const rows = conversations.map(({ row, files }) => {
    const last = Math.max(0, row.lastActiveAt?.getTime() ?? 0, ...files.map((f) => f.mtimeMs))
    return [
      row.conversationId,
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
  return [
    `Conversations of ${short}, first held first:`,
    '',
    ...table(header, rows),
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
