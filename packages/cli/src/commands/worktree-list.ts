import { api } from '#commands/api'
import type {
  GitAuthFailure,
  StoppedWorktreeEntry,
  WorktreeListEntry,
} from '@yaac/shared/types'

export interface WorktreeListOptions {
  stopped?: boolean
  num?: number
  all?: boolean
}

export const STOPPED_DEFAULT_LIMIT = 25

export async function worktreeList(
  projectSlug?: string,
  options: WorktreeListOptions = {},
): Promise<void> {
  if (options.stopped) {
    const limit = resolveStoppedLimit(options)
    const query: { project?: string; limit?: string } = {}
    if (projectSlug) query.project = projectSlug
    if (limit !== undefined) query.limit = String(limit)
    const stopped = await api.worktree['list-stopped'].$get({ query })
    renderStopped(stopped, projectSlug, limit)
    return
  }

  const result = await api.worktree.list.$get({
    query: projectSlug ? { project: projectSlug } : {},
  })

  if (result.worktrees.length === 0) {
    const suffix = projectSlug ? ` for project "${projectSlug}"` : ''
    console.log(`No running worktrees${suffix}. Create one with: yaac worktree create <project>`)
  } else {
    renderRunning(result.worktrees)
    renderBlockedHosts(result.worktrees)
  }
  // Project-wide, so rendered even with zero worktrees — a rejected
  // credential also blocks creating new ones.
  renderGitAuthFailures(result.gitAuthFailures)
}

function renderRunning(worktrees: WorktreeListEntry[]): void {
  const statusOrder: Record<string, number> = { waiting: 0, running: 1 }
  const sorted = [...worktrees].sort((a, b) =>
    (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9)
      || a.createdAt.localeCompare(b.createdAt),
  )

  const rows = sorted.map((w) => ({
    shortId: (w.worktreeId || '?').slice(0, 8),
    project: w.projectSlug || '?',
    tool: w.tool,
    status: w.status,
    // How many conversations are live in this worktree. Shown as a plain
    // count because 1 is the overwhelmingly common answer and a column of
    // 1s should stay quiet.
    agents: String(w.agentSessions.filter((a) => a.active).length || 1),
    created: w.createdAt,
    prompt: w.prompt,
  }))

  const projectWidth = Math.max('PROJECT'.length, ...rows.map((r) => r.project.length))
  const toolWidth = Math.max('TOOL'.length, ...rows.map((r) => r.tool.length))
  const statusWidth = Math.max('STATUS'.length, ...rows.map((r) => r.status.length))
  const agentsWidth = Math.max('AGENTS'.length, ...rows.map((r) => r.agents.length))

  const fixedWidth = 10 + 1 + projectWidth + 1 + toolWidth + 1 + statusWidth + 1
    + agentsWidth + 1 + 19 + 2
  const termWidth = process.stdout.columns || 120
  const promptWidth = Math.max(10, termWidth - fixedWidth)

  console.log('')
  console.log(`${'WORKTREE'.padEnd(10)} ${'PROJECT'.padEnd(projectWidth)} ${'TOOL'.padEnd(toolWidth)} ${'STATUS'.padEnd(statusWidth)} ${'AGENTS'.padEnd(agentsWidth)} ${'CREATED'.padEnd(19)}  PROMPT`)
  console.log(`${'-'.repeat(10)} ${'-'.repeat(projectWidth)} ${'-'.repeat(toolWidth)} ${'-'.repeat(statusWidth)} ${'-'.repeat(agentsWidth)} ${'-'.repeat(19)}  ${'-'.repeat(Math.min(promptWidth, 40))}`)
  for (const row of rows) {
    const promptText = truncatePrompt(row.prompt, promptWidth)
    console.log(`${row.shortId.padEnd(10)} ${row.project.padEnd(projectWidth)} ${row.tool.padEnd(toolWidth)} ${row.status.padEnd(statusWidth)} ${row.agents.padEnd(agentsWidth)} ${row.created}  ${promptText}`)
  }
  console.log('')
}

