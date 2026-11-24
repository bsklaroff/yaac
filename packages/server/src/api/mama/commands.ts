/**
 * The `yaac-mama` commands, translated onto the API's routes: each is one
 * or more requests made in the server process as the calling workspace's
 * delegate (`callingWorkspace`), through `delegateApp`, and its text is
 * rendered from their answers. A route refuses through it exactly what it
 * refuses any delegate, so this holds no limit of its own
 * (docs/multi-user.md "Authorization"). What it keeps is the command
 * allowlist, each command's options, the mapping of options onto a route's
 * input, and every line the agent reads.
 */
import crypto from 'node:crypto'
import type { createApiClient } from '@yaac/shared/api-core'
import { ServerError } from '@yaac/shared/errors'
import { stripAnsi, stripControlChars } from '@yaac/shared/ansi'
import { MAX_TITLE_LENGTH, normalizeTitle } from '@yaac/shared/titles'
import { FULL_COMMIT_PATTERN, formatCommits, stepSettled } from '@yaac/shared/steps'
import { formatDuration, formatInZone, minutesUntil, parseDuration } from '@yaac/shared/schedule'
import { formatSize } from '@yaac/shared/sizes'
import {
  AGENT_MODES,
  AGENT_TOOLS,
  MAMA_COMMANDS,
  EFFORT_RE,
  PROMPT_TOO_LONG,
  promptFits,
  MODEL_RE,
  PERMISSION_MODES,
  routineSettingsSchema,
  timeoutMinutesSchema,
  type AgentMode,
  type AgentTool,
  type Delegate,
  type PermissionMode,
  type MamaCommand,
  type QueuedWorkspaceEntry,
  type RepoStart,
  type RoutineEntry,
  type RoutineSettings,
  type SiteEntry,
  type StoppedWorkspaceEntry,
  type WorkspaceListEntry,
  type WorkspaceRepo,
} from '@yaac/shared/types'
import { runSiteCommand } from './sites'

/** The API's typed client, over `delegateApp` as the caller's delegate. */
export type MamaApi = ReturnType<typeof createApiClient>

/** Who is asking, and the API it asks through. */
export interface MamaCaller {
  /** The delegate the calling workspace acts as. */
  delegate: Delegate
  /** The calling workspace. */
  workspaceId: string
  /** The calling session, when the call came from one's agent. */
  sessionId?: string
  /** Its project, which every command is about. */
  projectId: string
  api: MamaApi
}

/** The caller of a command made as `delegate` through `api`. */
export function mamaCaller(delegate: Delegate, api: MamaApi): MamaCaller {
  return {
    delegate,
    workspaceId: delegate.via.id,
    ...(delegate.via.sessionId !== undefined ? { sessionId: delegate.via.sessionId } : {}),
    projectId: delegate.projectId ?? '',
    api,
  }
}

/** One command as received, not yet validated. */
export interface MamaRequestInput {
  command: string
  args: Record<string, string>
  body: string
}

