import { api, projectScope, resolveProjectId } from '#commands/api'
import { printTable } from '#commands/table'
import { formatDuration, formatInZone } from '@yaac/shared/schedule'
import { isLoopbackOrigin, resolveServerTarget } from '@yaac/shared/server-api'
import { WORKSPACE_HOSTS_PORT, workspaceHostUrl } from '@yaac/shared/workspace-hosts'
import type { GitAuthFailure, QueuedWorkspaceEntry, StoppedWorkspacePage, WorkspaceListEntry } from '@yaac/shared/types'

export interface WorkspaceListOptions {
  stopped?: boolean
  num?: number
  all?: boolean
}

export const STOPPED_DEFAULT_LIMIT = 25

/**
 * One project's workspaces, or those of every project in scope
 * (`projectScope`). `project` is a name, id or id prefix.
 */
export async function workspaceList(
  project?: string,
  options: WorkspaceListOptions = {},
): Promise<void> {
  const scope = await projectScope()
  const projectId = project ? await resolveProjectId(project, scope) : undefined
  const names = new Map(scope.all.map((p) => [p.id, p.name]))
  if (options.stopped) {
    const limit = resolveStoppedLimit(options)
    const query: { project?: string; owner?: string; limit?: string } = projectId ? { project: projectId } : { owner: scope.userId }
    if (limit !== undefined) query.limit = String(limit)
    renderStopped(await api.workspace['list-stopped'].$get({ query }), project, names)
    return
  }

  const ids = new Set(projectId ? [projectId] : scope.projects.map((p) => p.id))
  const [result, { groups }, queued, { timeZone }, target] = await Promise.all([
    api.workspace.list.$get({ query: {} }),
    api.workspace.group.list.$get({ query: {} }),
    api.workspace.queue.list.$get(),
    api.config['time-zone'].$get(),
    resolveServerTarget(),
  ])
  const zone = timeZone ?? 'UTC'
  const workspaces = result.workspaces.filter((w) => ids.has(w.projectId))
  const scheduled = queued.filter((e) => ids.has(e.projectId) && e.startAt !== undefined)

  if (workspaces.length === 0) {
    const suffix = project ? ` for project "${project}"` : ''
    console.log(`No running workspaces${suffix}. Create one with: yaac workspace create <project>`)
  } else {
    renderRunning(workspaces, new Map(groups.map((g) => [g.groupId, g.name])), names, zone)
    renderSessions(workspaces)
    renderPorts(workspaces, target.baseUrl)
    renderBlockedHosts(workspaces)
  }
  if (scheduled.length > 0) renderScheduled(scheduled, names, zone)
  // Shown even with no workspaces: a rejected credential also blocks creates.
  const failures = Object.fromEntries(Object.entries(result.gitAuthFailures).filter(([id]) => ids.has(id)))
  renderGitAuthFailures(failures, names)
}

function renderRunning(
  workspaces: WorkspaceListEntry[],
  groupNames: Map<string, string>,
  projectNames: Map<string, string>,
  zone: string,
): void {
  const statusOrder: Record<string, number> = { waiting: 0, background: 1, running: 2, idle: 3 }
  const sorted = [...workspaces].sort((a, b) =>
    (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9)
      || a.createdAt.localeCompare(b.createdAt),
  )

  printTable(
    [
      { header: 'WORKSPACE' }, { header: 'PROJECT' }, { header: 'TOOL' }, { header: 'STATUS' },
      { header: 'SESSIONS' }, { header: 'GROUP', optional: true }, { header: `STOPS (${zone})`, optional: true },
      { header: 'TITLE', optional: true }, { header: 'CREATED' }, { header: 'PROMPT' },
    ],
    sorted.map((w) => [
      (w.workspaceId || '?').slice(0, 8),
      projectNames.get(w.projectId) ?? w.projectId,
      toolsOf(w.sessions),
      w.status,
      String(w.sessions.length),
      w.groupId !== undefined ? groupNames.get(w.groupId) ?? '' : '',
      w.deadline !== undefined ? formatInZone(new Date(w.deadline), zone) : '',
      w.title ?? '',
      w.createdAt,
      w.prompt ?? '',
    ]),
  )
}

/** A workspace's agents, as the TOOL column shows them. */
function toolsOf(sessions: Array<{ tool: string }>): string {
  return [...new Set(sessions.map((s) => s.tool))].join(',') || '-'
}

/** Each running workspace's open sessions, for `--session` to name. */
function renderSessions(workspaces: WorkspaceListEntry[]): void {
  const rows = workspaces.flatMap((w) => w.sessions.map((s) => [
    w.workspaceId.slice(0, 8),
    s.sessionId.slice(0, 8),
    s.modelName !== undefined ? `${s.tool} · ${s.modelName}` : s.tool,
    s.mode,
    s.exited === true ? 'exited' : s.status ?? 'starting',
    s.title ?? s.prompt ?? '',
  ]))
  if (rows.length === 0) return
  console.log('')
  printTable(
    [{ header: 'WORKSPACE' }, { header: 'SESSION' }, { header: 'AGENT' }, { header: 'MODE' },
      { header: 'STATUS' }, { header: 'TITLE' }],
    rows,
  )
  console.log('')
}

