import fs from 'node:fs/promises'
import path from 'node:path'
import { podman } from '@/lib/container/runtime'
import { claudeDir, codexTranscriptDir, getDataDir, getProjectsDir } from '@/lib/project/paths'
import { getSessionStatus, getSessionFirstMessage, getToolFromContainer } from '@/lib/session/status'
import { isTmuxSessionAlive, cleanupSessionDetached } from '@/lib/session/cleanup'
import { readAllBlockedHosts } from '@/lib/session/blocked-hosts'
import { isPrewarmSession, readPrewarmSessions } from '@/lib/prewarm'

export interface SessionListOptions {
  deleted?: boolean
}

export async function sessionList(projectSlug?: string, options: SessionListOptions = {}): Promise<void> {

  if (options.deleted) {
    await listDeletedSessions(projectSlug)
    return
  }

  const filters: Record<string, string[]> = {
    label: [`yaac.data-dir=${getDataDir()}`],
  }
  if (projectSlug) {
    filters.label.push(`yaac.project=${projectSlug}`)
  }

  let containers
  try {
    containers = await podman.listContainers({ all: true, filters })
  } catch {
    console.error('Failed to connect to Podman. Is the Podman machine running?')
    process.exitCode = 1
    return
  }

  // Identify running vs stale containers (zombie or exited)
  const running = []
  const stale: Array<{ name: string; slug: string; sessionId: string; zombie: boolean }> = []
  for (const c of containers) {
    const name = c.Names?.[0]?.replace(/^\//, '') ?? c.Id
    const sessionId = c.Labels?.['yaac.session-id'] ?? ''
    const slug = c.Labels?.['yaac.project'] ?? ''

    if (c.State === 'running') {
      if (isTmuxSessionAlive(name)) {
        running.push(c)
      } else {
        stale.push({ name, slug, sessionId, zombie: true })
      }
      continue
    }

    stale.push({ name, slug, sessionId, zombie: false })
  }

  if (running.length === 0) {
    const suffix = projectSlug ? ` for project "${projectSlug}"` : ''
    console.log(`No active sessions${suffix}. Create one with: yaac session create <project>`)
  } else {
    // Resolve running/waiting status and first user message in parallel
    const sessionMeta = await Promise.all(
      running.map(async (c) => {
        const sessionId = c.Labels?.['yaac.session-id'] ?? ''
        const slug = c.Labels?.['yaac.project'] ?? ''
        const tool = getToolFromContainer(c)
        if (!sessionId || !slug) return { status: 'running' as const, prompt: undefined, tool }
        const [status, prompt, isPrewarm] = await Promise.all([
          getSessionStatus(slug, sessionId, tool),
          getSessionFirstMessage(slug, sessionId, tool),
          isPrewarmSession(slug, sessionId),
        ])
        return { status: isPrewarm ? 'prewarm' as const : status, prompt, tool }
      }),
    )

    // Compute dynamic column widths based on actual data
    const rows = running.map((c, i) => ({
      shortId: (c.Labels?.['yaac.session-id'] ?? '?').slice(0, 8),
      project: c.Labels?.['yaac.project'] ?? '?',
      tool: sessionMeta[i].tool,
      status: sessionMeta[i].status,
      created: new Date(c.Created * 1000).toISOString().replace('T', ' ').slice(0, 19),
      prompt: sessionMeta[i].prompt,
    }))

    const projectWidth = Math.max('PROJECT'.length, ...rows.map((r) => r.project.length))
    const toolWidth = Math.max('TOOL'.length, ...rows.map((r) => r.tool.length))
    const statusWidth = Math.max('STATUS'.length, ...rows.map((r) => r.status.length))

    // Sort: waiting first, then running, then prewarm
    const statusOrder: Record<string, number> = { waiting: 0, running: 1, prewarm: 2 }
    rows.sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9) || a.created.localeCompare(b.created))

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

    // Show blocked hosts section
    const sessionInfos = running.map((c) => ({
      sessionId: c.Labels?.['yaac.session-id'] ?? '',
      projectSlug: c.Labels?.['yaac.project'] ?? '',
    })).filter((s) => s.sessionId && s.projectSlug)

    const blockedHosts = await readAllBlockedHosts(sessionInfos)
    const sessionsWithBlocked = Object.entries(blockedHosts).filter(([, hosts]) => hosts.length > 0)
    if (sessionsWithBlocked.length > 0) {
      console.log('Blocked hosts:')
      for (const [sessionId, hosts] of sessionsWithBlocked) {
        console.log(`  ${sessionId.slice(0, 8)}`)
        for (const host of hosts) {
          console.log(`    ${host}`)
        }
      }
      console.log('')
    }
  }

  // Show failed prewarm sessions
  const prewarmData = await readPrewarmSessions()
  const failedPrewarms = Object.entries(prewarmData)
    .filter(([, entry]) => entry.state === 'failed')
    .filter(([slug]) => !projectSlug || slug === projectSlug)
  if (failedPrewarms.length > 0) {
    console.log('Failed prewarms (will retry when fingerprint changes or monitor restarts):')
    for (const [slug, entry] of failedPrewarms) {
      const failedAt = new Date(entry.verifiedAt).toISOString().replace('T', ' ').slice(0, 19)
      console.log(`  ${slug}  fingerprint=${entry.fingerprint}  failed=${failedAt}`)
    }
    console.log('')
  }

  // Clean up stale containers in detached background processes
  if (stale.length === 0) return

  console.log(`Cleaning up ${stale.length} stale session(s): ${stale.map((s) => s.sessionId.slice(0, 8)).join(', ')}`)
  await Promise.all(stale.map(({ name, slug, sessionId }) =>
    cleanupSessionDetached({ containerName: name, projectSlug: slug, sessionId }),
  ))
}

