import fs from 'node:fs/promises'
import path from 'node:path'
import { podman } from '@/lib/podman'
import { claudeDir, getDataDir, getProjectsDir, repoDir, worktreeDir } from '@/lib/paths'
import { removeWorktree } from '@/lib/git'
import { getSessionClaudeStatus } from '@/lib/claude-status'
import { isTmuxSessionAlive, cleanupSession } from '@/lib/session-cleanup'

export interface SessionListOptions {
  deleted?: boolean
}

/** Promise for the most recent background cleanup, exposed for testing. */
export let pendingCleanup: Promise<void> | undefined

export async function sessionList(projectSlug?: string, options: SessionListOptions = {}): Promise<void> {
  pendingCleanup = undefined

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
    // Resolve running/waiting status in parallel
    const statusResults = await Promise.all(
      running.map(async (c) => {
        const sessionId = c.Labels?.['yaac.session-id'] ?? ''
        const slug = c.Labels?.['yaac.project'] ?? ''
        if (!sessionId || !slug) return 'running' as const
        return getSessionClaudeStatus(slug, sessionId)
      }),
    )

    console.log('')
    console.log(`${'SESSION'.padEnd(10)} ${'PROJECT'.padEnd(20)} ${'STATUS'.padEnd(12)} CREATED`)
    console.log(`${'-'.repeat(10)} ${'-'.repeat(20)} ${'-'.repeat(12)} ${'-'.repeat(20)}`)

    for (let i = 0; i < running.length; i++) {
      const c = running[i]
      const sessionId = c.Labels?.['yaac.session-id'] ?? '?'
      const shortId = sessionId.slice(0, 8)
      const project = c.Labels?.['yaac.project'] ?? '?'
      const status = statusResults[i]
      const created = new Date(c.Created * 1000).toISOString().replace('T', ' ').slice(0, 19)
      console.log(`${shortId.padEnd(10)} ${project.padEnd(20)} ${status.padEnd(12)} ${created}`)
    }
    console.log('')
  }

  // Clean up stale containers in the background
  if (stale.length === 0) return

  pendingCleanup = (async () => {
    for (const { name, slug, sessionId, zombie } of stale) {
      if (zombie) {
        await cleanupSession({ containerName: name, projectSlug: slug, sessionId })
      } else {
        try {
          const container = podman.getContainer(name)
          await container.remove()
          if (slug && sessionId) {
            await removeWorktree(repoDir(slug), worktreeDir(slug, sessionId)).catch(() => {})
          }
        } catch {
          // container already gone
        }
      }
    }
  })()
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

  // Collect deleted sessions from Claude Code JSONL files
  const deleted: Array<{ sessionId: string; project: string; created: string }> = []

  for (const slug of slugs) {
    const sessionsDir = path.join(claudeDir(slug), 'projects', '-workspace')
    let files: string[]
    try {
      files = await fs.readdir(sessionsDir)
    } catch {
      continue
    }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const sessionId = file.replace('.jsonl', '')
      if (activeSessionIds.has(sessionId)) continue

      const filePath = path.join(sessionsDir, file)
      try {
        const stat = await fs.stat(filePath)
        const created = stat.birthtime.toISOString().replace('T', ' ').slice(0, 19)
        deleted.push({ sessionId, project: slug, created })
      } catch {
        continue
      }
    }
  }

  if (deleted.length === 0) {
    const suffix = projectSlug ? ` for project "${projectSlug}"` : ''
    console.log(`No deleted sessions${suffix}.`)
    return
  }

  // Sort newest first
  deleted.sort((a, b) => b.created.localeCompare(a.created))

  console.log('')
  console.log(`${'SESSION'.padEnd(10)} ${'PROJECT'.padEnd(20)} CREATED`)
  console.log(`${'-'.repeat(10)} ${'-'.repeat(20)} ${'-'.repeat(20)}`)

  for (const s of deleted) {
    console.log(`${s.sessionId.slice(0, 8).padEnd(10)} ${s.project.padEnd(20)} ${s.created}`)
  }
  console.log('')
}