/**
 * Each workspace's ports at their hostnames (docs/workspace-hostnames.md).
 * A server on this machine routes them on its own port; for one elsewhere,
 * `yaac forward` or the desktop app routes them here.
 */
function renderPorts(workspaces: WorkspaceListEntry[], baseUrl: string): void {
  const rows = workspaces.flatMap((w) => w.forwardedPorts.map((p) => ({ id: w.workspaceId, port: p.containerPort })))
  if (rows.length === 0) return
  const url = new URL(baseUrl)
  const local = isLoopbackOrigin(baseUrl)
  const routerPort = local ? Number(url.port || (url.protocol === 'https:' ? 443 : 80)) : WORKSPACE_HOSTS_PORT
  console.log(local
    ? 'Ports:'
    : `Ports (while \`yaac forward\` or the desktop app runs here, at ${String(WORKSPACE_HOSTS_PORT)} `
      + 'or the port `yaac forward` printed):')
  for (const { id, port } of rows) console.log(`  ${id.slice(0, 8)}  ${workspaceHostUrl(id, port, routerPort)}`)
  console.log('')
}

/** Workspaces queued to start at a time, soonest first. */
function renderScheduled(entries: QueuedWorkspaceEntry[], projectNames: Map<string, string>, zone: string): void {
  console.log('Scheduled:')
  printTable(
    [
      { header: 'QUEUED' }, { header: 'PROJECT' }, { header: 'TOOL' }, { header: `STARTS (${zone})` },
      { header: 'TIMEOUT', optional: true }, { header: 'FAILED', optional: true }, { header: 'TITLE' },
    ],
    [...entries].sort((a, b) => (a.startAt ?? '').localeCompare(b.startAt ?? '')).map((e) => [
      e.id.slice(0, 8),
      projectNames.get(e.projectId) ?? e.projectId,
      e.tool,
      formatInZone(new Date(e.startAt ?? ''), zone),
      e.timeoutMinutes !== undefined ? formatDuration(e.timeoutMinutes) : '',
      e.launchError ?? '',
      e.title ?? e.generatedTitle ?? e.prompt.split('\n')[0],
    ]),
  )
}

function renderGitAuthFailures(
  failuresByProject: Record<string, GitAuthFailure[]>,
  projectNames: Map<string, string>,
): void {
  const projectIds = Object.keys(failuresByProject).sort()
  if (projectIds.length === 0) return
  console.log('GIT AUTH FAILED — the project\'s credential was rejected (expired or revoked token?):')
  for (const projectId of projectIds) {
    for (const f of failuresByProject[projectId]) {
      console.log(`  ${projectNames.get(projectId) ?? projectId}  ${f.host} returned HTTP ${f.status}`)
    }
  }
  console.log('Assign the project a new credential in the web app (Settings → Git credentials);')
  console.log('running workspaces pick it up immediately.')
  console.log('')
}

function renderBlockedHosts(workspaces: WorkspaceListEntry[]): void {
  const withBlocked = workspaces.filter((w) => w.blockedHosts.length > 0)
  if (withBlocked.length === 0) return
  console.log('Blocked hosts:')
  for (const s of withBlocked) {
    console.log(`  ${s.workspaceId.slice(0, 8)}`)
    for (const host of s.blockedHosts) {
      console.log(`    ${host}`)
    }
  }
  console.log('')
}

/**
 * Compute the stopped-list limit from CLI options. `--all` wins and returns
 * `undefined` (no cap); an explicit `-n` wins over the default of 25.
 */
export function resolveStoppedLimit(options: WorkspaceListOptions): number | undefined {
  if (options.all) return undefined
  if (typeof options.num === 'number' && Number.isFinite(options.num) && options.num > 0) {
    return Math.floor(options.num)
  }
  return STOPPED_DEFAULT_LIMIT
}

function renderStopped(
  { entries: stopped, total }: StoppedWorkspacePage,
  project: string | undefined,
  projectNames: Map<string, string>,
): void {
  if (stopped.length === 0) {
    const suffix = project ? ` for project "${project}"` : ''
    console.log(`No stopped workspaces${suffix}.`)
    return
  }

  // HOW is the reaper's recorded reason for a death, or a timeout.
  printTable(
    [
      { header: 'WORKSPACE' }, { header: 'PROJECT' }, { header: 'TOOL' }, { header: 'STOPPED' },
      { header: 'HOW', optional: true }, { header: 'TITLE', optional: true }, { header: 'PROMPT' },
    ],
    stopped.map((s) => [
      s.workspaceId.slice(0, 8),
      projectNames.get(s.projectId) ?? s.projectId,
      toolsOf(s.sessions),
      s.stoppedAt,
      s.endedAtNextRun === true ? 'ended at next run' : s.timedOut === true ? 'timed out' : s.deathReason ?? '',
      s.title ?? '',
      s.prompt ?? '',
    ]),
  )
  if (total > stopped.length) {
    console.log(`(showing most recent ${stopped.length} of ${total}; pass --all or -n <num> to see more)`)
    console.log('')
  }
}