export function truncatePrompt(prompt: string | undefined, maxWidth: number): string {
  if (!prompt) return ''
  // Collapse whitespace and newlines into single spaces
  const flat = prompt.replace(/\s+/g, ' ').trim()
  if (flat.length <= maxWidth) return flat
  return flat.slice(0, maxWidth - 1) + '\u2026'
}

async function listDeletedSessions(projectSlug?: string): Promise<void> {
  // Get all project slugs
  const slugs: string[] = []
  if (projectSlug) {
    slugs.push(projectSlug)
  } else {
    try {
      const entries = await fs.readdir(getProjectsDir())
      slugs.push(...entries)
    } catch {
      console.log('No projects found.')
      return
    }
  }

  // Get active container session IDs
  const activeSessionIds = new Set<string>()
  try {
    const containers = await podman.listContainers({
      all: true,
      filters: { label: [`yaac.data-dir=${getDataDir()}`] },
    })
    for (const c of containers) {
      const sid = c.Labels?.['yaac.session-id']
      if (sid) activeSessionIds.add(sid)
    }
  } catch {
    // podman not available — treat all as deleted
  }

  // Collect deleted sessions from Claude Code JSONL files and Codex session dirs
  const deleted: Array<{ sessionId: string; project: string; tool: string; created: string }> = []

  for (const slug of slugs) {
    // Scan Claude Code sessions
    const claudeSessionsDir = path.join(claudeDir(slug), 'projects', '-workspace')
    try {
      const files = await fs.readdir(claudeSessionsDir)
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue
        const sessionId = file.replace('.jsonl', '')
        if (activeSessionIds.has(sessionId)) continue
        try {
          const stat = await fs.stat(path.join(claudeSessionsDir, file))
          const created = stat.birthtime.toISOString().replace('T', ' ').slice(0, 19)
          deleted.push({ sessionId, project: slug, tool: 'claude', created })
        } catch {
          continue
        }
      }
    } catch {
      // No Claude sessions dir
    }

    // Scan Codex transcript symlinks (one per session, named {sessionId}.jsonl)
    const codexTranscripts = codexTranscriptDir(slug)
    try {
      const entries = await fs.readdir(codexTranscripts)
      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue
        const sessionId = entry.replace('.jsonl', '')
        if (activeSessionIds.has(sessionId)) continue
        const filePath = path.join(codexTranscripts, entry)
        try {
          const stat = await fs.lstat(filePath)
          const created = stat.birthtime.toISOString().replace('T', ' ').slice(0, 19)
          deleted.push({ sessionId, project: slug, tool: 'codex', created })
        } catch {
          continue
        }
      }
    } catch {
      // No Codex transcript dir
    }
  }

  if (deleted.length === 0) {
    const suffix = projectSlug ? ` for project "${projectSlug}"` : ''
    console.log(`No deleted sessions${suffix}.`)
    return
  }

  // Sort newest first
  deleted.sort((a, b) => b.created.localeCompare(a.created))

  const projectWidth = Math.max('PROJECT'.length, ...deleted.map((s) => s.project.length))
  const toolWidth = Math.max('TOOL'.length, ...deleted.map((s) => s.tool.length))

  console.log('')
  console.log(`${'SESSION'.padEnd(10)} ${'PROJECT'.padEnd(projectWidth)} ${'TOOL'.padEnd(toolWidth)} CREATED`)
  console.log(`${'-'.repeat(10)} ${'-'.repeat(projectWidth)} ${'-'.repeat(toolWidth)} ${'-'.repeat(20)}`)

  for (const s of deleted) {
    console.log(`${s.sessionId.slice(0, 8).padEnd(10)} ${s.project.padEnd(projectWidth)} ${s.tool.padEnd(toolWidth)} ${s.created}`)
  }
  console.log('')
}