export type MamaOutcome =
  | { ok: true; output: string }
  /** A file, about `workspaceId` (and one of its conversations) when it is
   *  `fetch`'s git bundle or `history`'s transcripts, database or one file,
   *  or the project's icon. */
  | {
    ok: true
    body: Buffer<ArrayBuffer> | ReadableStream<Uint8Array>
    contentType: string
    workspaceId?: string
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
const CREATE_ARGS = [
  'tool', 'model', 'effort', 'permission-mode', 'ui-mode', 'branch', 'commit', 'group', 'title', 'timeout',
  'steps', 'no-steps', 'workflow', 'non-interactive', 'repos', 'no-repos', 'nested', 'no-nested', 'cwd',
] as const

/** What `create --workspace` takes to add a step rather than a session. */
const STEP_ARGS = ['run', 'name', 'needs', 'service', 'ready'] as const

/** The options a workflow write takes (docs/workflows.md). */
const WORKFLOW_ARGS = ['name', 'steps', 'secrets', 'no-secrets', 'repos', 'no-repos', 'init', 'no-init']

/** The options a site write takes (docs/public-sites.md). */
const SITE_ARGS = [
  'port', 'workflow', 'repos', 'admin-port', 'no-admin-port', 'volume', 'no-volume', 'deploy-timeout', 'follow', 'no-follow',
]

/** The options a routine write takes. Its runs are titled from its name. */
const ROUTINE_ARGS = ['name', 'cron', 'tz', ...CREATE_ARGS.filter((a) => a !== 'title' && a !== 'steps' && a !== 'no-steps')]

/**
 * Options each command accepts. Others are refused rather than ignored, so a
 * request never silently does less than it said. Checked here so both
 * transports behave the same.
 */
const COMMAND_ARGS: Record<MamaCommand, readonly string[]> = {
  list: ['stopped', 'json', ...STOPPED_ARGS],
  create: [...CREATE_ARGS, ...STEP_ARGS, 'workspace', 'no-agent', 'resume', 'volume'],
  rerun: ['workspace', 'interactive'],
  status: ['workspace', 'step'],
  rename: ['workspace'],
  'set-base': ['repo'],
  'as-repo': ['repo'],
  'icon-get': [],
  'icon-set': [],
  'icon-remove': [],
  stop: ['workspace', 'agent'],
  restart: ['workspace', 'timeout', 'no-volume'],
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
  fetch: ['workspace', 'repo'],
  history: ['workspace', 'conversation', 'files', 'file'],
  send: ['workspace', 'agent', 'conversation'],
  volumes: [],
  logs: ['workspace', 'step', 'tail'],
  'workflow-list': [],
  'workflow-show': ['name'],
  'workflow-create': WORKFLOW_ARGS,
  'workflow-edit': WORKFLOW_ARGS,
  'workflow-delete': ['name'],
  'site-list': [],
  'site-show': ['name'],
  'site-create': ['name', ...SITE_ARGS],
  'site-edit': ['name', ...SITE_ARGS],
  'site-deploy': ['name', 'refs'],
  'site-start': ['name'],
  'site-stop': ['name'],
  'site-delete': ['name'],
}

/**
 * Run one `yaac-mama` command for a workspace and return the text for its
 * stdout (plain text, since the reader is an agent via a shell script).
 * A route's refusal is the command's error, in the route's words.
 * Errors are returned, never thrown, so the transport always has an answer.
 * The body is a prompt or other text, held to the prompt cap, for every
 * command but `icon-set`, whose image `setProjectIcon` bounds.
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
  if (command !== 'icon-set' && !promptFits(request.body)) return { ok: false, error: PROMPT_TOO_LONG }
  try {
    switch (command) {
      case 'list': return await runList(caller, request)
      case 'create': return await runCreate(caller, request)
      case 'rerun': return await runRerun(caller, request)
      case 'status': return await runStatus(caller, request)
      case 'rename': return await runRename(caller, request)
      case 'set-base': return await runSetBase(caller, request)
      case 'as-repo': return await runAsRepo(caller, request)
      case 'icon-get': return await runIconGet(caller)
      case 'icon-set': return await runIconSet(caller, request)
      case 'icon-remove': return await runIconRemove(caller)
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
      case 'volumes': return await runVolumes(caller)
      case 'logs': return await runLogs(caller, request)
      case 'workflow-list': return await runWorkflowList(caller)
      case 'workflow-show': return await runWorkflowShow(caller, request)
      case 'workflow-create': return await runWorkflowWrite(caller, request, 'create')
      case 'workflow-edit': return await runWorkflowWrite(caller, request, 'edit')
      case 'workflow-delete': return await runWorkflowDelete(caller, request)
      case 'site-list':
      case 'site-show':
      case 'site-create':
      case 'site-edit':
      case 'site-deploy':
      case 'site-start':
      case 'site-stop':
      case 'site-delete':
        return await runSiteCommand(caller, request)
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
  if (request.args.stopped !== undefined) {
    if (request.args.json !== undefined) return { ok: false, error: "list takes '--json' only without --stopped" }
    return await runListStopped(caller, request)
  }
  const stray = STOPPED_ARGS.find((a) => request.args[a] !== undefined)
  if (stray !== undefined) return { ok: false, error: `list takes '--${stray}' only with --stopped` }

  const { api, projectId } = caller
  const project = { query: { project: projectId } }
  // Stopped workspaces leave out one being restarted, as the webapp's
  // sidebar does.
  const [active, { groups }, allQueued, detail, allRoutines, sites, { entries: allStopped }] = await Promise.all([
    api.workspace.list.$get(project),
    api.workspace.group.list.$get(project),
    api.workspace.queue.list.$get(project),
    api.project[':projectId'].$get({ param: { projectId } }),
    api.routine.list.$get(project),
    projectSites(api, projectId),
    api.workspace['list-stopped'].$get(project),
  ])
  const placed = placements(sites)
  const clock = { zone: detail.ownerTimeZone, now: new Date() }
  let workspaces = active.workspaces
  let queued = allQueued
  let routines = allRoutines
  let stopped: StoppedWorkspaceEntry[] = []
  const names = new Map(groups.map((g) => [g.groupId, g.name]))

  const wanted = request.body.split(/\s+/).filter((t) => t !== '')
  const prompts: Array<{ id: string; prompt: string }> = []
  if (wanted.length > 0) {
    const entries: Array<{ id: string; prompt?: string }> = [
      ...workspaces.map((w) => ({ id: w.workspaceId, prompt: w.prompt ?? '' })),
      ...queued.map((r) => ({ id: r.id, prompt: r.prompt })),
      ...routines.map((r) => ({ id: r.id, prompt: r.prompt })),
      ...allStopped.map((e) => ({ id: e.workspaceId, prompt: e.prompt ?? '' })),
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
    stopped = allStopped.filter((e) => ids.has(e.workspaceId))
    for (const p of picked) prompts.push({ id: p.id, prompt: p.prompt ?? '' })
  }

  if (request.args.json !== undefined) {
    if (routines.length > 0 && wanted.length > 0) {
      return { ok: false, error: 'list --json does not list routines (give it workspace ids only)' }
    }
    const groupName = (id: string | undefined): string | null => (id !== undefined ? names.get(id) ?? null : null)
    const out = [
      ...[...workspaces].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((w) => ({
        id: w.workspaceId,
        tools: [...new Set(w.sessions.map((s) => s.tool))],
        status: 'running',
        activity: w.status,
        title: w.title ?? null,
        group: groupName(w.groupId),
        stopsAt: w.deadline !== undefined ? new Date(w.deadline).toISOString() : null,
        you: w.workspaceId === caller.workspaceId,
        sessions: w.sessions.map((s) => ({
          id: s.sessionId, tool: s.tool, model: s.modelName ?? null,
          status: s.exited === true ? 'exited' : s.status ?? 'starting',
          title: s.title ?? null, you: s.sessionId === caller.sessionId,
        })),
      })),
      ...queued.map((r) => ({
        id: r.id,
        tools: [r.tool],
        status: 'queued',
        queueState: r.awaitingApproval !== undefined ? 'awaiting-approval'
          : r.launchError !== undefined ? 'failed'
          : queuedState(r) === 'queued' ? 'queued' : 'waiting-for-room',
        launchWorkspaceId: null,
        launchError: r.launchError ?? null,
        title: r.title ?? r.generatedTitle ?? null,
        group: groupName(r.groupId),
        stopsAt: null,
        you: false,
        sessions: [],
      })),
      ...stopped.map((e) => ({
        id: e.workspaceId,
        tools: [...new Set(e.sessions.map((s) => s.tool))],
        status: 'stopped',
        title: e.title ?? null,
        group: groupName(e.groupId),
        stopsAt: null,
        you: false,
        sessions: [],
      })),
    ]
    return { ok: true, output: JSON.stringify(out) }
  }

  const lines: string[] = []
  if (workspaces.length === 0) {
    if (wanted.length === 0) lines.push('No running workspaces in this project.')
  } else {
    lines.push('Running workspaces in this project:', '')
    lines.push(...renderWorkspaces(workspaces, names, caller.workspaceId, clock, placed))
    if (workspaces.some((w) => w.sessions.length > 0)) {
      lines.push('', ...renderAgents(workspaces, caller.sessionId))
    }
  }
  if (stopped.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('Stopped workspaces:', '', ...renderStopped(stopped, names, placed))
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
  // The folders `--repo` and `--cwd` take, where there is a choice to make.
  if (detail.repos.length > 1) lines.push(`Repos: ${detail.repos.map((l) => l.dir).join(', ')}`)
  // Every prompt line is indented, so a prompt cannot fake another's header.
  for (const p of prompts) {
    const body = p.prompt === '' ? ['(none yet)'] : p.prompt.split('\n')
    lines.push('', `Prompt of ${p.id.slice(0, 8)}:`, ...body.map((l) => `  ${l}`))
  }
  return { ok: true, output: lines.join('\n') }
}

/** The project's sites; none on a server that serves no sites. */
async function projectSites(api: MamaApi, projectId: string): Promise<SiteEntry[]> {
  return await api.site.list.$get({ query: { project: projectId } }).catch((err: unknown) => {
    if (err instanceof ServerError && err.code === 'NOT_SUPPORTED') return []
    throw err
  })
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
  const { api, projectId } = caller
  const [{ groups }, page, sites] = await Promise.all([
    api.workspace.group.list.$get({ query: { project: projectId } }),
    api.workspace['list-stopped'].$get({
      query: {
        project: projectId,
        limit,
        ...(search !== undefined ? { q: search } : {}),
        ...(group !== undefined ? { group } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      },
    }),
    projectSites(api, projectId),
  ])
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
    ...renderStopped(page.entries, new Map(groups.map((g) => [g.groupId, g.name])), placements(sites)),
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
  placed: ReturnType<typeof placements>,
): string[] {
  const rows = [...workspaces]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((w) => ({
      id: `${w.workspaceId.slice(0, 8)}${w.workspaceId === callerId ? ' (you)' : ''}`,
      tool: [...new Set(w.sessions.map((s) => s.tool))].join(',') || '-',
      status: w.status,
      group: w.groupId !== undefined ? groupNames.get(w.groupId) ?? '' : '',
      stops: w.deadline !== undefined ? when(w.deadline, clock) : '',
      ...placed(w),
      title: flatten(w.title ?? '', 40),
      prompt: flatten(w.prompt ?? '', 60),
    }))
  // Titles let an agent see its `rename` results, and STOPS its deadline;
  // each column is shown only when some workspace has a value.
  const hasTitles = rows.some((r) => r.title !== '')
  const hasStops = rows.some((r) => r.stops !== '')
  const extra = placementColumns(rows)
  return table(
    ['WORKSPACE', 'TOOL', 'STATUS', 'GROUP', ...(hasStops ? [`STOPS (${clock.zone})`] : []), ...extra.header, ...(hasTitles ? ['TITLE'] : []), 'PROMPT'],
    rows.map((r) => [r.id, r.tool, r.status, r.group, ...(hasStops ? [r.stops] : []), ...extra.cells(r), ...(hasTitles ? [r.title] : []), r.prompt]),
  )
}

/**
 * What `list` shows of where a workspace stands in the code and on the
 * internet: the commit a checkout is pinned to, when it was made at one and
 * has no base branch (with its folder, where it has one), and for a public
 * site's release (docs/public-sites.md) its
 * site, whether the hostname points at it, and the site's address.
 */
interface Placement {
  commit: string
  site: string
  url: string
}

/** Where each listed workspace stands, from its own checkouts and its
 *  project's `sites`. */
function placements(sites: SiteEntry[]): (w: { workspaceId: string; repos?: WorkspaceRepo[]; site?: string }) => Placement {
  const byName = new Map(sites.map((s) => [s.name, s]))
  return ({ workspaceId, repos = [], site: siteName }) => {
    const commit = formatCommits(repos
      .flatMap((c) => (c.baseBranch === undefined && c.startCommit !== undefined ? [{ dir: c.path, commit: c.startCommit }] : [])))
    if (siteName === undefined) return { commit, site: '', url: '' }
    const site = byName.get(siteName)
    if (site === undefined) return { commit, site: '(deleted site)', url: '' }
    const role = site.live?.workspaceId === workspaceId ? 'live'
      : site.deploy?.workspaceId === workspaceId ? `deploying: ${site.deploy.phase}`
      : 'not serving'
    return { commit, site: `${site.name} (${role})`, url: site.hostname !== undefined ? `https://${site.hostname}` : '' }
  }
}

/** The placement columns some row has a value for. */
function placementColumns(rows: Placement[]): { header: string[]; cells: (p: Placement) => string[] } {
  const shown = (['commit', 'site', 'url'] as const).filter((k) => rows.some((r) => r[k] !== ''))
  return { header: shown.map((k) => k.toUpperCase()), cells: (p) => shown.map((k) => p[k]) }
}

/**
 * Each running workspace's agents (its open sessions), for `send --agent`
 * and `stop --agent` to name.
 */
function renderAgents(workspaces: WorkspaceListEntry[], callerSessionId: string | undefined): string[] {
  const rows = [...workspaces]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .flatMap((w) => w.sessions.map((s) => [
      w.workspaceId.slice(0, 8),
      `${s.sessionId.slice(0, 8)}${s.sessionId === callerSessionId ? ' (you)' : ''}`,
      s.modelName !== undefined ? `${s.tool} · ${s.modelName}` : s.tool,
      s.exited === true ? 'exited' : s.status ?? 'starting',
      flatten(s.title ?? s.prompt ?? '', 60),
    ]))
  return table(['WORKSPACE', 'AGENT', 'TOOL', 'STATUS', 'TITLE'], rows)
}

/**
 * Stopped workspaces as listed: HOW is `stopped` for a stop, or the cause
 * the reaper recorded for a death (`oom`, `crashed`, …), which tells a
 * restart that resumes from one that recovers.
 */
function renderStopped(
  entries: StoppedWorkspaceEntry[],
  groupNames: Map<string, string>,
  placed: ReturnType<typeof placements>,
): string[] {
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
    ...placed(e),
    title: flatten(e.title ?? '', 40),
    prompt: flatten(e.prompt ?? '', 60),
  }))
  const hasTitles = rows.some((r) => r.title !== '')
  const extra = placementColumns(rows)
  return table(
    ['WORKSPACE', 'TOOL', 'STOPPED (UTC)', 'HOW', 'GROUP', ...extra.header, ...(hasTitles ? ['TITLE'] : []), 'PROMPT'],
    rows.map((r) => [r.id, r.tool, r.stopped, r.how, r.group, ...extra.cells(r), ...(hasTitles ? [r.title] : []), r.prompt]),
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
      flatten(r.prompt ?? '(non-interactive)', 60),
    ]),
  )
}