function renderGitAuthFailures(failuresByProject: Record<string, GitAuthFailure[]>): void {
  const slugs = Object.keys(failuresByProject).sort()
  if (slugs.length === 0) return
  console.log('GIT AUTH FAILED — the stored credential was rejected (expired or revoked token?):')
  for (const slug of slugs) {
    for (const f of failuresByProject[slug]) {
      console.log(`  ${slug}  ${f.host} returned HTTP ${f.status}`)
    }
  }
  console.log('Run "yaac auth update" to refresh it; the fix reaches running worktrees immediately.')
  console.log('')
}

function renderBlockedHosts(worktrees: WorktreeListEntry[]): void {
  const withBlocked = worktrees.filter((w) => w.blockedHosts.length > 0)
  if (withBlocked.length === 0) return
  console.log('Blocked hosts:')
  for (const s of withBlocked) {
    console.log(`  ${s.worktreeId.slice(0, 8)}`)
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
export function resolveStoppedLimit(options: WorktreeListOptions): number | undefined {
  if (options.all) return undefined
  if (typeof options.num === 'number' && Number.isFinite(options.num) && options.num > 0) {
    return Math.floor(options.num)
  }
  return STOPPED_DEFAULT_LIMIT
}

function renderStopped(
  stopped: StoppedWorktreeEntry[],
  projectSlug: string | undefined,
  limit: number | undefined,
): void {
  if (stopped.length === 0) {
    const suffix = projectSlug ? ` for project "${projectSlug}"` : ''
    console.log(`No stopped worktrees${suffix}.`)
    return
  }

  const projectWidth = Math.max('PROJECT'.length, ...stopped.map((s) => s.projectSlug.length))
  const toolWidth = Math.max('TOOL'.length, ...stopped.map((s) => s.tool.length))
  // The DIED column (reaper-recorded death reason) appears only when at
  // least one row carries one, so all-user-stop listings stay unchanged.
  const hasDeaths = stopped.some((s) => s.deathReason)
  const diedWidth = hasDeaths
    ? Math.max('DIED'.length, ...stopped.map((s) => (s.deathReason ?? '').length))
    : 0

  const fixedWidth = 10 + 1 + projectWidth + 1 + toolWidth + 1 + 19 + (hasDeaths ? diedWidth + 1 : 0) + 2
  const termWidth = process.stdout.columns || 120
  const promptWidth = Math.max(10, termWidth - fixedWidth)

  const diedHeader = hasDeaths ? ` ${'DIED'.padEnd(diedWidth)}` : ''
  const diedRule = hasDeaths ? ` ${'-'.repeat(diedWidth)}` : ''
  console.log('')
  console.log(`${'WORKTREE'.padEnd(10)} ${'PROJECT'.padEnd(projectWidth)} ${'TOOL'.padEnd(toolWidth)} ${'STOPPED'.padEnd(19)}${diedHeader}  PROMPT`)
  console.log(`${'-'.repeat(10)} ${'-'.repeat(projectWidth)} ${'-'.repeat(toolWidth)} ${'-'.repeat(19)}${diedRule}  ${'-'.repeat(Math.min(promptWidth, 40))}`)

  for (const s of stopped) {
    const promptText = truncatePrompt(s.prompt, promptWidth)
    // The row's sort key: recorded stop time, else last activity, else birth.
    const when = s.stoppedAt ?? s.lastActiveAt ?? s.createdAt
    const diedCell = hasDeaths ? ` ${(s.deathReason ?? '').padEnd(diedWidth)}` : ''
    console.log(`${s.worktreeId.slice(0, 8).padEnd(10)} ${s.projectSlug.padEnd(projectWidth)} ${s.tool.padEnd(toolWidth)} ${when}${diedCell}  ${promptText}`)
  }
  if (limit !== undefined && stopped.length >= limit) {
    console.log(`(showing most recent ${limit}; pass --all or -n <num> to see more)`)
  }
  console.log('')
}

export function truncatePrompt(prompt: string | undefined, maxWidth: number): string {
  if (!prompt) return ''
  const flat = prompt.replace(/\s+/g, ' ').trim()
  if (flat.length <= maxWidth) return flat
  return flat.slice(0, maxWidth - 1) + '\u2026'
}
