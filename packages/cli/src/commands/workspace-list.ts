import { api, projectNames } from '#commands/api'
import type {
  GitAuthFailure,
  StoppedWorkspaceEntry,
  StoppedWorkspacePage,
  WorkspaceListEntry,
} from '@yaac/shared/types'

export interface WorkspaceListOptions {
  stopped?: boolean
  num?: number
  all?: boolean
}

export const STOPPED_DEFAULT_LIMIT = 25

/** `project` is a name, id or id prefix, resolved by the server. */
export async function workspaceList(
  project?: string,
  options: WorkspaceListOptions = {},
): Promise<void> {
  if (options.stopped) {
    const limit = resolveStoppedLimit(options)
    const query: { project?: string; limit?: string } = {}
    if (project) query.project = project
    if (limit !== undefined) query.limit = String(limit)
    const [page, names] = await Promise.all([api.workspace['list-stopped'].$get({ query }), projectNames()])
    renderStopped(page, project, names)
    return
  }

  const query = project ? { project } : {}
  const [result, { groups }, names] = await Promise.all([
    api.workspace.list.$get({ query }),
    api.workspace.group.list.$get({ query }),
    projectNames(),
  ])

  if (result.workspaces.length === 0) {
    const suffix = project ? ` for project "${project}"` : ''
    console.log(`No running workspaces${suffix}. Create one with: yaac workspace create <project>`)
  } else {
    renderRunning(result.workspaces, new Map(groups.map((g) => [g.groupId, g.name])), names)
    renderBlockedHosts(result.workspaces)
  }
  // Shown even with no workspaces: a rejected credential also blocks creates.
  renderGitAuthFailures(result.gitAuthFailures, names)
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

  const rows = sorted.map((w) => ({
    shortId: (w.workspaceId || '?').slice(0, 8),
    project: projectNames.get(w.projectId) ?? w.projectId,
    tool: w.tool,
    status: w.status,
    agents: String(w.agentSessions.filter((a) => a.active).length || 1),
    group: w.groupId !== undefined ? groupNames.get(w.groupId) ?? '' : '',
    title: w.title ?? '',
    created: w.createdAt,
    prompt: w.prompt,
  }))

  const projectWidth = Math.max('PROJECT'.length, ...rows.map((r) => r.project.length))
  const toolWidth = Math.max('TOOL'.length, ...rows.map((r) => r.tool.length))
  const statusWidth = Math.max('STATUS'.length, ...rows.map((r) => r.status.length))
  const agentsWidth = Math.max('AGENTS'.length, ...rows.map((r) => r.agents.length))
  // The GROUP and TITLE columns appear only when some row has a value.
  const hasGroups = rows.some((r) => r.group !== '')
  const groupWidth = hasGroups ? Math.max('GROUP'.length, ...rows.map((r) => r.group.length)) : 0
  const hasTitles = rows.some((r) => r.title !== '')
  const titleWidth = hasTitles ? Math.max('TITLE'.length, ...rows.map((r) => r.title.length)) : 0

  const fixedWidth = 10 + 1 + projectWidth + 1 + toolWidth + 1 + statusWidth + 1
    + agentsWidth + 1 + (hasGroups ? groupWidth + 1 : 0)
    + (hasTitles ? titleWidth + 1 : 0) + 19 + 2
  const termWidth = process.stdout.columns || 120
  const promptWidth = Math.max(10, termWidth - fixedWidth)

  const groupHeader = hasGroups ? `${'GROUP'.padEnd(groupWidth)} ` : ''
  const groupRule = hasGroups ? `${'-'.repeat(groupWidth)} ` : ''
  const titleHeader = hasTitles ? `${'TITLE'.padEnd(titleWidth)} ` : ''
  const titleRule = hasTitles ? `${'-'.repeat(titleWidth)} ` : ''
  console.log('')
  console.log(`${'WORKSPACE'.padEnd(10)} ${'PROJECT'.padEnd(projectWidth)} ${'TOOL'.padEnd(toolWidth)} ${'STATUS'.padEnd(statusWidth)} ${'AGENTS'.padEnd(agentsWidth)} ${groupHeader}${titleHeader}${'CREATED'.padEnd(19)}  PROMPT`)
  console.log(`${'-'.repeat(10)} ${'-'.repeat(projectWidth)} ${'-'.repeat(toolWidth)} ${'-'.repeat(statusWidth)} ${'-'.repeat(agentsWidth)} ${groupRule}${titleRule}${'-'.repeat(19)}  ${'-'.repeat(Math.min(promptWidth, 40))}`)
  for (const row of rows) {
    const promptText = truncatePrompt(row.prompt, promptWidth)
    const groupCell = hasGroups ? `${row.group.padEnd(groupWidth)} ` : ''
    const titleCell = hasTitles ? `${row.title.padEnd(titleWidth)} ` : ''
    console.log(`${row.shortId.padEnd(10)} ${row.project.padEnd(projectWidth)} ${row.tool.padEnd(toolWidth)} ${row.status.padEnd(statusWidth)} ${row.agents.padEnd(agentsWidth)} ${groupCell}${titleCell}${row.created}  ${promptText}`)
  }
  console.log('')
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

  const nameOf = (s: StoppedWorkspaceEntry): string => projectNames.get(s.projectId) ?? s.projectId
  const projectWidth = Math.max('PROJECT'.length, ...stopped.map((s) => nameOf(s).length))
  const toolWidth = Math.max('TOOL'.length, ...stopped.map((s) => s.tool.length))
  // DIED (the reaper's recorded reason) and TITLE appear only when some row
  // has a value.
  const hasDeaths = stopped.some((s) => s.deathReason)
  const diedWidth = hasDeaths
    ? Math.max('DIED'.length, ...stopped.map((s) => (s.deathReason ?? '').length))
    : 0
  const hasTitles = stopped.some((s) => s.title)
  const titleWidth = hasTitles
    ? Math.max('TITLE'.length, ...stopped.map((s) => (s.title ?? '').length))
    : 0

  const fixedWidth = 10 + 1 + projectWidth + 1 + toolWidth + 1 + 19
    + (hasDeaths ? diedWidth + 1 : 0) + (hasTitles ? titleWidth + 1 : 0) + 2
  const termWidth = process.stdout.columns || 120
  const promptWidth = Math.max(10, termWidth - fixedWidth)

  const diedHeader = hasDeaths ? ` ${'DIED'.padEnd(diedWidth)}` : ''
  const diedRule = hasDeaths ? ` ${'-'.repeat(diedWidth)}` : ''
  const titleHeader = hasTitles ? ` ${'TITLE'.padEnd(titleWidth)}` : ''
  const titleRule = hasTitles ? ` ${'-'.repeat(titleWidth)}` : ''
  console.log('')
  console.log(`${'WORKSPACE'.padEnd(10)} ${'PROJECT'.padEnd(projectWidth)} ${'TOOL'.padEnd(toolWidth)} ${'STOPPED'.padEnd(19)}${diedHeader}${titleHeader}  PROMPT`)
  console.log(`${'-'.repeat(10)} ${'-'.repeat(projectWidth)} ${'-'.repeat(toolWidth)} ${'-'.repeat(19)}${diedRule}${titleRule}  ${'-'.repeat(Math.min(promptWidth, 40))}`)

  for (const s of stopped) {
    const promptText = truncatePrompt(s.prompt, promptWidth)
    const diedCell = hasDeaths ? ` ${(s.deathReason ?? '').padEnd(diedWidth)}` : ''
    const titleCell = hasTitles ? ` ${(s.title ?? '').padEnd(titleWidth)}` : ''
    console.log(`${s.workspaceId.slice(0, 8).padEnd(10)} ${nameOf(s).padEnd(projectWidth)} ${s.tool.padEnd(toolWidth)} ${s.stoppedAt}${diedCell}${titleCell}  ${promptText}`)
  }
  if (total > stopped.length) {
    console.log(`(showing most recent ${stopped.length} of ${total}; pass --all or -n <num> to see more)`)
  }
  console.log('')
}

export function truncatePrompt(prompt: string | undefined, maxWidth: number): string {
  if (!prompt) return ''
  const flat = prompt.replace(/\s+/g, ' ').trim()
  if (flat.length <= maxWidth) return flat
  return flat.slice(0, maxWidth - 1) + '\u2026'
}