/** A queued entry's state as the listing words it. */
function queuedState(r: QueuedWorkspaceEntry, errorChars = 200): string {
  return r.awaitingApproval !== undefined ? 'awaiting a person\'s approval, which their review gives'
    : r.launchError !== undefined ? `failed: ${flatten(r.launchError, errorChars)}`
    : r.waitingForRoom === true ? 'waiting for room'
    : 'queued'
}

/** Queued entries as a tree under the workspace each waits on, or under
 *  the group one with no parent waits for room in, with a scheduled entry
 *  heading its own tree. */
function renderQueued(
  rows: QueuedWorkspaceEntry[],
  groupNames: Map<string, string>,
  callerId: string,
  clock: ListClock,
): string[] {
  const children = new Map<string, QueuedWorkspaceEntry[]>()
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
  const line = (r: QueuedWorkspaceEntry): string => {
    const status = queuedState(r, 60)
    const stops = r.timeoutMinutes !== undefined ? `  stops after ${formatDuration(r.timeoutMinutes)}` : ''
    return `${r.id.slice(0, 8)}  ${r.tool}  ${status}${stops}  ${flatten(r.prompt ?? '(non-interactive)', 60)}`
  }
  const walk = (parent: string, depth: number): void => {
    for (const r of children.get(parent) ?? []) {
      lines.push(`${'  '.repeat(depth + 1)}${line(r)}`)
      walk(r.id, depth + 1)
    }
  }
  for (const r of rows.filter((e) => e.startAt !== undefined)
    .sort((a, b) => (a.startAt ?? '').localeCompare(b.startAt ?? ''))) {
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
 * Start an agent: a session in a new workspace of the
 * caller's project, or with `--workspace` in that running one (the caller's
 * own included). `--no-agent` starts a workspace with no agent.
 */
async function runCreate(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  if (request.args.run !== undefined) return await runAddStep(caller, request)
  if (request.args.workspace !== undefined && request.args.workflow !== undefined) return await runAddWorkflow(caller, request)
  const stray = STEP_ARGS.find((a) => request.args[a] !== undefined)
  if (stray !== undefined) return { ok: false, error: `--${stray} goes with --workspace and --run` }
  const settings = createSettings(request.args)
  if (!settings.ok) return settings
  const { workspace, resume } = request.args
  const noSession = request.args['no-agent'] !== undefined || settings.settings.nonInteractive === true
  const sessionArgs = ['tool', 'model', 'effort', 'permission-mode', 'ui-mode', 'resume']
  if (noSession) {
    const flag = request.args['no-agent'] !== undefined ? '--no-agent' : '--non-interactive'
    const stray = [...sessionArgs, 'workspace'].find((a) => request.args[a] !== undefined)
    if (stray !== undefined) return { ok: false, error: `${flag} does not take --${stray}` }
    if (request.body.trim() !== '') return { ok: false, error: `${flag} takes no prompt: a workspace with no agent runs none` }
  }
  if (workspace !== undefined) {
    const stray = [
      'branch', 'commit', 'group', 'timeout', 'volume', 'steps', 'no-steps', 'workflow', 'non-interactive',
      'repos', 'no-repos', 'nested', 'no-nested',
    ].find((a) => request.args[a] !== undefined)
    if (stray !== undefined) {
      return { ok: false, error: `--${stray} is a workspace's setting, which --workspace (an agent in a running one) does not take` }
    }
  }

  const { tool, model, permissionMode, effort, uiMode, cwd, title, timeout, ...start } = settings.settings
  if (!noSession && resume === undefined && request.body.trim() === '') return { ok: false, error: 'prompt must not be empty' }
  const agent = {
    ...(tool !== undefined ? { tool } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(uiMode !== undefined ? { mode: uiMode } : {}),
  }
  const { api, projectId } = caller
  if (workspace !== undefined) {
    // The id alone, so `id=$(yaac-mama create "…")` works: the agent's.
    const { sessionId } = await api.workspace[':id'].sessions.$post({
      param: { id: workspace.trim() },
      json: {
        ...agent,
        ...(request.body.trim() !== '' ? { prompt: request.body } : {}),
        ...(resume !== undefined ? { resume } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        ...(title !== undefined ? { title } : {}),
      },
    })
    return { ok: true, output: sessionId }
  }
  if (resume !== undefined) return { ok: false, error: '--resume needs --workspace: a conversation resumes in the workspace that holds it' }
  const workspaceId = crypto.randomUUID()
  // Refused before the route streams, the last point the caller can see a
  // refusal: the create itself runs on.
  drain(await api.workspace.create.$post({
    json: {
      project: projectId,
      workspaceId,
      ...(noSession ? { noSession: true } : { ...agent, prompt: request.body }),
      ...start,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
      ...(request.args.volume !== undefined ? { volume: request.args.volume } : {}),
    },
  }))
  // The id alone, so `id=$(yaac-mama create "…")` works: the new workspace's.
  return { ok: true, output: workspaceId }
}

/** Let a provisioning stream run to its end unread: the launch it reports
 *  goes on, and a failure shows on its provisioning row. */
function drain(res: Response): void {
  void res.body?.pipeTo(new WritableStream()).catch(() => undefined)
}

/**
 * Add a step to a running workspace of the project, the caller's own
 * included (docs/workspace-steps.md): `--run`, a JSON list of its commands
 * the script builds, under `--name` (else `run`), after the steps `--needs`
 * lists (each a full name, or a bare one while only one workflow has it),
 * in the checkout of the repos `--repo` names (`repos`, a JSON list of
 * folders). It is a workflow of its own, named `_added-N`. Prints the
 * step's full name.
 */
async function runAddStep(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const { args } = request
  const target = args.workspace?.trim() ?? ''
  if (target === '') return { ok: false, error: '--run needs --workspace: a step runs in a running workspace' }
  const stray = Object.keys(args).find((a) => a !== 'workspace' && a !== 'repos' && !(STEP_ARGS as readonly string[]).includes(a))
  if (stray !== undefined) return { ok: false, error: `--run does not take --${stray}` }
  if (request.body.trim() !== '') return { ok: false, error: '--run takes no prompt' }
  let run: unknown
  try {
    run = JSON.parse(args.run ?? '')
  } catch {
    return { ok: false, error: '--run is not a JSON list of commands' }
  }
  const name = args.name?.trim() || 'run'
  const needs = args.needs?.split(',').map((n) => n.trim()).filter((n) => n !== '')
  let repos: unknown
  try {
    repos = args.repos !== undefined ? JSON.parse(args.repos) : undefined
  } catch {
    return { ok: false, error: '--repo is not a JSON list of repos' }
  }
  if (repos !== undefined && !(Array.isArray(repos) && repos.every((r) => typeof r === 'string' && /^[^@]+$/.test(r)))) {
    return { ok: false, error: 'with --run, --repo takes a repo\'s folder: the checkout the step runs in' }
  }
  const [added] = await caller.api.workspace[':id'].steps.$post({
    param: { id: target },
    json: {
      steps: {
        [name]: {
          run,
          ...(needs !== undefined && needs.length > 0 ? { needs } : {}),
          ...(args.service !== undefined ? { service: true } : {}),
          ...(args.ready !== undefined ? { ready: args.ready } : {}),
        },
      },
      ...(repos !== undefined ? { repos: repos as string[] } : {}),
    },
  })
  return { ok: true, output: added.name }
}

/**
 * Add a named workflow's steps to a running workspace of the project
 * (`--workspace W --workflow X`): a person wrote them, so no ceiling
 * applies. Prints the added steps' names.
 */
async function runAddWorkflow(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const stray = Object.keys(request.args).find((a) => a !== 'workspace' && a !== 'workflow')
  if (stray !== undefined) return { ok: false, error: `--workspace with --workflow does not take --${stray}` }
  if (request.body.trim() !== '') return { ok: false, error: '--workflow takes no prompt' }
  const added = await caller.api.workspace[':id'].steps.$post({
    param: { id: request.args.workspace?.trim() ?? '' },
    json: { workflow: request.args.workflow ?? '' },
  })
  return { ok: true, output: added.map((s) => s.name).join('\n') }
}

/**
 * Rerun a non-interactive workspace of the project, detached: a new one with
 * its graph at its start commit, or with `--interactive` an interactive one
 * there. Prints the new workspace's id.
 */
async function runRerun(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const target = request.args.workspace?.trim() ?? ''
  if (target === '') return { ok: false, error: 'rerun needs a workspace id' }
  const workspaceId = crypto.randomUUID()
  drain(await caller.api.workspace.rerun.$post({
    json: { workspaceId: target, rerunId: workspaceId, ...(request.args.interactive !== undefined ? { interactive: true } : {}) },
  }))
  return { ok: true, output: workspaceId }
}

/**
 * Where a workspace of the project, or one of its steps, stands, for
 * `--wait`: a first line of `running` or a settled state (a non-interactive
 * workspace's outcome, else `stopped`; a step's state), and for a settled
 * step its exit code on a second.
 */
async function runStatus(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const target = request.args.workspace?.trim() ?? ''
  if (target === '') return { ok: false, error: 'status needs a workspace id' }
  const steps = await caller.api.workspace[':id'].steps.$get({ param: { id: target } }).catch((err: unknown) => {
    if (err instanceof ServerError && err.code === 'NOT_FOUND') return undefined
    throw err
  })
  if (steps === undefined) return { ok: true, output: 'gone' }
  if ('provisioning' in steps) return { ok: true, output: 'running' }
  const step = request.args.step?.trim()
  if (step === undefined || step === '') {
    if (steps.stepsOutcome !== undefined) return { ok: true, output: steps.stepsOutcome }
    return { ok: true, output: steps.stopped === true ? 'stopped' : 'running' }
  }
  const found = findStep(steps.lives.find((l) => l.life === steps.life)?.steps ?? [], step)
  if (found === undefined) return { ok: false, error: `workspace ${steps.workspaceId.slice(0, 8)} has no step "${step}"` }
  return { ok: true, output: found.exitCode !== undefined ? `${found.state}\n${found.exitCode}` : found.state }
}

/**
 * The step `name` names: by its full name, or by its bare name while only
 * one workflow has a step so named.
 */
function findStep<T extends { name: string; step: string }>(steps: T[], name: string): T | undefined {
  const exact = steps.find((s) => s.name === name)
  if (exact !== undefined || name.includes('.')) return exact
  const matches = steps.filter((s) => s.step === name)
  if (matches.length > 1) {
    throw new ServerError('VALIDATION', `"${name}" is a step of several workflows: ${matches.map((s) => s.name).join(', ')}; `
      + 'give its full name')
  }
  return matches[0]
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
  const { api, projectId } = caller
  const entry = await api.workspace.queue.create.$post({
    json: {
      project: projectId,
      ...startFields(start.start),
      ...(request.body !== '' ? { prompt: request.body } : {}),
      ...(parent !== '' ? { parent } : {}),
      ...queueFields(settings.settings),
    },
  })
  if (entry.startAt !== undefined) {
    const zone = (await api.project[':projectId'].$get({ param: { projectId } })).ownerTimeZone
    return { ok: true, output: `${entry.id}\nnote: starts at about ${when(entry.startAt, { zone, now: new Date() })} ${zone}` }
  }
  // The id alone on the first line, so `a=$(yaac-mama queue …)` can chain
  // the next one after it; the script prints any note after it to stderr.
  const parentId = entry.parentWorkspaceId
  const stopped = parentId !== undefined
    && (await api.workspace['list-stopped'].$get({ query: { project: projectId, workspace: parentId } })).entries.length > 0
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
  const picked = pickOne(await caller.api.workspace.queue.list.$get({ query: { project: caller.projectId } }), target, 'queued workspace')
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
  const patch = {
    ...(request.body !== '' ? { prompt: request.body } : {}),
    ...(parent !== undefined && parent !== '' ? { parent } : {}),
    ...(noParent ? { parent: null } : {}),
    ...startFields(start.start),
    ...queueFields(settings.settings),
    ...(cleared ? { timeout: null } : {}),
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: 'edit-queued needs a new prompt or an option to change' }
  }
  const entry = await caller.api.workspace.queue.update.$post({ json: { id: picked.entry.id, ...patch } })
  return {
    ok: true,
    output: `Updated queued workspace ${entry.id.slice(0, 8)}: ${entry.tool} ${entry.model}, `
      + `${entry.permissionMode} — ${flatten(entry.prompt ?? '(non-interactive)', 60)}`,
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
  const picked = pickOne(await caller.api.workspace.queue.list.$get({ query: { project: caller.projectId } }), target, 'queued workspace')
  if (!picked.ok) return picked
  const { id } = picked.entry
  const short = id.slice(0, 8)
  const { workspaceId } = await caller.api.workspace.queue.run.$post({ json: { id } })
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
  const picked = pickOne(await caller.api.workspace.queue.list.$get({ query: { project: caller.projectId } }), target, 'queued workspace')
  if (!picked.ok) return picked
  await caller.api.workspace.queue.discard.$post({ json: { id: picked.entry.id } })
  return { ok: true, output: `Discarded queued workspace ${picked.entry.id.slice(0, 8)}.` }
}


/** The routine `--routine` names in the caller's project. */
async function pickRoutine(
  caller: MamaCaller,
  request: MamaRequestInput,
): Promise<{ ok: true; entry: RoutineEntry } | { ok: false; error: string }> {
  const target = request.args.routine?.trim() ?? ''
  if (target === '') return { ok: false, error: `${request.command} needs a routine id` }
  return pickOne(await caller.api.routine.list.$get({ query: { project: caller.projectId } }), target, 'routine')
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
  const { name, cron, prompt, nonInteractive } = parsed.fields
  if (name === undefined || cron === undefined || (prompt === undefined && nonInteractive !== true)) {
    return { ok: false, error: 'routine-create needs --name, --cron and a prompt (or --non-interactive)' }
  }
  const routine = await caller.api.routine.create.$post({ json: { project: caller.projectId, ...parsed.fields, name, cron } })
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
  const r = await caller.api.routine.update.$post({ json: { id: picked.entry.id, ...parsed.fields } })
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
  const r = await (paused ? caller.api.routine.pause : caller.api.routine.resume).$post({ json: { id: picked.entry.id } })
  return { ok: true, output: `${paused ? 'Paused' : 'Resumed'} routine ${short} ("${r.name}")${paused ? '' : `; ${nextRuns(r)}`}.` }
}

/** Start a run of a routine now, as the webapp's Run now does, refused
 *  above the caller's permission mode as `run-queued` is. */
async function runRoutineRun(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const picked = await pickRoutine(caller, request)
  if (!picked.ok) return picked
  const short = picked.entry.id.slice(0, 8)
  const { workspaceId } = await caller.api.routine.run.$post({ json: { id: picked.entry.id } })
  return { ok: true, output: `Started routine ${short} ("${picked.entry.name}") as ${workspaceId.slice(0, 8)}.` }
}

/** Delete a routine and its runs that never started. */
async function runRoutineDelete(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const picked = await pickRoutine(caller, request)
  if (!picked.ok) return picked
  await caller.api.routine.delete.$post({ json: { id: picked.entry.id } })
  return {
    ok: true,
    output: `Deleted routine ${picked.entry.id.slice(0, 8)} ("${picked.entry.name}"). `
      + 'Runs already started keep going until they stop.',
  }
}

/**
 * Send a message to a running sibling's agent (`POST /workspace/:id/send`),
 * as if the user typed it: its first open session but the caller's own, or
 * the one `--session` or `--conversation` names. The route heads it with
 * the caller's id and holds it to the caller's ceiling.
 */
async function runSend(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const workspace = request.args.workspace?.trim() ?? ''
  if (workspace === '') return { ok: false, error: 'send needs a workspace id' }
  if (stripControlChars(request.body).trim() === '') return { ok: false, error: 'send needs a message' }
  const agent = request.args.agent?.trim() ?? ''
  const conversation = request.args.conversation?.trim() ?? ''
  try {
    const sent = await caller.api.workspace[':id'].send.$post({
      param: { id: workspace },
      json: { message: request.body, ...(agent !== '' ? { session: agent } : {}), ...(conversation !== '' ? { conversation } : {}) },
    })
    const short = sent.workspaceId.slice(0, 8)
    return {
      ok: true,
      output: `Sent to ${short}'s ${sent.tool} agent ${sent.sessionId.slice(0, 8)}. A busy agent takes it once its current turn allows; `
        + 'read its reply with yaac-mama history.',
    }
  } catch (err) {
    if (!(err instanceof ServerError)) throw err
    // Where the route names no command, name the one that does it.
    const stopped = /^workspace (\S+) is stopped; restart it, then/.exec(err.message)
    if (stopped !== null) return { ok: false, error: err.message.replace('restart it,', `restart it with yaac-mama restart ${stopped[1]},`) }
    if (err.code === 'NOT_FOUND' && /^no (running agent|open conversation) /.test(err.message)) {
      return { ok: false, error: `${err.message} (see: yaac-mama list)` }
    }
    throw err
  }
}

/** Settings shared by `create`, `queue` and `edit-queued`, as the verbs
 *  take them; `timeout` is in minutes. */
interface CreateSettings {
  tool?: AgentTool
  model?: string
  permissionMode?: PermissionMode
  effort?: string
  uiMode?: AgentMode
  branch?: string
  commit?: string
  group?: string
  title?: string
  timeout?: number
  steps?: unknown
  workflow?: string
  nonInteractive?: boolean
  repos?: RepoStart[]
  nested?: boolean
  cwd?: string
}

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
  if ([args.steps, args['no-steps'], args.workflow].filter((a) => a !== undefined).length > 1) {
    return { ok: false, error: 'give one of --steps, --no-steps and --workflow' }
  }
  let steps: unknown
  try {
    steps = args['no-steps'] !== undefined ? null : args.steps !== undefined ? JSON.parse(args.steps) : undefined
  } catch {
    return { ok: false, error: '--steps is not JSON' }
  }
  const title = args.title !== undefined ? normalizeTitle(args.title) : undefined
  if (title === '') return { ok: false, error: 'title must not be empty' }
  const timeout = parseTimeout(args.timeout)
  if (timeout === null) return timeoutRefusal(args.timeout, clear)
  const selection = selectionArgs(args)
  if (!selection.ok) return selection
  return {
    ok: true,
    settings: {
      ...selection.selection,
      ...(tool !== undefined ? { tool: tool as AgentTool } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(permissionMode !== undefined ? { permissionMode: permissionMode as PermissionMode } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(uiMode !== undefined ? { uiMode: uiMode as AgentMode } : {}),
      ...(branch !== undefined ? { branch: branch.trim() } : {}),
      ...(args.commit !== undefined ? { commit: args.commit.trim() } : {}),
      ...(steps !== undefined ? { steps } : {}),
      ...(args.workflow !== undefined ? { workflow: args.workflow } : {}),
      ...(args['non-interactive'] !== undefined ? { nonInteractive: true } : {}),
      ...(group !== undefined ? { group } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    },
  }
}

/**
 * What a new workspace starts with, from the options the script sends:
 * `repos`, a JSON list of `<folder>[@<branch or full commit>]` it builds
 * from each `--repo` (`no-repos` for none), `nested` or `no-nested`, and
 * `cwd` (a repo's folder, or `.`).
 */
function selectionArgs(
  args: Record<string, string>,
): { ok: true; selection: Pick<CreateSettings, 'repos' | 'nested' | 'cwd'> } | { ok: false; error: string } {
  if (args.repos !== undefined && args['no-repos'] !== undefined) return { ok: false, error: 'give --repo or --no-repos, not both' }
  if (args.nested !== undefined && args['no-nested'] !== undefined) return { ok: false, error: 'give --nested or --no-nested, not both' }
  let named: unknown
  try {
    named = args.repos !== undefined ? JSON.parse(args.repos) : undefined
  } catch {
    return { ok: false, error: '--repo is not a JSON list of repos' }
  }
  if (named !== undefined && !(Array.isArray(named) && named.every((r) => typeof r === 'string' && r !== ''))) {
    return { ok: false, error: '--repo is not a JSON list of repos' }
  }
  const repos = args['no-repos'] !== undefined ? [] : (named as string[] | undefined)?.map((entry): RepoStart => {
    const at = entry.indexOf('@')
    const ref = at === -1 ? '' : entry.slice(at + 1)
    return {
      repo: at === -1 ? entry : entry.slice(0, at),
      ...(ref === '' ? {} : FULL_COMMIT_PATTERN.test(ref) ? { commit: ref } : { branch: ref }),
    }
  })
  const cwd = args.cwd?.trim()
  if (cwd === '') return { ok: false, error: 'cwd must not be empty' }
  return {
    ok: true,
    selection: {
      ...(repos !== undefined ? { repos } : {}),
      ...(args.nested !== undefined ? { nested: true } : args['no-nested'] !== undefined ? { nested: false } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    },
  }
}

/**
 * The `GH_TOKEN` value that stands for one of the project's repos, which
 * `yaac-mama as-repo <repo> -- <command>` runs one command with
 * (docs/project-repos.md "GH_TOKEN"): the repo `repo` names by its folder in
 * the project, its id, or its checkout's path in the caller's workspace.
 */
async function runAsRepo(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const ref = request.args.repo?.trim() ?? ''
  if (ref === '') return { ok: false, error: 'as-repo needs a repo' }
  const { token } = await caller.api.workspace[':id']['gh-token'].$get({ param: { id: caller.workspaceId }, query: { repo: ref } })
  return { ok: true, output: token }
}

/** When a queued workspace starts instead of after a parent. */
type QueueStart = { at: string } | { inMinutes: number }

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
function queueFields({ uiMode, ...rest }: CreateSettings): Omit<CreateSettings, 'uiMode'> & { mode?: AgentMode } {
  return { ...rest, ...(uiMode !== undefined ? { mode: uiMode } : {}) }
}

/** A start in the shape a queue write takes. */
function startFields(start: QueueStart | undefined): { startAt?: string; startIn?: number } {
  return start === undefined ? {} : 'at' in start ? { startAt: start.at } : { startIn: start.inMinutes }
}

/** Retitle a workspace, by default the caller itself. */
async function runRename(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const target = targetWorkspace(caller, request.args.workspace)
  const title = request.body.trim()
  if (title === '') return { ok: false, error: 'rename needs a title' }
  const stored = await caller.api.workspace[':id'].title.$post({ param: { id: target }, json: { title } })
  return { ok: true, output: `Renamed ${stored.workspaceId.slice(0, 8)} to "${stored.title ?? title}".` }
}

/** A `--workspace` argument: the workspace it names, or with none the
 *  caller. */
function targetWorkspace(caller: MamaCaller, workspace: string | undefined): string {
  return workspace === undefined || workspace.trim() === '' ? caller.workspaceId : workspace.trim()
}

/**
 * Point the base branch of one of the caller's checkouts at another branch
 * on its origin, as when its work is stacked on another PR's: the checkout
 * `repo` names by its path, which the script sends for the one the caller's
 * cwd is in, or the workspace's only one.
 */
async function runSetBase(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  if (request.body.trim() === '') return { ok: false, error: 'set-base needs a branch' }
  const { baseBranch: branch, repo } = await caller.api.workspace[':id'].base.$post({
    param: { id: caller.workspaceId },
    json: { branch: request.body, ...(request.args.repo !== undefined ? { repo: request.args.repo } : {}) },
  })
  return {
    ok: true,
    output: `${caller.workspaceId.slice(0, 8)}${repo === '' ? '' : `'s ${repo}`} is now based on ${branch}: the webapp diffs it `
      + `against origin/${branch}, and what is queued under it from now on forks from there. `
      + `Your commits have not moved; rebase onto origin/${branch} yourself if they should.`,
  }
}

async function runIconGet(caller: MamaCaller): Promise<MamaOutcome> {
  const res = await caller.api.project[':projectId'].icon.$get({ param: { projectId: caller.projectId } }) as Response
  return { ok: true, body: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? 'application/octet-stream' }
}

/**
 * Replace the project's icon with the image the body carries as base64,
 * since the envelope is JSON. The script sends a file's bytes; the route
 * checks they are an image.
 */
async function runIconSet(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const bytes = Buffer.from(request.body, 'base64')
  if (bytes.length === 0) return { ok: false, error: 'icon-set needs an image' }
  await caller.api.project[':projectId'].icon.$put({ param: { projectId: caller.projectId } }, { init: { body: bytes } })
  return { ok: true, output: 'Set the project\'s icon: the sidebar shows it in place of the project\'s initial.' }
}

async function runIconRemove(caller: MamaCaller): Promise<MamaOutcome> {
  await caller.api.project[':projectId'].icon.$delete({ param: { projectId: caller.projectId } })
  return { ok: true, output: 'Removed the project\'s icon: the sidebar shows the project\'s initial again.' }
}

/**
 * Stop a workspace, by default the caller (an agent winding itself down
 * after its work). The checkout is kept for restart. A self-stop's reply is
 * best-effort, since the teardown removes the transport it travels on.
 *
 * With `--agent` only that agent (session) closes, by default the caller,
 * and its workspace keeps running.
 */
async function runStop(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  if (request.args.agent !== undefined) return await closeOneSession(caller, request.args.agent.trim())
  const target = targetWorkspace(caller, request.args.workspace)
  let stopped: { workspaceId: string; provisioning?: true }
  try {
    stopped = await caller.api.workspace.stop.$post({ json: { workspaceId: target } })
  } catch (err) {
    // Not running: already stopped, or never up.
    if (err instanceof ServerError && err.code === 'NOT_FOUND') {
      const row = await caller.api.workspace[':id'].steps.$get({ param: { id: target } }).catch(() => undefined)
      if (row === undefined) return { ok: false, error: `no workspace '${target}' in ${caller.projectId}` }
      const already = 'stopped' in row && row.stopped === true
      return { ok: false, error: `workspace ${row.workspaceId.slice(0, 8)} is ${already ? 'already stopped' : 'not running'}` }
    }
    throw err
  }
  const short = stopped.workspaceId.slice(0, 8)
  return {
    ok: true,
    output: stopped.provisioning === true
      ? `Stopped ${short} while it was starting.`
      : `Stopped ${short}. Its checkout is kept, with its conversations, so it can be `
        + `restarted: yaac-mama restart ${short}. Files its .gitignore matches are deleted, `
        + 'except the project\'s kept paths.',
  }
}

/** The stopped workspace of the caller's project that `target` names by id
 *  or prefix, if one is. A prefix of several is refused rather than
 *  guessed. */
async function stoppedEntry(caller: MamaCaller, target: string): Promise<StoppedWorkspaceEntry | undefined> {
  const { entries } = await caller.api.workspace['list-stopped'].$get({ query: { project: caller.projectId } })
  const exact = entries.find((e) => e.workspaceId === target)
  if (exact !== undefined) return exact
  const matches = entries.filter((e) => e.workspaceId.startsWith(target))
  if (matches.length > 1) {
    throw new ServerError('VALIDATION', `'${target}' matches more than one workspace in this project — use a longer prefix`)
  }
  return matches[0]
}

/** `stop --agent`: close one session of the caller's project. */
async function closeOneSession(caller: MamaCaller, wanted: string): Promise<MamaOutcome> {
  if (wanted === '' && caller.sessionId === undefined) {
    return { ok: false, error: 'stop --agent needs an agent id when not run by an agent yaac started (see: yaac-mama list)' }
  }
  const target = wanted === '' ? caller.sessionId! : wanted
  const { api, projectId } = caller
  const open = async (): Promise<Array<{ workspaceId: string; sessionId: string }>> =>
    (await api.workspace.list.$get({ query: { project: projectId } })).workspaces
      .flatMap((w) => w.sessions.map((s) => ({ workspaceId: w.workspaceId, sessionId: s.sessionId })))
  const sessions = await open()
  const exact = sessions.find((s) => s.sessionId === target)
  const matches = exact !== undefined ? [exact] : sessions.filter((s) => s.sessionId.startsWith(target))
  if (matches.length !== 1) {
    return {
      ok: false,
      error: matches.length === 0 ? `no running agent '${target}' in this project (see: yaac-mama list)`
        : `'${target}' matches more than one agent — use a longer prefix`,
    }
  }
  const [{ workspaceId, sessionId }] = matches
  await api.workspace[':id'].sessions[':sessionId'].close.$post({ param: { id: workspaceId, sessionId } })
  const rest = (await open()).filter((s) => s.workspaceId === workspaceId).length
  const short = workspaceId.slice(0, 8)
  return {
    ok: true,
    output: `Stopped agent ${sessionId.slice(0, 8)}; its conversations stay in ${short}'s history. `
      + (rest === 0
        ? `${short} keeps running with no agent; stop it with yaac-mama stop ${short}.`
        : `${short} keeps running.`),
  }
}

/**
 * Restart a stopped sibling, resuming the conversations it had, as the
 * webapp's Restart does (the route holds a delegate to a stopped one within
 * its ceiling). One that had a timeout keeps its length unless `--timeout`
 * names one, or `none`. It runs on after the reply, which comes before the
 * workspace is up.
 */
async function runRestart(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const workspace = request.args.workspace?.trim() ?? ''
  if (workspace === '') return { ok: false, error: 'restart needs a workspace id' }
  const { cleared } = takeCleared(request.args, 'none')
  const timeout = cleared ? null : parseTimeout(request.args.timeout)
  if (timeout === null && !cleared) return timeoutRefusal(request.args.timeout, 'none')
  const entry = await stoppedEntry(caller, workspace)
  // One not stopped is the route's to refuse, by its full id; one of no
  // workspace of the project is not found.
  const running = entry === undefined
    ? (await caller.api.workspace.list.$get({ query: { project: caller.projectId } })).workspaces
      .find((w) => w.workspaceId === workspace || w.workspaceId.startsWith(workspace))
    : undefined
  if (entry === undefined && running === undefined) return { ok: false, error: `no workspace '${workspace}' in ${caller.projectId}` }
  const minutes = timeout !== undefined ? timeout : entry?.timeoutMinutes
  drain(await caller.api.workspace.restart.$post({
    json: {
      workspaceId: entry?.workspaceId ?? running?.workspaceId ?? workspace,
      ...(minutes != null ? { timeout: minutes } : {}),
      ...(request.args['no-volume'] !== undefined ? { volume: null } : {}),
    },
  }))
  // Its sessions, and each conversation an agent ran by hand in a terminal,
  // which comes back as a session of its own.
  const n = (entry?.sessions.length ?? 0) + (entry?.conversations.filter((c) => c.active && c.sessionId === undefined).length ?? 0)
  const short = (entry?.workspaceId ?? workspace).slice(0, 8)
  return {
    ok: true,
    output: `Restarting ${short}, resuming ${n === 0 ? 'with no agent' : n === 1 ? 'its agent' : `its ${n} agents`}. `
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
  const group = await caller.api.workspace.group.create.$post({ json: { projectId: caller.projectId, name, reuse: true } })
  return { ok: true, output: `Group "${group.name}" is ready (${group.groupId}).` }
}

async function runGroupMove(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const workspace = request.args.workspace
  if (workspace === undefined || workspace.trim() === '') {
    return { ok: false, error: 'group move needs a workspace id' }
  }
  const target = request.body.trim()
  // No group (or `--`) means ungrouped.
  const moved = await caller.api.workspace.group.move.$post({
    json: { projectId: caller.projectId, workspaceId: workspace.trim(), group: target === '--' || target === '' ? null : target, create: true },
  })
  const short = moved.workspaceId.slice(0, 8)
  return { ok: true, output: moved.name === null ? `Moved ${short} out of its group.` : `Moved ${short} into "${moved.name}".` }
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
  const group = await caller.api.workspace.group['set-limit'].$post({
    json: { projectId: caller.projectId, groupId: name, workspaceLimit: limit === 'none' ? null : Number(limit) },
  })
  return {
    ok: true,
    output: limit === 'none'
      ? `Group "${group.name}" has no workspace limit now.`
      : `Group "${group.name}" now runs at most ${limit} ${limit === '1' ? 'workspace' : 'workspaces'} at once.`,
  }
}

/**
 * A git bundle of another workspace's branches and HEAD, running or stopped
 * (`GET /workspace/:id/bundle`), for the caller to fetch into one of its own
 * checkouts: the one `repo` names by its path, which the script sends for
 * the one the caller's cwd is in, or its only one. The bundle is of the
 * other workspace's checkout of that same repo.
 */
async function runFetch(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const workspace = request.args.workspace?.trim() ?? ''
  if (workspace === '') return { ok: false, error: 'fetch needs a workspace id' }
  const { api, projectId } = caller
  const own = (await api.workspace.list.$get({ query: { project: projectId } })).workspaces.find((w) => w.workspaceId === caller.workspaceId)
  const mine = checkoutAt(own?.repos ?? [], request.args.repo)
  const res = await api.workspace[':id'].bundle.$get({ param: { id: workspace }, query: { repo: mine.repoId } }) as Response
  return file(res)
}

/** The checkout of the caller's own a command names by its path or repo
 *  id, or its only one. */
function checkoutAt(checkouts: WorkspaceRepo[], at?: string): WorkspaceRepo {
  if (at !== undefined) {
    const found = checkouts.find((c) => c.path === at) ?? checkouts.find((c) => c.repoId === at)
    if (!found) throw new ServerError('NOT_FOUND', `this workspace has no checkout at "${at}"`)
    return found
  }
  if (checkouts.length === 1) return checkouts[0]
  throw new ServerError('VALIDATION', checkouts.length === 0
    ? 'this workspace has no repos'
    : `this workspace has several repos; name one of: ${checkouts.map((c) => c.path).join(', ')}`)
}

/** A route's file answer as the endpoint sends it on, streamed rather than
 *  held, with the workspace it is about. */
function file(res: Response, conversationId?: string): MamaOutcome {
  const workspaceId = res.headers.get('x-yaac-workspace-id') ?? undefined
  return {
    ok: true,
    body: res.body ?? new ReadableStream(),
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(conversationId !== undefined ? { conversationId } : {}),
  }
}

/** The tool the caller's session runs, else its workspace's first
 *  session's. */
async function callerTool(caller: MamaCaller): Promise<AgentTool | undefined> {
  const own = (await caller.api.workspace.list.$get({ query: { project: caller.projectId } })).workspaces
    .find((w) => w.workspaceId === caller.workspaceId)
  return (own?.sessions.find((s) => s.sessionId === caller.sessionId) ?? own?.sessions[0])?.tool
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
  const wanted = request.args.conversation?.trim() ?? ''
  const history = caller.api.workspace[':id'].history
  let listing
  try {
    listing = await history.$get({ param: { id: workspace }, query: wanted !== '' ? { conversation: wanted } : {} })
  } catch (err) {
    // Where the route names no command, name the one that lists them.
    const missing = err instanceof ServerError ? /^no conversation '.*' in (\S+)$/.exec(err.message) : null
    if (missing !== null) return { ok: false, error: `${(err as Error).message} (see: yaac-mama history ${missing[1]})` }
    throw err
  }
  const { workspaceId, conversations, maxFileBytes } = listing
  // A file over the cap is named on a `# ` line, which the script reports
  // and skips.
  if (request.args.files !== undefined) {
    return {
      ok: true,
      output: conversations.flatMap((c) => c.files.map((f) => f.oversized === true
        ? `# skipped ${c.conversationId}/${f.name}: ${formatSize(f.size)}, past the `
          + `${formatSize(maxFileBytes)} a file is handed out at`
        : `${c.conversationId}/${f.name}`)).join('\n'),
    }
  }
  if (wanted === '') return { ok: true, output: renderHistory(workspaceId, conversations, maxFileBytes) }
  const [{ conversationId, files }] = conversations
  const name = request.args.file
  if (name !== undefined && !files.some((f) => f.name === name)) return { ok: false, error: `${conversationId} has no file '${name}'` }
  const res = await caller.api.workspace[':id'].history[':conversationId'].$get({
    param: { id: workspaceId, conversationId },
    query: name !== undefined ? { file: name } : {},
  }) as Response
  // opencode's history is its database, which the script turns into JSONL.
  return file(res, res.headers.get('content-type') === 'application/vnd.sqlite3' ? conversationId : undefined)
}

function renderHistory(
  workspaceId: string,
  conversations: Array<{
    conversationId: string; tool: string; mode: string; active: boolean; model?: string; lastActiveAt?: string
    firstPrompt?: string; files: Array<{ size: number; oversized?: boolean }>
  }>,
  maxFileBytes: number,
): string {
  const short = workspaceId.slice(0, 8)
  if (conversations.length === 0) return `${short} has no recorded conversations.`
  const rows = conversations.map((c) => [
    c.conversationId,
    c.tool,
    c.mode,
    c.active ? 'yes' : 'no',
    c.model ?? '',
    c.lastActiveAt !== undefined ? c.lastActiveAt.slice(0, 16).replace('T', ' ') : '',
    String(c.files.length),
    formatSize(c.files.reduce((n, f) => n + f.size, 0)),
    flatten(c.firstPrompt ?? '', 50),
  ])
  const header = ['CONVERSATION', 'TOOL', 'MODE', 'ACTIVE', 'MODEL', 'LAST ACTIVE (UTC)', 'FILES', 'SIZE', 'OPENING']
  return [
    `Conversations of ${short}, first held first:`,
    '',
    ...table(header, rows),
    '',
    `Print one's transcripts: yaac-mama history ${short} <conversation>`,
    `Save every file:         yaac-mama history ${short} [<conversation>] -o <dir>`,
    ...(conversations.some((c) => c.files.some((f) => f.oversized === true))
      ? [`Files over ${formatSize(maxFileBytes)} are not handed out; -o names those it skips.`]
      : []),
  ].join('\n')
}

/**
 * Which agent tools the project's owner has signed in to, and each one's
 * models. A workspace cannot tell this itself.
 */
async function runModels(caller: MamaCaller): Promise<MamaOutcome> {
  const { api, projectId } = caller
  const [{ tools }, runs] = await Promise.all([
    api.project[':projectId'].models.$get({ param: { projectId } }),
    callerTool(caller),
  ])
  const lines = [`Agent tools signed in for this project (this workspace runs: ${runs ?? 'unknown'})`, '']
  for (const { tool, auth, models: offered } of tools) {
    if (!auth) {
      lines.push(`${tool.padEnd(9)} not configured — its agent cannot authenticate`)
      continue
    }
    // Each model's effort levels follow it, its default starred.
    const models = offered.map((m) => {
      const efforts = m.efforts !== undefined
        ? ` [effort ${m.efforts.levels.map((l) => (l === m.efforts?.default ? `${l}*` : l)).join(' ')}]`
        : ''
      return `${m.id}${m.name !== undefined ? ` (${m.name})` : ''}${efforts}`
    })
    lines.push(`${tool.padEnd(9)} ${auth.kind}${auth.provider ? ` (${auth.provider})` : ''}`)
    if (models.length > 0) lines.push(`          models: ${models.join(', ')}`)
  }
  lines.push('', 'Pass one with: yaac-mama create --tool <tool> --model <model> [--effort <level>] "<prompt>"')
  return { ok: true, output: lines.join('\n') }
}

/**
 * The project's volumes (docs/workspace-volumes.md), and which workspace
 * holds each, so an app can see whether the one it wants is free.
 */
async function runVolumes(caller: MamaCaller): Promise<MamaOutcome> {
  const volumes = await caller.api.volume.list.$get({ query: { project: caller.projectId } })
  if (volumes.length === 0) return { ok: true, output: 'This project has no volumes.' }
  const lines = volumes.map((v) => {
    const holder = v.holder !== undefined
      ? `attached to ${v.holder.workspaceId.slice(0, 8)}${v.holder.title !== undefined ? ` (${v.holder.title})` : ''}`
      : 'free'
    return `${v.name.padEnd(20)} ${v.size.padEnd(8)} ${holder}`
  })
  return { ok: true, output: lines.join('\n') }
}

/** The project's named workflows (docs/workflows.md), each with its
 *  steps, the repos it runs in, whether it is an init workflow, and the
 *  run secrets it names. */
async function runWorkflowList(caller: MamaCaller): Promise<MamaOutcome> {
  const workflows = await caller.api.workflow.list.$get({ query: { project: caller.projectId } })
  if (workflows.length === 0) return { ok: true, output: 'This project has no workflows.' }
  return { ok: true, output: workflows.map((w) => `${w.name.padEnd(20)} steps ${Object.keys(w.steps).join(',')}`
    + (w.repos.length > 0 ? `  repos ${w.repos.join(',')}` : '')
    + (w.init ? '  init' : '')
    + (w.secrets.length > 0 ? `  run secrets ${w.secrets.join(',')}` : '')).join('\n') }
}

/** One named workflow's steps, its run secrets, and the commits and
 *  branches people ran it on, which a launch of it may use. */
async function runWorkflowShow(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const name = request.args.name?.trim() ?? ''
  if (name === '') return { ok: false, error: 'workflow show needs a workflow name' }
  const w = await caller.api.workflow.show.$get({ query: { project: caller.projectId, name } })
  return { ok: true, output: [
    `workflow ${w.name}${w.init ? ' (init: started by every workspace that has its repos)' : ''}`,
    JSON.stringify(w.steps, null, 2),
    `repos: ${w.repos.join(', ') || 'none (its steps start in the workspace\'s cwd)'}`,
    `run secrets: ${w.secrets.join(', ') || 'none'}`,
    `approved commits: ${w.approvedCommits.join(', ') || 'none'}`,
    `approved branches: ${w.approvedBranches.join(', ') || 'none'}`,
  ].join('\n') }
}

/** A JSON list of strings an option carried, as the script sends one. */
function stringList(raw: string | undefined, flag: string): string[] | undefined {
  if (raw === undefined) return undefined
  let list: unknown
  try {
    list = JSON.parse(raw)
  } catch {
    throw new ServerError('VALIDATION', `${flag} is not a JSON list`)
  }
  if (!Array.isArray(list) || !list.every((v) => typeof v === 'string')) throw new ServerError('VALIDATION', `${flag} is not a list of names`)
  return list
}

/**
 * Make or change a named workflow (docs/workflows.md): `--file`'s steps,
 * the run secrets it names, the repos its steps are written for, and
 * whether it is an init workflow. Its launches that would get secrets run
 * only once a person approves this content, so they wait for one.
 */
async function runWorkflowWrite(caller: MamaCaller, request: MamaRequestInput, verb: 'create' | 'edit'): Promise<MamaOutcome> {
  const { args } = request
  const name = args.name?.trim() ?? ''
  if (name === '') return { ok: false, error: `workflow ${verb} needs a workflow name` }
  if (request.body.trim() !== '') return { ok: false, error: `workflow ${verb} takes no prompt` }
  for (const [on, off] of [['secrets', 'no-secrets'], ['repos', 'no-repos'], ['init', 'no-init']] as const) {
    if (args[on] !== undefined && args[off] !== undefined) return { ok: false, error: `give --${on.replace(/s$/, '')} or --${off}, not both` }
  }
  let steps: unknown
  if (args.steps !== undefined) {
    try {
      steps = JSON.parse(args.steps)
    } catch {
      return { ok: false, error: '--file is not JSON: give a JSON object of steps' }
    }
  }
  const secrets = args['no-secrets'] !== undefined ? [] : stringList(args.secrets, '--secret')
  const repos = args['no-repos'] !== undefined ? [] : stringList(args.repos, '--repo')
  const init = args.init !== undefined ? true : args['no-init'] !== undefined ? false : undefined
  const input = {
    ...(secrets !== undefined ? { secrets } : {}),
    ...(repos !== undefined ? { repos } : {}),
    ...(init !== undefined ? { init } : {}),
  }
  let w
  if (verb === 'create') {
    if (steps === undefined) return { ok: false, error: 'workflow create needs --file, a JSON object of its steps' }
    w = await caller.api.workflow.create.$post({ json: { project: caller.projectId, name, steps, ...input } })
  } else {
    w = await caller.api.workflow.edit.$post({ json: { project: caller.projectId, name, ...(steps !== undefined ? { steps } : {}), ...input } })
  }
  return { ok: true, output: [
    `workflow ${w.name}: steps ${Object.keys(w.steps).join(',') || 'none'}`
      + (w.repos.length > 0 ? `; repos ${w.repos.join(',')}` : '') + (w.init ? '; init' : ''),
    ...(w.secrets.length > 0
      ? [`run secrets ${w.secrets.join(',')}: a launch that gets them waits until a person approves it (docs/workflows.md "Approvals")`]
      : []),
  ].join('\n') }
}

/** Delete a named workflow nothing runs. */
async function runWorkflowDelete(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const name = request.args.name?.trim() ?? ''
  if (name === '') return { ok: false, error: 'workflow delete needs a workflow name' }
  await caller.api.workflow.delete.$post({ json: { project: caller.projectId, name } })
  return { ok: true, output: `deleted workflow ${name}` }
}

/** At most this much of a log's end is printed. */
const LOG_END_BYTES = 4 * 1024 * 1024

/**
 * The steps of a workspace's current life, or the end of one step's log (the
 * newest life's that has it) with terminal escapes and control characters
 * stripped, for an agent following a CI run or a site's release
 * (docs/workspace-steps.md "Logs"). A step's log is served only once the
 * step has started in the life its row names: the server clears and
 * recreates the file then, and before it any window opened under the step's
 * name, a shell included, would be writing it. A step waiting to rerun or a
 * service waiting out its restart backoff has started, so its last run's log
 * still reads. A stopped workspace's unsettled steps show as `stopped`,
 * since their rows keep the states its last life left.
 */
async function runLogs(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const target = request.args.workspace?.trim() ?? ''
  if (target === '') return { ok: false, error: 'logs needs a workspace id' }
  const { tail } = request.args
  if (tail !== undefined && !/^[1-9]\d{0,8}$/.test(tail)) return { ok: false, error: '--tail must be a whole number of lines' }
  const { api } = caller
  const info = await api.workspace[':id'].steps.$get({ param: { id: target } })
  const short = info.workspaceId.slice(0, 8)
  const name = request.args.step?.trim() ?? ''
  if (name === '') {
    if (tail !== undefined) return { ok: false, error: '--tail goes with a step' }
    const steps = 'life' in info ? info.lives.find((l) => l.life === info.life)?.steps ?? [] : []
    if (steps.length === 0) return { ok: true, output: `${short} has no steps.` }
    const stopped = 'stopped' in info && info.stopped === true
    return {
      ok: true,
      output: [
        `Steps of ${short}${stopped ? ' (stopped)' : ''}, in order:`,
        '',
        ...table(['STEP', 'STATE', 'EXIT', 'NEEDS', 'LOG'], steps.map((s) => {
          const state = stopped && !stepSettled(s.state) ? 'stopped' : s.state
          return [
            s.name,
            s.service === true ? `${state} (service)` : state,
            s.exitCode !== undefined ? String(s.exitCode) : '',
            s.needs.join(','),
            formatSize(s.logs.reduce((n, l) => n + l.size, 0)),
          ]
        })),
        '',
        `Print the end of one's log: yaac-mama logs ${short} <step> [--tail <lines>]`,
      ].join('\n'),
    }
  }
  // The latest life's step of that name that has one, else an earlier
  // life's.
  const found = info.lives.map((l) => ({ life: l.life, step: findStep(l.steps, name) })).find((l) => l.step !== undefined)
  if (found?.step === undefined) return { ok: false, error: `workspace ${short} has no step "${name}" (see: yaac-mama logs ${short})` }
  const { life, step } = found
  // A step that failed without starting could not open its window, and its
  // log says why.
  if (!step.started && step.state !== 'failed') {
    return { ok: false, error: `step "${name}" of ${short} has not run yet (it is ${step.state})` }
  }
  const lines = tail !== undefined ? Number(tail) : undefined
  const total = step.logs.reduce((n, l) => n + l.size, 0)
  if (total === 0) return { ok: false, error: `step "${name}" of ${short} has logged nothing` }
  // Its end, across the rotated-out half and the current one.
  let skip = Math.max(0, total - LOG_END_BYTES)
  const skipped = skip
  const parts: Buffer[] = []
  for (const l of step.logs) {
    if (skip >= l.size) {
      skip -= l.size
      continue
    }
    const res = await api.workspace[':id'].logs[':life'][':file'].$get({
      param: { id: info.workspaceId, life, file: l.file },
      query: { offset: String(skip) },
    }) as Response
    parts.push(Buffer.from(await res.arrayBuffer()))
    skip = 0
  }
  const data = Buffer.concat(parts)
  // A cut start falls mid-line, so the rest of that line goes too.
  const from = skipped > 0 ? data.indexOf(0x0a) + 1 : 0
  let kept = stripControlChars(stripAnsi(data.subarray(from).toString('utf8'))).split('\n')
  if (kept.at(-1) === '') kept.pop()
  if (lines !== undefined) kept = kept.slice(-lines)
  const cut = skipped > 0 && (lines === undefined || kept.length < lines)
    ? [`(the first ${formatSize(skipped + from)} of this log are cut: only its last ${formatSize(LOG_END_BYTES)} is served)`]
    : []
  return { ok: true, body: Buffer.from([...cut, ...kept, ''].join('\n')), contentType: 'text/plain; charset=utf-8', workspaceId: info.workspaceId }
}
