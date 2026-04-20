import { getClient, exitOnClientError } from '@/lib/daemon-client'
import { cleanupSessionDetached } from '@/lib/session/cleanup'
import type {
  ActiveSessionsResult,
  DeletedSessionEntry,
  FailedPrewarmInfo,
  SessionListEntry,
} from '@/lib/session/list'

export interface SessionListOptions {
  deleted?: boolean
}

export async function sessionList(projectSlug?: string, options: SessionListOptions = {}): Promise<void> {
  const client = await getClient()

  if (options.deleted) {
    await renderDeleted(client, projectSlug)
    return
  }

  let result: ActiveSessionsResult
  try {
    const query = projectSlug ? `?project=${encodeURIComponent(projectSlug)}` : ''
    result = await client.get<ActiveSessionsResult>(`/session/list${query}`)
  } catch (err) {
    exitOnClientError(err)
  }

  if (result.sessions.length === 0) {
    const suffix = projectSlug ? ` for project "${projectSlug}"` : ''
    console.log(`No active sessions${suffix}. Create one with: yaac session create <project>`)
  } else {
    renderRunning(result.sessions)
    renderBlockedHosts(result.sessions)
  }

  renderFailedPrewarms(result.failedPrewarms)

  if (result.stale.length === 0) return

  const ids = result.stale.map((s) => s.sessionId.slice(0, 8)).join(', ')
  console.log(`Cleaning up ${result.stale.length} stale session(s): ${ids}`)
  await Promise.all(result.stale.map(({ containerName, projectSlug: slug, sessionId }) =>
    cleanupSessionDetached({ containerName, projectSlug: slug, sessionId }),
  ))
}

function renderRunning(sessions: SessionListEntry[]): void {
  const statusOrder: Record<string, number> = { waiting: 0, running: 1, prewarm: 2 }
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

function renderFailedPrewarms(failed: FailedPrewarmInfo[]): void {
  if (failed.length === 0) return
  console.log('Failed prewarms (will retry when fingerprint changes or monitor restarts):')
  for (const f of failed) {
    const failedAt = new Date(f.verifiedAt).toISOString().replace('T', ' ').slice(0, 19)
    console.log(`  ${f.slug}  fingerprint=${f.fingerprint}  failed=${failedAt}`)
  }
  console.log('')
}

async function renderDeleted(
  client: Awaited<ReturnType<typeof getClient>>,
  projectSlug: string | undefined,
): Promise<void> {
  let deleted: DeletedSessionEntry[]
  try {
    const query = projectSlug
      ? `?deleted=true&project=${encodeURIComponent(projectSlug)}`
      : '?deleted=true'
    deleted = await client.get<DeletedSessionEntry[]>(`/session/list${query}`)
  } catch (err) {
    exitOnClientError(err)
  }

  if (deleted.length === 0) {
    const suffix = projectSlug ? ` for project "${projectSlug}"` : ''
    console.log(`No deleted sessions${suffix}.`)
    return
  }

  const projectWidth = Math.max('PROJECT'.length, ...deleted.map((s) => s.projectSlug.length))
  const toolWidth = Math.max('TOOL'.length, ...deleted.map((s) => s.tool.length))

  console.log('')
  console.log(`${'SESSION'.padEnd(10)} ${'PROJECT'.padEnd(projectWidth)} ${'TOOL'.padEnd(toolWidth)} CREATED`)
  console.log(`${'-'.repeat(10)} ${'-'.repeat(projectWidth)} ${'-'.repeat(toolWidth)} ${'-'.repeat(20)}`)

  for (const s of deleted) {
    console.log(`${s.sessionId.slice(0, 8).padEnd(10)} ${s.projectSlug.padEnd(projectWidth)} ${s.tool.padEnd(toolWidth)} ${s.createdAt}`)
  }
  console.log('')
}

export function truncatePrompt(prompt: string | undefined, maxWidth: number): string {
  if (!prompt) return ''
  const flat = prompt.replace(/\s+/g, ' ').trim()
  if (flat.length <= maxWidth) return flat
  return flat.slice(0, maxWidth - 1) + '\u2026'
}
