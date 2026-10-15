import { api, projectScope, resolveProjectId } from '#commands/api'
import { printTable } from '#commands/table'
import type { GitAuthFailure, StoppedWorkspacePage, WorkspaceListEntry } from '@yaac/shared/types'

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
  const [result, { groups }] = await Promise.all([
    api.workspace.list.$get({ query: {} }),
    api.workspace.group.list.$get({ query: {} }),
  ])
  const workspaces = result.workspaces.filter((w) => ids.has(w.projectId))

  if (workspaces.length === 0) {
    const suffix = project ? ` for project "${project}"` : ''
    console.log(`No running workspaces${suffix}. Create one with: yaac workspace create <project>`)
  } else {
    renderRunning(workspaces, new Map(groups.map((g) => [g.groupId, g.name])), names)
    renderBlockedHosts(workspaces)
  }
  // Shown even with no workspaces: a rejected credential also blocks creates.
  const failures = Object.fromEntries(Object.entries(result.gitAuthFailures).filter(([id]) => ids.has(id)))
  renderGitAuthFailures(failures, names)
}

function renderRunning(
  workspaces: WorkspaceListEntry[],
  groupNames: Map<string, string>,
  projectNames: Map<string, string>,
): void {
  const statusOrder: Record<string, number> = { waiting: 0, background: 1, running: 2 }
  const sorted = [...workspaces].sort((a, b) =>
    (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9)
      || a.createdAt.localeCompare(b.createdAt),
  )

  printTable(
    [
      { header: 'WORKSPACE' }, { header: 'PROJECT' }, { header: 'TOOL' }, { header: 'STATUS' },
      { header: 'AGENTS' }, { header: 'GROUP', optional: true }, { header: 'TITLE', optional: true },
      { header: 'CREATED' }, { header: 'PROMPT' },
    ],
    sorted.map((w) => [
      (w.workspaceId || '?').slice(0, 8),
      projectNames.get(w.projectId) ?? w.projectId,
      w.tool,
      w.status,
      String(w.agentSessions.filter((a) => a.active).length || 1),
      w.groupId !== undefined ? groupNames.get(w.groupId) ?? '' : '',
      w.title ?? '',
      w.createdAt,
      w.prompt ?? '',
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

  // DIED is the reaper's recorded reason.
  printTable(
    [
      { header: 'WORKSPACE' }, { header: 'PROJECT' }, { header: 'TOOL' }, { header: 'STOPPED' },
      { header: 'DIED', optional: true }, { header: 'TITLE', optional: true }, { header: 'PROMPT' },
    ],
    stopped.map((s) => [
      s.workspaceId.slice(0, 8),
      projectNames.get(s.projectId) ?? s.projectId,
      s.tool,
      s.stoppedAt,
      s.deathReason ?? '',
      s.title ?? '',
      s.prompt ?? '',
    ]),
  )
  if (total > stopped.length) {
    console.log(`(showing most recent ${stopped.length} of ${total}; pass --all or -n <num> to see more)`)
    console.log('')
  }
}
