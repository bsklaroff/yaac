import { getRpcClient } from '#commands/rpc'
import type {
  DeletedSessionEntry,
  GitAuthFailure,
  SessionListEntry,
} from '@yaac/shared/types'

export interface SessionListOptions {
  deleted?: boolean
  num?: number
  all?: boolean
}

export const DELETED_DEFAULT_LIMIT = 25

export async function sessionList(projectSlug?: string, options: SessionListOptions = {}): Promise<void> {
  const client = await getRpcClient()

  if (options.deleted) {
    const limit = resolveDeletedLimit(options)
    const query: { project?: string; limit?: string } = {}
    if (projectSlug) query.project = projectSlug
    if (limit !== undefined) query.limit = String(limit)
    const deleted = await client.session['list-deleted'].$get({ query }).then((r) => r.json())
    renderDeleted(deleted, projectSlug, limit)
    return
  }

  const result = await client.session.list.$get({
    query: projectSlug ? { project: projectSlug } : {},
  }).then((r) => r.json())

  if (result.sessions.length === 0) {
    const suffix = projectSlug ? ` for project "${projectSlug}"` : ''
    console.log(`No active sessions${suffix}. Create one with: yaac session create <project>`)
  } else {
    renderRunning(result.sessions)
    renderBlockedHosts(result.sessions)
  }
  // Project-wide, so rendered even with zero sessions — a rejected
  // credential also blocks creating new ones.
  renderGitAuthFailures(result.gitAuthFailures)
}

function renderRunning(sessions: SessionListEntry[]): void {
  const statusOrder: Record<string, number> = { waiting: 0, running: 1 }
  const sorted = [...sessions].sort((a, b) =>
    (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9)
      || a.createdAt.localeCompare(b.createdAt),
  )

  const rows = sorted.map((s) => ({
    shortId: (s.sessionId || '?').slice(0, 8),
    project: s.projectSlug || '?',
    tool: s.tool,
    status: s.status,
    created: s.createdAt,
    prompt: s.prompt,
  }))

  const projectWidth = Math.max('PROJECT'.length, ...rows.map((r) => r.project.length))
  const toolWidth = Math.max('TOOL'.length, ...rows.map((r) => r.tool.length))
  const statusWidth = Math.max('STATUS'.length, ...rows.map((r) => r.status.length))

  const fixedWidth = 10 + 1 + projectWidth + 1 + toolWidth + 1 + statusWidth + 1 + 19 + 2
  const termWidth = process.stdout.columns || 120
  const promptWidth = Math.max(10, termWidth - fixedWidth)

  console.log('')
  console.log(`${'SESSION'.padEnd(10)} ${'PROJECT'.padEnd(projectWidth)} ${'TOOL'.padEnd(toolWidth)} ${'STATUS'.padEnd(statusWidth)} ${'CREATED'.padEnd(19)}  PROMPT`)
  console.log(`${'-'.repeat(10)} ${'-'.repeat(projectWidth)} ${'-'.repeat(toolWidth)} ${'-'.repeat(statusWidth)} ${'-'.repeat(19)}  ${'-'.repeat(Math.min(promptWidth, 40))}`)
  for (const row of rows) {
    const promptText = truncatePrompt(row.prompt, promptWidth)
    console.log(`${row.shortId.padEnd(10)} ${row.project.padEnd(projectWidth)} ${row.tool.padEnd(toolWidth)} ${row.status.padEnd(statusWidth)} ${row.created}  ${promptText}`)
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
  console.log('Run "yaac auth update" to refresh it; the fix reaches running sessions immediately.')
  console.log('')
}

function renderBlockedHosts(sessions: SessionListEntry[]): void {
  const withBlocked = sessions.filter((s) => s.blockedHosts.length > 0)
  if (withBlocked.length === 0) return
  console.log('Blocked hosts:')
  for (const s of withBlocked) {
    console.log(`  ${s.sessionId.slice(0, 8)}`)
    for (const host of s.blockedHosts) {
      console.log(`    ${host}`)
    }
  }
  console.log('')
}

/**
 * Compute the deleted-list limit from CLI options. `--all` wins and returns
 * `undefined` (no cap); an explicit `-n` wins over the default of 25.
 */
export function resolveDeletedLimit(options: SessionListOptions): number | undefined {
  if (options.all) return undefined
  if (typeof options.num === 'number' && Number.isFinite(options.num) && options.num > 0) {
    return Math.floor(options.num)
  }
  return DELETED_DEFAULT_LIMIT
}

function renderDeleted(
  deleted: DeletedSessionEntry[],
  projectSlug: string | undefined,
  limit: number | undefined,
): void {
  if (deleted.length === 0) {
    const suffix = projectSlug ? ` for project "${projectSlug}"` : ''
    console.log(`No deleted sessions${suffix}.`)
    return
  }

  const projectWidth = Math.max('PROJECT'.length, ...deleted.map((s) => s.projectSlug.length))
  const toolWidth = Math.max('TOOL'.length, ...deleted.map((s) => s.tool.length))
  // The DIED column (reaper-recorded death reason) appears only when at
  // least one row carries one, so all-user-delete listings stay unchanged.
  const hasDeaths = deleted.some((s) => s.deathReason)
  const diedWidth = hasDeaths
    ? Math.max('DIED'.length, ...deleted.map((s) => (s.deathReason ?? '').length))
    : 0

  const fixedWidth = 10 + 1 + projectWidth + 1 + toolWidth + 1 + 19 + (hasDeaths ? diedWidth + 1 : 0) + 2
  const termWidth = process.stdout.columns || 120
  const promptWidth = Math.max(10, termWidth - fixedWidth)

  const diedHeader = hasDeaths ? ` ${'DIED'.padEnd(diedWidth)}` : ''
  const diedRule = hasDeaths ? ` ${'-'.repeat(diedWidth)}` : ''
  console.log('')
  console.log(`${'SESSION'.padEnd(10)} ${'PROJECT'.padEnd(projectWidth)} ${'TOOL'.padEnd(toolWidth)} ${'DELETED'.padEnd(19)}${diedHeader}  PROMPT`)
  console.log(`${'-'.repeat(10)} ${'-'.repeat(projectWidth)} ${'-'.repeat(toolWidth)} ${'-'.repeat(19)}${diedRule}  ${'-'.repeat(Math.min(promptWidth, 40))}`)

  for (const s of deleted) {
    const promptText = truncatePrompt(s.prompt, promptWidth)
    // The row's sort key: recorded deletion time, else last activity, else birth.
    const when = s.deletedAt ?? s.lastActiveAt ?? s.createdAt
    const diedCell = hasDeaths ? ` ${(s.deathReason ?? '').padEnd(diedWidth)}` : ''
    console.log(`${s.sessionId.slice(0, 8).padEnd(10)} ${s.projectSlug.padEnd(projectWidth)} ${s.tool.padEnd(toolWidth)} ${when}${diedCell}  ${promptText}`)
  }
  if (limit !== undefined && deleted.length >= limit) {
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
